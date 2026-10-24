export interface FollowedWork {
	mode?: "objective" | "session";
	id: string;
	objective: string;
	sessions: { paneId: string; sessionId: string; label?: string }[];
	state: "waiting" | "running" | "paused" | "completed" | "expired" | "failed" | "cancelled";
	createdAt: string;
	updatedAt: string;
	expiresAt?: string;
	runs: number;
	maxRuns?: number;
	pending: number;
	lastMessage?: string;
}
export interface FollowedWorkSnapshot {
	workflows: FollowedWork[];
	pending: number;
	error?: string;
}
export interface FollowedWorkAction {
	action: "pause" | "resume" | "stop";
	workflowId: string;
}
const states = new Set(["waiting", "running", "paused", "completed", "expired", "failed", "cancelled"]);
const record = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === "object" && !Array.isArray(v);
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const text = (v: unknown, max = 8000) => typeof v === "string" && v.length > 0 && v.length <= max;
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
export function parseFollowedWork(value: unknown): FollowedWorkSnapshot {
	if (
		!record(value) ||
		!Array.isArray(value.workflows) ||
		value.workflows.length > 100 ||
		!count(value.pending) ||
		(value.error !== undefined && typeof value.error !== "string") ||
		value.workflows.some(
			(w) =>
				!record(w) ||
				(w.mode !== undefined && w.mode !== "objective" && w.mode !== "session") ||
				!text(w.id, 256) ||
				!text(w.objective) ||
				!states.has(String(w.state)) ||
				!date(w.createdAt) ||
				!date(w.updatedAt) ||
				(w.expiresAt !== undefined && !date(w.expiresAt)) ||
				!count(w.runs) ||
				(w.maxRuns !== undefined && (!count(w.maxRuns) || Number(w.maxRuns) < 1)) ||
				!count(w.pending) ||
				(w.lastMessage !== undefined && typeof w.lastMessage !== "string") ||
				!Array.isArray(w.sessions) ||
				w.sessions.length > 32 ||
				w.sessions.some(
					(s) =>
						!record(s) ||
						!text(s.paneId, 512) ||
						!text(s.sessionId, 512) ||
						(s.label !== undefined && typeof s.label !== "string"),
				),
		)
	)
		throw new Error("No se pudo leer el seguimiento de Dot.");
	if (new Set(value.workflows.map((w) => w.id)).size !== value.workflows.length)
		throw new Error("El equipo devolvió seguimientos duplicados.");
	return value as unknown as FollowedWorkSnapshot;
}
