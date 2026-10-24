import { stripVTControlCharacters } from "node:util";

export type ActivitySource = "live" | "history";
export interface WorkCommand {
	id: string;
	messageId?: string;
	tool: string;
	label: string;
	status: "running" | "completed" | "failed" | "unknown";
	source: ActivitySource;
	startedAt?: string;
	finishedAt?: string;
	output?: string;
	outputTruncated?: boolean;
}
export interface WorkAgent {
	id: string;
	agent: string;
	label?: string;
	status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "timed_out" | "unknown";
	source: ActivitySource;
	updatedAt?: string;
}
export interface WorkPlan {
	source: ActivitySource;
	tasks: Array<{ id: string; title: string; status: "pending" | "in_progress" | "done"; note?: string }>;
	completed: number;
	total: number;
}
export interface SessionWork {
	version: 1;
	capturedAt: string;
	commands: WorkCommand[];
	agents: WorkAgent[];
	plan?: WorkPlan;
	truncated: boolean;
}
export const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(value)
		? value
		: undefined;
const agentStates = new Set([
	"queued",
	"running",
	"waiting",
	"completed",
	"failed",
	"cancelled",
	"timed_out",
]);
const credential =
	/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_|github_pat_|sk-(?:proj-|ant-))[A-Za-z0-9_-]{16,}|(?:authorization|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|cookie)\s*[:=]|\bBearer\s+[A-Za-z0-9_+/.=-]{8,}|https?:\/\/[^\s/@]+:[^\s/@]+@)/i;

/** Display-only projection: no raw argument objects, file contents, prompts or reasoning. */
export function activityText(value: unknown, maximum = 180): string {
	if (typeof value !== "string") return "";
	const bounded = value.slice(0, 8192);
	if (credential.test(bounded)) return "[dato privado omitido]";
	return Array.from(
		stripVTControlCharacters(bounded)
			.replace(/[\p{Cc}\p{Cf}]/gu, " ")
			.replace(/\s+/g, " ")
			.trim(),
	)
		.slice(0, maximum)
		.join("");
}
function time(value: unknown): string | undefined {
	const stamp = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
	return Number.isFinite(stamp) && stamp >= 0 && stamp <= 8_640_000_000_000_000
		? new Date(stamp).toISOString()
		: undefined;
}
function label(tool: string, args: unknown): string {
	if (!object(args)) return tool;
	if (["bash", "shell", "powershell"].includes(tool)) {
		const command = typeof args.command === "string" ? args.command : "";
		// Do not echo inline scripts, environment assignments, authentication flags, or secret paths.
		if (
			/[\r\n]|(?:\b[A-Za-z_][A-Za-z0-9_]*=)|(?:--?(?:password|token|secret|header|cookie|api-key)\b)|(?:\.env\b|\.ssh\b|credentials|auth\.json)|\b(?:curl|wget|env|printenv)\b/i.test(
				command,
			)
		)
			return `${tool} · comando privado`;
		return activityText(command) || tool;
	}
	if (["read", "write", "edit", "ls", "find", "grep"].includes(tool)) {
		const path =
			typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
		return path ? `${tool} · ${activityText(path, 140)}` : tool;
	}
	return tool;
}
function limitedSet<T>(map: Map<string, T>, key: string, value: T, maximum: number): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > maximum) {
		const oldest = map.keys().next().value;
		if (oldest) map.delete(oldest);
	}
}
function planFrom(details: unknown, source: ActivitySource): { plan?: WorkPlan; truncated: boolean } {
	if (!object(details) || details.error) return { truncated: false };
	const ours = object(details.gentleTodo) ? details.gentleTodo : undefined;
	const raw = ours?.tasks ?? details.tasks;
	if (!Array.isArray(raw)) return { truncated: false };
	const tasks: WorkPlan["tasks"] = [];
	for (const item of raw.slice(0, 50)) {
		if (!object(item) || item.status === "deleted") continue;
		const itemId =
			typeof item.id === "number" && Number.isSafeInteger(item.id) ? String(item.id) : id(item.id);
		const title = activityText(item.title ?? item.subject);
		const status =
			item.status === "done" || item.status === "completed"
				? "done"
				: item.status === "in_progress"
					? "in_progress"
					: item.status === "pending"
						? "pending"
						: undefined;
		if (!itemId || !title || !status || tasks.some((task) => task.id === itemId)) continue;
		const note = activityText(item.note ?? item.activeForm, 240);
		tasks.push({ id: itemId, title, status, ...(note ? { note } : {}) });
	}
	return {
		plan: {
			source,
			tasks,
			completed: tasks.filter((task) => task.status === "done").length,
			total: tasks.length,
		},
		truncated: raw.length > 50,
	};
}
function agentFrom(value: unknown, source: ActivitySource, stamp?: unknown): WorkAgent | undefined {
	if (!object(value)) return;
	const taskId = id(value.taskId ?? value.id);
	const agent = activityText(value.agent, 80);
	if (!taskId || !agent) return;
	const updatedAt = time(value.lastActivityAt ?? stamp);
	const taskLabel = activityText(value.label);
	return {
		id: taskId,
		agent,
		...(taskLabel ? { label: taskLabel } : {}),
		status: agentStates.has(String(value.status)) ? (value.status as WorkAgent["status"]) : "unknown",
		source,
		...(updatedAt ? { updatedAt } : {}),
	};
}

