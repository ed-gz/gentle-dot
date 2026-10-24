import { type EditorGeometry, parseEditorGeometry } from "./editor-geometry.ts";
import { record } from "./herdr.ts";

export const EDITOR_ACTIVITY_EVENT = "gentle-dot:editor-activity";
export interface CompanionActivity {
	phase: "idle" | "typing" | "submitted" | "working" | "waiting" | "unknown";
	geometry?: EditorGeometry;
	/** Semantic personal input only; extension/workflow prompts never update it. */
	humanActivityAt?: string;
	at?: string;
	typingUntil?: string;
	submittedAt?: string;
	responseStartedAt?: string;
	responseEndedAt?: string;
	source: "pi" | "herdr" | "unavailable";
	capabilities: { typing: boolean; submission: boolean };
}

/** Keeps only semantic timestamps. Neither keystrokes nor draft text enter this object. */
export class CompanionActivityTracker {
	private state: CompanionActivity = this.initial();
	private initial(): CompanionActivity {
		return { phase: "idle", source: "pi", capabilities: { typing: false, submission: true } };
	}
	human(now = Date.now()) {
		this.state.humanActivityAt = new Date(Math.max(now, Date.parse(this.state.humanActivityAt ?? "") + 1 || 0)).toISOString();
	}
	geometry(value: unknown) {
		this.state.geometry = parseEditorGeometry(value);
	}
	reset() {
		this.state = this.initial();
	}
	editor(kind: "ready" | "changed" | "disposed", now = Date.now()) {
		this.state.capabilities.typing = kind !== "disposed";
		if (kind === "disposed") {
			delete this.state.typingUntil;
			return;
		}
		if (kind === "changed") {
			this.human(now);
			this.state.typingUntil = new Date(now + 3500).toISOString();
			this.state.at = new Date(now).toISOString();
		}
	}
	submitted(now = Date.now()) {
		delete this.state.typingUntil;
		this.state.phase = "submitted";
		this.state.at = this.state.submittedAt = new Date(now).toISOString();
	}
	response(running: boolean, now = Date.now()) {
		this.state.phase = running ? "working" : "idle";
		this.state.at = new Date(now).toISOString();
		if (running) this.state.responseStartedAt = this.state.at;
		else this.state.responseEndedAt = this.state.at;
	}
	snapshot(idle: boolean, waiting: boolean, now = Date.now()): CompanionActivity {
		const state = structuredClone(this.state);
		state.geometry = parseEditorGeometry(state.geometry, now);
		const typing = state.typingUntil !== undefined && Date.parse(state.typingUntil) > now;
		if (!typing) delete state.typingUntil;
		state.phase = waiting
			? "waiting"
			: typing
				? "typing"
				: !idle
					? "working"
					: state.phase === "submitted" && state.submittedAt && now - Date.parse(state.submittedAt) < 5000
						? "submitted"
						: "idle";
		return state;
	}
}

export function parseCompanionActivity(value: unknown, now = Date.now()): CompanionActivity | undefined {
	if (
		!record(value) ||
		!record(value.capabilities) ||
		value.source !== "pi" ||
		!["idle", "typing", "submitted", "working", "waiting", "unknown"].includes(String(value.phase))
	)
		return;
	const result: CompanionActivity = {
		phase: value.phase as CompanionActivity["phase"],
		source: "pi",
		capabilities: {
			typing: value.capabilities.typing === true,
			submission: value.capabilities.submission === true,
		},
	};
	result.geometry = parseEditorGeometry(value.geometry, now);
	for (const field of ["at", "humanActivityAt", "submittedAt", "responseStartedAt", "responseEndedAt", "typingUntil"] as const) {
		const time = value[field];
		if (
			typeof time === "string" &&
			time.length < 40 &&
			Number.isFinite(Date.parse(time)) &&
			Date.parse(time) <= now + (field === "typingUntil" ? 4000 : 1000)
		)
			result[field] = time;
	}
	if (result.phase === "typing" && (!result.typingUntil || Date.parse(result.typingUntil) <= now))
		result.phase = "idle";
	return result;
}
