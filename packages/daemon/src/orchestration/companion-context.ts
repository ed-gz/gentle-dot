import type { ComposerTarget } from "./composer-geometry.ts";
import { type CompanionActivity, parseCompanionActivity } from "./companion-activity.ts";
import { record } from "./herdr.ts";
import type { OrchestrationSnapshot, Session } from "./index.ts";

export interface CompanionContextSession {
	paneId: string;
	sessionId?: string;
	provider: Session["provider"];
	label: string;
	focused: boolean | null;
	visible: boolean | null;
	activity: CompanionActivity;
	pendingQuestion?: { id: string; title: string; createdAt: string; answerable: boolean };
	// HERDR protocol 22 publishes terminal-cell layouts, not screen-pixel rectangles.
	targets: { composer: ComposerTarget | null; sidebar: null };
	canFocus: boolean;
}
export interface CompanionContextSnapshot {
	version: 1;
	observedAt: string | null;
	stale: boolean;
	focusScope: "herdr";
	visibilityScope: "herdr-active-tab";
	focusedPaneId: string | null;
	visiblePaneIds: string[];
	sessions: CompanionContextSession[];
	capabilities: { focus: boolean; geometry: boolean };
	limitations: string[];
}

/** Projection of the existing polling loop. Reading it never touches a terminal. */
export class CompanionContext {
	private observedAt: number | undefined;
	private focused: string | null = null;
	private visible: Set<string> | undefined;
	private herdrAvailable = false;
	private snapshot: OrchestrationSnapshot | undefined;
	private activity = new Map<string, CompanionActivity>();
	acceptActivity(paneId: string, sessionId: string, value: unknown) {
		if (
			!this.snapshot?.sessions.some(
				(session) => session.paneId === paneId && session.sessionId === sessionId && session.connected,
			)
		)
			return;
		const parsed = parseCompanionActivity(value);
		if (parsed) this.activity.set(paneId, parsed);
	}
	activityUnavailable(paneId: string, sessionId: string) {
		if (
			this.snapshot?.sessions.some((session) => session.paneId === paneId && session.sessionId === sessionId)
		)
			this.activity.set(paneId, {
				phase: "unknown",
				source: "unavailable",
				capabilities: { typing: false, submission: false },
			});
	}
	update(
		snapshot: OrchestrationSnapshot,
		herdr: Record<string, unknown> | undefined,
		activity: Map<string, unknown>,
		now = Date.now(),
	) {
		this.observedAt = now;
		this.snapshot = snapshot;
		this.herdrAvailable = !!herdr;
		this.focused = typeof herdr?.focused_pane_id === "string" ? herdr.focused_pane_id : null;
		this.visible = undefined;
		if (herdr && typeof herdr.focused_tab_id === "string" && Array.isArray(herdr.layouts)) {
			const layout = herdr.layouts
				.filter(record)
				.find(
					(item) => item.tab_id === herdr.focused_tab_id && item.workspace_id === herdr.focused_workspace_id,
				);
			if (layout && Array.isArray(layout.panes))
				this.visible = new Set(
					layout.panes
						.filter(record)
						.filter((pane) => layout.zoomed !== true || pane.pane_id === layout.focused_pane_id)
						.map((pane) => pane.pane_id)
						.filter((id): id is string => typeof id === "string"),
				);
		}
		this.activity.clear();
		for (const [paneId, raw] of activity) {
			const parsed = parseCompanionActivity(raw, now);
			if (parsed) this.activity.set(paneId, parsed);
		}
	}
	read(now = Date.now()): CompanionContextSnapshot {
		const stale = this.observedAt === undefined || now - this.observedAt > 12000;
		const sessions = (this.snapshot?.sessions ?? []).map((session): CompanionContextSession => {
			const raw = this.activity.get(session.paneId);
			const activity: CompanionActivity = raw
				? structuredClone(raw)
				: {
						phase:
							session.state === "working"
								? "working"
								: session.state === "blocked"
									? "waiting"
									: session.state === "idle" || session.state === "done"
										? "idle"
										: "unknown",
						source: session.provider === "herdr" ? "herdr" : "unavailable",
						capabilities: { typing: false, submission: false },
					};
			if (activity.phase === "typing" && (!activity.typingUntil || Date.parse(activity.typingUntil) <= now)) {
				activity.phase = session.state === "working" ? "working" : "idle";
				delete activity.typingUntil;
			}
			if (
				activity.phase === "submitted" &&
				(!activity.submittedAt || now - Date.parse(activity.submittedAt) >= 5000)
			)
				activity.phase = session.state === "working" ? "working" : "idle";
			if (stale) {
				activity.phase = "unknown";
				delete activity.typingUntil;
			}
			const question = this.snapshot?.approvals.find(
				(item) => item.paneId === session.paneId && item.sessionId === session.sessionId,
			);
			if (question && !stale) activity.phase = "waiting";
			return {
				paneId: session.paneId,
				...(session.sessionId ? { sessionId: session.sessionId } : {}),
				provider: session.provider,
				label: session.label,
				focused:
					!stale && session.provider === "herdr" && this.focused ? session.paneId === this.focused : null,
				visible:
					!stale && session.provider === "herdr" && this.visible ? this.visible.has(session.paneId) : null,
				activity,
				...(question
					? {
							pendingQuestion: {
								id: question.id,
								title: question.title,
								createdAt: question.createdAt,
								answerable: question.answerable,
							},
						}
					: {}),
				targets: { composer: null, sidebar: null },
				canFocus:
					!stale &&
					this.herdrAvailable &&
					session.provider === "herdr" &&
					session.connected &&
					!!session.sessionId,
			};
		});
		return {
			version: 1,
			observedAt: this.observedAt === undefined ? null : new Date(this.observedAt).toISOString(),
			stale,
			focusScope: "herdr",
			visibilityScope: "herdr-active-tab",
			focusedPaneId: stale ? null : this.focused,
			visiblePaneIds: stale ? [] : [...(this.visible ?? [])],
			sessions,
			capabilities: { focus: sessions.some((session) => session.canFocus), geometry: false },
			limitations: [
				"HERDR informa el foco dentro de su sesión; no confirma que su ventana esté al frente.",
				"HERDR no publica coordenadas de pantalla del editor ni de las filas de su barra lateral.",
				...(sessions.some((session) => !session.activity.capabilities.typing)
					? ["Algunas sesiones necesitan el adaptador de actividad del editor para detectar escritura."]
					: []),
			],
		};
	}
}