/** Replay only the current branch. Unknown/custom payloads never become UI activity. */
export function projectSessionWork(entries: readonly unknown[], now = Date.now()): SessionWork {
	const commands = new Map<string, WorkCommand>();
	const agents = new Map<string, WorkAgent>();
	let plan: WorkPlan | undefined;
	let truncated = entries.length > 2000;
	let commandCount = 0;
	let agentCount = 0;
	for (const entry of entries.slice(-2000)) {
		if (!object(entry)) continue;
		const message = entry.type === "message" && object(entry.message) ? entry.message : undefined;
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content.slice(0, 64)) {
				if (!object(block) || !["toolCall", "tool_call"].includes(String(block.type))) continue;
				const callId = id(block.id);
				const tool = activityText(block.name, 80);
				if (!callId || !tool) continue;
				if (!commands.has(callId)) commandCount++;
				const stamp = time(message.timestamp ?? entry.timestamp);
				limitedSet(
					commands,
					callId,
					{
						id: callId,
						tool,
						label: label(tool, block.arguments),
						status: "unknown",
						source: "history",
						...(stamp ? { startedAt: stamp } : {}),
					},
					20,
				);
			}
		}
		if (message && ["toolResult", "tool"].includes(String(message.role))) {
			const callId = id(message.toolCallId);
			const tool = activityText(message.toolName, 80);
			if (callId && tool) {
				const previous = commands.get(callId);
				if (!previous) commandCount++;
				const stamp = time(message.timestamp ?? entry.timestamp);
				limitedSet(
					commands,
					callId,
					{
						id: callId,
						tool,
						label: previous?.label ?? tool,
						...previous,
						...(id(entry.id) ? { messageId: id(entry.id) } : {}),
						status: message.isError === true ? "failed" : "completed",
						source: "history",
						...(stamp ? { finishedAt: stamp } : {}),
					},
					20,
				);
			}
			if (message.toolName === "todo" && message.isError !== true) {
				const replay = planFrom(message.details, "history");
				if (replay.plan) plan = replay.plan;
				truncated ||= replay.truncated;
			}
		}
		let details: unknown;
		if (
			message &&
			["toolResult", "tool"].includes(String(message.role)) &&
			String(message.toolName).startsWith("subagent_")
		)
			details = object(message.details) ? message.details.gentleAgents : undefined;
		else if (
			entry.type === "custom_message" &&
			["gentle-agents.result", "gentle-agents.message"].includes(String(entry.customType))
		)
			details = object(entry.details) ? entry.details.gentleAgents : undefined;
		else if (entry.type === "custom" && entry.customType === "gentle-agents.stale-result")
			details = entry.data;
		const agent = agentFrom(details, "history", entry.timestamp);
		if (agent) {
			if (!agents.has(agent.id)) agentCount++;
			limitedSet(agents, agent.id, agent, 20);
		}
	}
	return {
		version: 1,
		capturedAt: new Date(now).toISOString(),
		commands: [...commands.values()],
		agents: [...agents.values()],
		...(plan ? { plan } : {}),
		truncated: truncated || commandCount > 20 || agentCount > 20,
	};
}

/** This session's actual execution events override historical guesses, never another session's data. */
export class SessionActivity {
	private readonly commands = new Map<string, WorkCommand>();
	private plan?: WorkPlan;
	private truncated = false;
	reset(): void {
		this.commands.clear();
		this.plan = undefined;
		this.truncated = false;
	}
	start(event: { toolCallId: string; toolName: string; args: unknown }, now = Date.now()): void {
		const callId = id(event.toolCallId);
		const tool = activityText(event.toolName, 80);
		if (!callId || !tool) return;
		this.truncated ||= this.commands.size >= 20 && !this.commands.has(callId);
		limitedSet(
			this.commands,
			callId,
			{
				id: callId,
				tool,
				label: label(tool, event.args),
				status: "running",
				source: "live",
				startedAt: new Date(now).toISOString(),
			},
			20,
		);
	}
	end(
		event: { toolCallId: string; toolName: string; result: unknown; isError: boolean },
		now = Date.now(),
	): void {
		const command = this.commands.get(event.toolCallId);
		if (command) {
			command.status = event.isError ? "failed" : "completed";
			command.finishedAt = new Date(now).toISOString();
		}
		if (event.toolName === "todo" && !event.isError && object(event.result)) {
			const projected = planFrom(event.result.details, "live");
			this.plan = projected.plan ?? this.plan;
			this.truncated ||= projected.truncated;
		}
	}
	settled(): void {
		for (const command of this.commands.values())
			if (command.status === "running") command.status = "unknown";
	}
	snapshot(entries: readonly unknown[], liveAgents: readonly unknown[] = [], now = Date.now()): SessionWork {
		const work = projectSessionWork(entries, now);
		const commands = new Map(work.commands.map((command) => [command.id, command]));
		for (const command of this.commands.values())
			limitedSet(commands, command.id, { ...commands.get(command.id), ...command }, 20);
		const agents = new Map(work.agents.map((agent) => [agent.id, agent]));
		for (const raw of liveAgents.slice(0, 20)) {
			const agent = agentFrom(raw, "live");
			if (agent) limitedSet(agents, agent.id, agent, 20);
		}
		return {
			...work,
			commands: [...commands.values()],
			agents: [...agents.values()],
			...(this.plan ? { plan: this.plan } : {}),
			truncated: work.truncated || this.truncated || liveAgents.length > 20,
		};
	}
}
