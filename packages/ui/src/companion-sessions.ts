// Action-ticker choreography adapted from capri-desktop (MIT): https://github.com/mochiiwuff/capri-desktop
import { useEffect, useRef, useState } from "react";
import type { ConnectionInfo } from "./client.ts";
import type {
	DesktopCompanionContextRequest,
	DesktopCompanionControls,
	DesktopCompanionRect,
} from "./desktop-companion.ts";
import { uploadBase } from "./uploads.ts";
import { watchReplies } from "./capri3d/replies.ts";

export interface CompanionSessionSnapshot {
	version: 1;
	stale: boolean;
	observedAt: string | null;
	sessions: {
		paneId: string;
		sessionId?: string;
		label: string;
		focused: boolean | null;
		visible: boolean | null;
		activity: {
			phase: "idle" | "typing" | "submitted" | "working" | "waiting" | "unknown";
			geometry?: { version: 1; columns: number; rows: number; rect: DesktopCompanionRect; observedAt: string };
			at?: string;
			typingUntil?: string;
			submittedAt?: string;
   lastAction?: { verb: string; subject: string; at: string };
		};
		pendingQuestion?: { id: string; title: string; createdAt: string; answerable: boolean };
		targets: { composer: CompanionEditorTarget | null; sidebar: DesktopCompanionRect | null };
		canFocus: boolean;
	}[];
}
export interface CompanionEditorTarget extends DesktopCompanionRect {
	kind: "editor" | "cursor";
	verified: true;
	observedAt: string;
}
function freshEditorTarget(value: CompanionEditorTarget | null, now: number) {
	if (!value || value.verified !== true || !["editor", "cursor"].includes(value.kind)) return undefined;
	const age = now - Date.parse(value.observedAt);
	if (
		!Number.isFinite(age) ||
		age < -1000 ||
		age > 2500 ||
		![value.x, value.y, value.width, value.height].every(Number.isFinite) ||
		value.width <= 0 ||
		value.height <= 0
	)
		return undefined;
	return { x: value.x, y: value.y, width: value.width, height: value.height };
}

/** Semantic activity remains useful even without optional verified editor geometry. */
export function companionSessionCue(
	snapshot: CompanionSessionSnapshot,
	now = Date.now(),
	announced: ReadonlySet<string> = new Set(),
): DesktopCompanionContextRequest & { editorGeometry?: CompanionSessionSnapshot["sessions"][number]["activity"]["geometry"] } {
	if (
		snapshot.stale ||
		!snapshot.observedAt ||
		!Number.isFinite(Date.parse(snapshot.observedAt)) ||
		now - Date.parse(snapshot.observedAt) > 12_000 ||
		Date.parse(snapshot.observedAt) > now + 1000
	)
		return { kind: "rest", id: "sessions-stale" };
	const pending = snapshot.sessions
		.filter((s) => s.pendingQuestion && !announced.has(s.pendingQuestion.id))
		.sort((a, b) => Number(a.focused === true) - Number(b.focused === true))[0];
	if (pending?.pendingQuestion)
		return {
			id: `question:${pending.pendingQuestion.id}`,
			kind: "question",
			...(pending.canFocus ? { paneId: pending.paneId } : {}),
			sessionId: pending.sessionId,
			summary: `Hay una pregunta en ${(pending.label || "tu sesión").replace(/^(?:π|pi)\s*[-·:]\s*/i, "")}.`,
			...(pending.targets.sidebar ? { target: pending.targets.sidebar } : {}),
		};
	const session = snapshot.sessions.find((s) => s.focused);
	if (!session) return { kind: "rest", id: "sessions-rest" };
	const base = { sessionId: session.sessionId, paneId: session.paneId,
		...(session.activity.geometry ? { editorGeometry: session.activity.geometry } : {}) };
	const target = session.visible === true ? freshEditorTarget(session.targets.composer, now) : undefined;
	if (session.activity.phase === "typing" && Date.parse(session.activity.typingUntil ?? "") > now)
		return {
			...base,
			id: `typing:${session.sessionId}`,
			kind: "typing",
			...(target ? { target, placement: "aside" } : {}),
		};
	const submitted = Date.parse(session.activity.submittedAt ?? "");
	if (submitted > now - 4500 && submitted <= now)
		return {
			...base,
			id: `submitted:${session.sessionId}:${submitted}`,
			kind: "submitted",
			summary: "Va en camino. Sigo contigo.",
			...(target ? { target, placement: "aside" } : {}),
		};
	if (session.activity.phase === "working")
		return { ...base, id: `working:${session.sessionId}`, kind: "working" };
	if (session.activity.phase === "idle")
		return { ...base, id: `ready:${session.sessionId}`, kind: "input-ready",
			...(target && session.targets.composer?.kind === "editor" ? { target, placement: "perch" as const } : {}) };
	return { kind: "rest", id: "sessions-rest" };
}

