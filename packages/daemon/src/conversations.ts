import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Activity, ConversationSummary, HistoryMessage } from "@gentle-dot/protocol";
import { describeTool, textOf } from "./presentation.ts";
import { hasToolCalls, ScreenshotDelivery } from "./screenshot-delivery.ts";
import { readTurnMessages, sessionIndex, sessionRecords } from "./session-index.ts";
import { splitAttachments } from "./uploads.ts";
import { presentText } from "./white-label.ts";

const TITLE_SCAN_BYTES = 256 * 1024;
const TITLE_LENGTH = 60;
const PAGE_ID = /^s(\d+)-(\d+)$/;

/** Session files under `sessionDir` (and one level of subfolders), newest first. */
export function listConversations(sessionDir: string): ConversationSummary[] {
	if (!existsSync(sessionDir)) return [];
	const files: { path: string; mtime: Date }[] = [];
	for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
		const path = join(sessionDir, entry.name);
		if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push({ path, mtime: statSync(path).mtime });
		if (entry.isDirectory()) {
			for (const nested of readdirSync(path, { withFileTypes: true })) {
				if (nested.isFile() && nested.name.endsWith(".jsonl")) {
					const nestedPath = join(path, nested.name);
					files.push({ path: nestedPath, mtime: statSync(nestedPath).mtime });
				}
			}
		}
	}
	return files
		.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
		.map(({ path, mtime }) => ({
			id: conversationIdOf(sessionDir, path),
			title: titleOf(path),
			updatedAt: mtime.toISOString(),
		}));
}

export function conversationIdOf(sessionDir: string, sessionFile: string): string {
	return relative(sessionDir, sessionFile).split(sep).join("/");
}

/**
 * Resolves a client-supplied id to a session file inside `sessionDir`, or
 * undefined. Symlinks are followed before the check, so none can lead outside.
 */
export function resolveConversation(sessionDir: string, id: string): string | undefined {
	if (!id.endsWith(".jsonl") || id.includes("\0")) return undefined;
	const root = resolve(sessionDir);
	const path = resolve(root, id);
	if (!path.startsWith(root + sep) || !existsSync(path)) return undefined;
	const real = realpathSync(path);
	if (!real.startsWith(realpathSync(root) + sep)) return undefined;
	return statSync(real).isFile() ? path : undefined;
}

function titleOf(path: string): string {
	let name: string | undefined;
	let firstUser: string | undefined;
	for (const line of readHead(path).split("\n")) {
		if (!line.trim()) continue;
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (record.type === "session_info") name = typeof record.name === "string" ? record.name : undefined;
		const message = (record.message ?? record) as { role?: unknown };
		if (firstUser === undefined && message.role === "user") {
			const { text, attachments } = splitAttachments(textOf(message));
			firstUser = text || attachments.map((a) => a.name).join(", ");
		}
	}
	const title = (name ?? firstUser ?? "").replace(/\s+/g, " ").trim();
	if (!title) return "New conversation";
	return title.length > TITLE_LENGTH ? `${title.slice(0, TITLE_LENGTH - 1)}…` : title;
}

