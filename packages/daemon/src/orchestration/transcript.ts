import { activityText, object } from "./activity.ts";
import type { BoundSessionEntries } from "./activity-files.ts";

export interface SessionMessage {
	id: string;
	role: string;
	content: { type: "text"; text: string }[];
	stopReason?: string;
	provenance?: { kind: "subagent" | "session"; label?: string };
}

// Gentle Shell persists this exact identity before using a user-role bridge wake.
// Text alone is never proof: a human may quote, discuss or paste these same words.
const wakePrefix =
	"[System-generated Gentle Agents notification, not written by the user] Subagent output was delivered to this session above. Review it and continue.";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const generated = new Set([
	"gentle-agents.result",
	"gentle-agents.message",
	"gentle-agents.orchestrator-message",
]);

function contentText(content: unknown): string {
	return typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.filter(object)
					.filter((part) => part.type === "text" && typeof part.text === "string")
					.map((part) => part.text)
					.join("\n")
			: "";
}

/** Gentle Shell's persisted marker must match both this session and its exact generated payload. */
export function sessionWakeIdentity(sessionId: string, entry: unknown): string | undefined {
	if (!object(entry) || entry.type !== "custom" || entry.customType !== "gentle-agents.wake-identity") return;
	const data = entry.data;
	if (
		object(data) &&
		data.sessionId === sessionId &&
		typeof data.nonce === "string" &&
		uuid.test(data.nonce) &&
		data.text === `${wakePrefix} [gentle-agents wake: ${data.nonce}]`
	)
		return data.text as string;
}

function ownedWakes(sessionId: string, entries: readonly unknown[]): Set<string> {
	return new Set(
		entries.flatMap((entry) => {
			const text = sessionWakeIdentity(sessionId, entry);
			return text ? [text] : [];
		}),
	);
}

function isOwnedWake(message: Record<string, unknown>, wakes: Set<string>): boolean {
	const content = message.content;
	return (
		message.role === "user" &&
		(typeof content === "string" ||
			(Array.isArray(content) && content.every((part) => object(part) && part.type === "text"))) &&
		wakes.has(contentText(content))
	);
}

function projectEntry(entry: unknown, wakes: Set<string>): SessionMessage | undefined {
	if (!object(entry) || typeof entry.id !== "string") return;
	if (entry.type === "message" && object(entry.message)) {
		const message = entry.message;
		const text = contentText(message.content);
		if (isOwnedWake(message, wakes)) return;
		return {
			id: entry.id,
			role: message.role === "toolResult" ? "tool" : String(message.role),
			content: [{ type: "text", text: text.slice(0, 32_000) }],
			...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
		};
	}
	if (entry.type !== "custom_message" || entry.display !== true || !generated.has(String(entry.customType)))
		return;
	const details =
		object(entry.details) && object(entry.details.gentleAgents) ? entry.details.gentleAgents : undefined;
	const kind = entry.customType === "gentle-agents.orchestrator-message" ? "session" : "subagent";
	const label = activityText(kind === "session" ? details?.senderLabel : details?.agent, 80);
	let text = contentText(entry.content);
	// The provider's visible completion preview omits its bookkeeping paragraph.
	if (entry.customType === "gentle-agents.result") {
		const split = text.indexOf("\n\n");
		if (
			split >= 0 &&
			/^Subagent [^\n]+ \(task [^\n]*\) [^\n]+\.$/.test(text.slice(0, split)) &&
			text.slice(split + 2).trim()
		)
			text = text.slice(split + 2);
	} else if (kind === "session" && typeof details?.message === "string") text = details.message;
	if (!text.trim()) return;
	return {
		id: entry.id,
		role: "assistant",
		content: [{ type: "text", text: text.slice(0, 32_000) }],
		provenance: { kind, ...(label ? { label } : {}) },
	};
}

/** Display-only: does not rewrite Pi's transcript or the model's role/authority. */
export function projectSessionMessages(
	sessionId: string,
	entries: readonly unknown[],
	identityEntries: readonly unknown[] = entries,
): SessionMessage[] {
	const wakes = ownedWakes(sessionId, identityEntries);
	return entries.flatMap((entry) => {
		const message = projectEntry(entry, wakes);
		return message ? [message] : [];
	});
}

/** Correct an already-running older adapter using independently bound transcript identity. */
export function normalizeBoundMessages(
	sessionId: string,
	messages: unknown,
	transcript: BoundSessionEntries | undefined,
): unknown {
	if (!Array.isArray(messages) || !transcript) return messages;
	const raw = messages.filter(object);
	const entries = transcript.entries;
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const wakes = ownedWakes(sessionId, transcript.allEntries);
	const supplied = new Set(raw.map((message) => message.id));
	const first = entries.findIndex((entry) => supplied.has(entry.id));
	if (first < 0) return messages;
	// Older adapters omit custom_message completely. Include delivered results between
	// supplied messages (and just before the first), never messages from another branch.
	let start = first;
	while (start > 0 && entries[start - 1]?.type !== "message") start--;
	const missing = new Map<unknown, SessionMessage[]>();
	let pending: SessionMessage[] = [];
	for (const entry of entries.slice(start)) {
		if (!supplied.has(entry.id) && entry.type === "custom_message") {
			const projected = projectEntry(entry, wakes);
			if (projected) pending.push(projected);
		}
		if (supplied.has(entry.id)) {
			missing.set(entry.id, pending);
			pending = [];
		}
	}
	return raw.flatMap((message) => {
		const entry = byId.get(message.id);
		const before = missing.get(message.id) ?? [];
		if (!entry) return [...before, message]; // Preserve streaming socket messages.
		if (entry.type === "custom_message") {
			const projected = projectEntry(entry, wakes);
			return projected ? [...before, projected] : before;
		}
		if (entry.type === "message" && object(entry.message) && isOwnedWake(entry.message, wakes)) return before;
		return [...before, message];
	});
}
