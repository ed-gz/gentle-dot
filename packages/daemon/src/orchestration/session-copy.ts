import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CURRENT_SESSION_VERSION,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { OrchestrationError, record } from "./herdr.ts";
import { sessionProfilePaths } from "./session-info.ts";

/** Preserve resource discovery, never credentials, prompts, shell commands or a session selector. */
export function sessionResourceArgs(argv: readonly string[]): string[] {
	const result: string[] = [];
	const values = new Set([
		"-e",
		"--extension",
		"--skill",
		"--prompt-template",
		"--theme",
		"--use-theme",
		"--tools",
		"-t",
		"--exclude-tools",
		"-xt",
	]);
	const flags = new Set([
		"--no-extensions",
		"-ne",
		"--no-skills",
		"-ns",
		"--no-prompt-templates",
		"-np",
		"--no-mcp",
		"--no-themes",
		"--no-context-files",
		"-nc",
		"--no-builtin-tools",
		"-nbt",
		"--no-tools",
		"-nt",
	]);
	const skipValue = new Set([
		"--api-key",
		"--provider",
		"--model",
		"--models",
		"--thinking",
		"--session",
		"--session-id",
		"--fork",
		"--session-dir",
		"--system-prompt",
		"--append-system-prompt",
		"--export",
		"--mode",
	]);
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (!arg || arg === "--") break;
		if (skipValue.has(arg)) {
			index++;
			continue;
		}
		if (flags.has(arg)) result.push(arg);
		if (!values.has(arg)) continue;
		const value = argv[++index];
		if (value && value.length <= 4096 && !value.includes("\0") && !value.startsWith("-"))
			result.push(arg, value);
	}
	if (result.length > 512)
		throw new OrchestrationError(
			"RESOURCE_LIMIT",
			"Esta sesión tiene demasiados recursos para duplicarla desde el teléfono.",
		);
	return result;
}

/** A fresh native Pi transcript, with no extension state, grants, auth files or environment copy. */
export function copySession(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	directory: string,
	env: NodeJS.ProcessEnv,
) {
	if (!ctx.isIdle() || ctx.hasPendingMessages?.())
		throw new OrchestrationError(
			"SESSION_BUSY",
			"Espera a que termine la respuesta antes de duplicar la sesión.",
		);
	const resources = sessionResourceArgs(process.argv.slice(2));
	const sessionId = randomUUID();
	const copies = join(directory, "copies");
	mkdirSync(copies, { recursive: true, mode: 0o700 });
	const stat = lstatSync(copies);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o077) !== 0 ||
		(process.getuid && stat.uid !== process.getuid())
	)
		throw new OrchestrationError("PRIVATE_FOLDER", "La carpeta de copias de sesión debe ser privada.");
	const timestamp = new Date().toISOString();
	const entries: Record<string, unknown>[] = [
		{ type: "session", version: CURRENT_SESSION_VERSION, id: sessionId, timestamp, cwd: ctx.cwd },
	];
	let parentId: string | null = null;
	// Keep existing message IDs so compaction references remain valid. A new session ID
	// isolates the copy from every workflow/grant keyed to the original logical session.
	for (const entry of ctx.sessionManager.getBranch()) {
		let content: Record<string, unknown> | undefined;
		if (entry.type === "message" && ["user", "assistant", "toolResult"].includes(entry.message.role)) {
			const fields = [
				"role",
				"content",
				"timestamp",
				...(entry.message.role === "assistant"
					? ["api", "provider", "model", "usage", "stopReason", "errorMessage"]
					: entry.message.role === "toolResult"
						? ["toolCallId", "toolName", "isError"]
						: []),
			];
			// Tool details and arbitrary extension properties are state, not chat history.
			content = {
				type: "message",
				message: Object.fromEntries(
					fields
						.filter((field) => Object.hasOwn(entry.message, field))
						.map((field) => [field, Reflect.get(entry.message, field)]),
				),
			};
		} else if (entry.type === "compaction")
			content = {
				type: entry.type,
				summary: entry.summary,
				firstKeptEntryId: entry.firstKeptEntryId,
				tokensBefore: entry.tokensBefore,
			};
		else if (entry.type === "branch_summary")
			content = { type: entry.type, summary: entry.summary, fromId: entry.fromId };
		else if (entry.type === "context_edit")
			content = { type: entry.type, targetId: entry.targetId, replacement: entry.replacement };
		if (!content) continue;
		entries.push({ ...content, id: entry.id, parentId, timestamp: entry.timestamp });
		parentId = entry.id;
	}
	const append = (entry: Record<string, unknown>) => {
		const id = randomUUID().slice(0, 8);
		entries.push({ ...entry, id, parentId, timestamp });
		parentId = id;
	};
	if (ctx.model) append({ type: "model_change", provider: ctx.model.provider, modelId: ctx.model.id });
	const thinking = pi.getThinkingLevel?.() ?? ctx.thinkingLevel;
	if (thinking) append({ type: "thinking_level_change", thinkingLevel: thinking });
	const title = ctx.sessionManager.getSessionName?.();
	append({ type: "session_info", name: `${title || "Conversación"} (copia)`.slice(0, 120) });
	const serialized = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	if (Buffer.byteLength(serialized) > 8 * 1024 * 1024)
		throw new OrchestrationError(
			"HISTORY_TOO_LARGE",
			"La conversación es demasiado grande para duplicarla desde el teléfono.",
		);
	const sessionFile = join(copies, `${sessionId}.jsonl`);
	writeFileSync(sessionFile, serialized, { flag: "wx", mode: 0o600 });
	chmodSync(sessionFile, 0o600);
	return {
		sessionId,
		sessionFile,
		cwd: ctx.cwd,
		profile: sessionProfilePaths(env),
		resources,
	};
}

export function isSessionCopy(value: unknown): value is {
	sessionId: string;
	sessionFile: string;
	cwd: string;
	profile: { agentDir: string; configHome: string };
	resources: string[];
} {
	return (
		record(value) &&
		typeof value.sessionId === "string" &&
		/^[a-f\d-]{36}$/.test(value.sessionId) &&
		typeof value.sessionFile === "string" &&
		typeof value.cwd === "string" &&
		record(value.profile) &&
		typeof value.profile.agentDir === "string" &&
		typeof value.profile.configHome === "string" &&
		Array.isArray(value.resources) &&
		value.resources.every((item) => typeof item === "string") &&
		JSON.stringify(sessionResourceArgs(value.resources)) === JSON.stringify(value.resources)
	);
}