function readHead(path: string): string {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(TITLE_SCAN_BYTES);
		const bytes = readSync(fd, buffer, 0, TITLE_SCAN_BYTES, 0);
		return buffer.subarray(0, bytes).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** The messages a session file records, in order; context-only entries (summaries, handoffs) are not messages. */
export function readSessionMessages(file: string): unknown[] {
	if (!existsSync(file)) return [];
	const messages: unknown[] = [];
	for (const { entry } of sessionRecords(file))
		if (entry.type === "message" && entry.message) messages.push(entry.message);
	return messages;
}

export interface HistoryPage {
	messages: HistoryMessage[];
	hasEarlier: boolean;
	/** The current Pi leaf was verified during a tree-aware projection. */
	branchVerified?: true;
}

/**
 * One page of the chat kept in `chain` (session files, oldest first; the last
 * one is open), ending just before the message `before`, or at the newest one.
 * Ids are `s<file index>-<turn number>`, which stay valid while the chain grows.
 * An unknown `before` yields an empty page.
 */
export function pageHistory(chain: string[], limit: number, before?: string): HistoryPage {
	let file = chain.length - 1;
	let end = Number.POSITIVE_INFINITY;
	if (before !== undefined) {
		const match = PAGE_ID.exec(before);
		if (!match || Number(match[1]) >= chain.length) return { messages: [], hasEarlier: false };
		file = Number(match[1]);
		end = Number(match[2]) - 1;
	}
	const page: HistoryMessage[] = [];
	for (; file >= 0; file--, end = Number.POSITIVE_INFINITY) {
		const path = chain[file] as string;
		const count = existsSync(path) ? sessionIndex(path).turns.length : 0;
		const stop = Math.min(count, end);
		const start = Math.max(0, stop - (limit - page.length));
		const turns = historyFromMessages(readTurnMessages(path, start, stop));
		const earlier = file < chain.length - 1 ? { earlier: true as const, branchUnverified: true as const } : {};
		page.unshift(...turns.map((turn, i) => ({ ...turn, id: `s${file}-${start + i + 1}`, ...earlier })));
		if (page.length >= limit) {
			const more =
				start > 0 ||
				chain.slice(0, file).some((path) => existsSync(path) && sessionIndex(path).turns.length > 0);
			return { messages: page, hasEarlier: more };
		}
	}
	return { messages: page, hasEarlier: false };
}

type AgentMessage = {
	role?: string;
	content?: unknown;
	toolCallId?: string;
	isError?: boolean;
	stopReason?: string;
};

/** Converts Pi `get_messages` output into display messages; consecutive assistant messages form one turn. */
export function historyFromMessages(messages: unknown[]): HistoryMessage[] {
	const failed = new Set<string>();
	for (const raw of messages) {
		const m = raw as AgentMessage;
		if (m.role === "toolResult" && m.isError && m.toolCallId) failed.add(m.toolCallId);
	}
	const history: HistoryMessage[] = [];
	const screenshots = new ScreenshotDelivery();
	let index = 0;
	for (const raw of messages) {
		const m = raw as AgentMessage;
		if (m.role === "user") {
			screenshots.reset();
			const { text, attachments } = splitAttachments(textOf(m));
			history.push({
				id: `h${++index}`,
				role: "user",
				text,
				activities: [],
				...(attachments.length > 0 ? { attachments } : {}),
			});
			continue;
		}
		if (m.role === "toolResult") {
			screenshots.result(m.toolCallId, m, m.isError);
			continue;
		}
		if (m.role !== "assistant") continue;
		if (Array.isArray(m.content)) {
			for (const block of m.content) {
				if (block?.type === "toolCall") screenshots.start(block.id, block.name);
			}
		}
		let turn = history.at(-1);
		if (turn?.role !== "assistant") {
			turn = { id: `h${++index}`, role: "assistant", text: "", activities: [] };
			history.push(turn);
		}
		const text = screenshots.finish(
			presentText(textOf(m)),
			m.stopReason,
			["toolUse", "deferred"].includes(m.stopReason ?? "") || hasToolCalls(m),
		);
		if (text) turn.text = turn.text ? `${turn.text}\n\n${text}` : text;
		turn.activities.push(...activitiesOf(m, failed));
	}
	return history;
}

function activitiesOf(message: AgentMessage, failed: Set<string>): Activity[] {
	if (!Array.isArray(message.content)) return [];
	return message.content.flatMap((block: unknown) => {
		const b = block as { type?: string; id?: string; name?: string; arguments?: unknown };
		if (b?.type !== "toolCall" || typeof b.name !== "string") return [];
		const id = b.id ?? b.name;
		const status = failed.has(id) ? "failed" : "done";
		return [{ id, ...describeTool(b.name, b.arguments, status), status } as Activity];
	});
}