export async function focusCompanionSession(
	info: ConnectionInfo,
	identity: { paneId: string; sessionId: string },
) {
	const response = await fetch(`${uploadBase(info.url)}/orchestration/companion/focus`, {
		method: "POST",
		headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
		body: JSON.stringify(identity),
		signal: AbortSignal.timeout(5000),
	});
	if (!response.ok) throw new Error("No se pudo abrir esa sesión. Puede haber terminado.");
}

type WorkingSession = CompanionSessionSnapshot["sessions"][number];
/** Native context cues intentionally omit action metadata. Read the same small cache in the 3D WebView. */
export function useWorkingSession(info: ConnectionInfo | undefined, enabled: boolean) {
 const [session,setSession] = useState<WorkingSession>();
 useEffect(() => {
  setSession(undefined);
  if (!enabled || !info) return;
  let live = true;
  let timer: ReturnType<typeof setTimeout>;
  let abort: AbortController | undefined;
  const update = async () => {
   try {
    abort = new AbortController();
    const response = await fetch(`${uploadBase(info.url)}/orchestration/companion`, {
     headers:{Authorization:`Bearer ${info.token}`},
     signal:AbortSignal.any([abort.signal,AbortSignal.timeout(4000)]),
    });
    if (!response.ok) throw new Error("Unavailable");
    const snapshot = await response.json() as CompanionSessionSnapshot;
    const age = Date.now() - Date.parse(snapshot.observedAt ?? "");
    const current = snapshot.version === 1 && !snapshot.stale && Number.isFinite(age) && age >= -1000 && age <= 12_000 &&
     Array.isArray(snapshot.sessions) && snapshot.sessions.length <= 512
     ? snapshot.sessions.find(s => s.focused === true && s.activity?.phase === "working" && !s.pendingQuestion) : undefined;
    if (live) setSession(current);
   } catch { if (live) setSession(undefined); }
   finally { if (live) timer = setTimeout(update,1000); }
  };
  void update();
  return () => { live = false; abort?.abort(); clearTimeout(timer); };
 },[info,enabled]);
 return enabled ? session : undefined;
}

/** Only the roaming native surface polls this small cached endpoint; no transcripts or screen captures. */
export function useDesktopSessionContext(
	info: ConnectionInfo | undefined,
	controls: DesktopCompanionControls,
	enabled: boolean,
) {
	const publish = controls.context;
	const latest = useRef(publish);
	latest.current = publish;
	useEffect(() => {
		if (!enabled || !info || !publish) return;
		return watchReplies(info, cue => { void latest.current?.(cue).catch(() => {}); });
	}, [enabled, info, publish]);
	useEffect(() => {
		if (!enabled || !info || !publish) return;
		let live = true,
			last = "",
			lastPublished = 0;
		let ownedCueId: string | undefined;
		let timer: ReturnType<typeof setTimeout>;
		let abort: AbortController | undefined;
		const update = async () => {
			try {
				abort = new AbortController();
				const response = await fetch(`${uploadBase(info.url)}/orchestration/companion`, {
					headers: { Authorization: `Bearer ${info.token}` },
					signal: AbortSignal.any([abort.signal, AbortSignal.timeout(4000)]),
				});
				if (!response.ok) throw new Error("Unavailable");
				const snapshot = (await response.json()) as CompanionSessionSnapshot;
				if (snapshot.version !== 1 || !Array.isArray(snapshot.sessions) || snapshot.sessions.length > 512)
					throw new Error("Invalid context");
				const now = Date.now();
				// A fresh pending request remains visible until withdrawn. Snapshot freshness
				// and the native TTL still bound its lifetime if updates stop arriving.
				const cue = companionSessionCue(snapshot, now);
				const signature = JSON.stringify(cue);
				// Refresh the lifetime of ongoing work; native deduplication does not replay its bubble.
				const refreshMs = cue.kind === "input-ready" || cue.kind === "typing" ? 1000 : 4000;
				if (live && (signature !== last || (cue.kind !== "rest" && Date.now() - lastPublished > refreshMs))) {
					if (cue.kind !== "rest") {
						await latest.current?.(cue);
						if (!live) {
							if (cue.id) await latest.current?.({ kind: "rest", id: cue.id });
							return;
						}
						ownedCueId = cue.id;
					} else if (ownedCueId) {
						await latest.current?.({ kind: "rest", id: ownedCueId });
						ownedCueId = undefined;
					}
					last = signature;
					lastPublished = Date.now();
				}
			} catch {
				if (live && last !== "offline") {
					try {
						if (ownedCueId) await latest.current?.({ kind: "rest", id: ownedCueId });
					} catch {
						/* The native surface may be closing. */
					}
					ownedCueId = undefined;
					last = "offline";
				}
			} finally {
				if (live) timer = setTimeout(update, 750);
			}
		};
		void update();
		return () => {
			live = false;
			abort?.abort();
			clearTimeout(timer);
			if (ownedCueId) void latest.current?.({ kind: "rest", id: ownedCueId }).catch(() => {});
		};
	}, [info, enabled, publish]);
}
