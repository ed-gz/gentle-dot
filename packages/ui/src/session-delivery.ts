import type { AgentConversation, AgentDelivery } from "./orchestration.ts";

export interface OutgoingMessage {
	id: string;
	identity: string;
	text: string;
	payload: string;
	createdAt: number;
	status: "sending" | "dismissed" | AgentDelivery["status"];
	baseline: Set<string>;
	attachmentNames?: string[];
}
const DAY = 86_400_000;
const WINDOW = 10 * 60_000;
const normalize = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();

function matchesMessage(item: OutgoingMessage, message: AgentConversation["messages"][number]) {
	if (message.role !== "user" || message.provenance) return false;
	if (message.clientMessageId || message.deliveryId)
		return message.clientMessageId === item.id || message.deliveryId === item.id;
	if (item.baseline.has(message.id)) return false;
	const at = Date.parse(message.timestamp ?? "");
	if (!Number.isFinite(at) || at < item.createdAt - 5_000 || at > item.createdAt + WINDOW) return false;
	const text = message.content.map(block => block.text).join("\n");
	const body = text.replace(/<attachments>[\s\S]*?<\/attachments>/g, "");
	if ((!normalize(item.text) && !item.attachmentNames?.length) || normalize(body) !== normalize(item.text)) return false;
	const names = new Set<string>();
	for (const block of text.matchAll(/<attachments>([\s\S]*?)<\/attachments>/g)) {
		for (const line of block[1]!.split("\n")) {
			try {
				const file: unknown = JSON.parse(line);
				if (file && typeof file === "object" && "name" in file && typeof file.name === "string") names.add(file.name);
			} catch { /* Manifest explanatory lines are not JSON. */ }
		}
	}
	return (item.attachmentNames ?? []).every(name => names.has(name));
}

/** Transcript evidence overrides a stale receipt, including on a fresh client. */
export function reconcileDeliveries(
	items: OutgoingMessage[],
	conversation: Pick<AgentConversation, "messages" | "deliveries">,
	identity: string | undefined,
	now = Date.now(),
): OutgoingMessage[] {
	const updated = [...items];
	for (const receipt of conversation.deliveries ?? []) {
		if (identity && receipt.status !== "delivered" && !updated.some(item => item.identity === identity && item.id === receipt.id)) {
			updated.push({
				id: receipt.id, identity, text: receipt.preview ?? "Mensaje pendiente de esta sesión", payload: "",
				createdAt: Date.parse(receipt.acceptedAt), status: receipt.status, baseline: new Set(),
			});
		}
	}
	// Reserve already-confirmed evidence too. One real turn cannot confirm two identical sends.
	const used = new Set<string>();
	return updated.map(item => {
		if (item.identity !== identity || item.status === "dismissed") return item;
		const receipt = conversation.deliveries?.find(receipt => receipt.id === item.id);
		const match = conversation.messages.find(message => !used.has(message.id) && matchesMessage(item, message));
		if (match) used.add(match.id);
		const status = match || item.status === "delivered" || receipt?.status === "delivered"
			? "delivered"
			: receipt?.status ?? (item.status === "accepted" && now - item.createdAt > 30_000 ? "unconfirmed" : item.status);
		return { ...item, status } as OutgoingMessage;
	}).filter(item => Number.isFinite(item.createdAt) && now - item.createdAt <= DAY);
}

const STORAGE_KEY = "gentle-dot:session-outbox:v1";
export function restoreDeliveries(): OutgoingMessage[] {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
		if (!Array.isArray(stored)) return [];
		return stored.filter(item => item && typeof item.id === "string" && typeof item.identity === "string" &&
			typeof item.text === "string" && typeof item.payload === "string" && Number.isFinite(item.createdAt) &&
			Date.now() - item.createdAt <= DAY)
			.map(item => ({
				id: item.id, identity: item.identity, text: item.text, payload: item.payload, createdAt: item.createdAt,
				status: item.status === "dismissed" || item.status === "delivered" ? item.status : "unconfirmed",
				baseline: new Set<string>(Array.isArray(item.baseline) ? item.baseline.filter((id: unknown) => typeof id === "string") : []),
				attachmentNames: Array.isArray(item.attachmentNames) ? item.attachmentNames.filter((name: unknown) => typeof name === "string") : [],
			}));
	} catch { return []; }
}
export function persistDeliveries(items: OutgoingMessage[]) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(items.filter(item => Date.now() - item.createdAt <= DAY).map(item => ({
			...item,
			// Keep small tombstones so stale daemon receipts cannot resurrect dismissed/completed sends.
			...(item.status === "delivered" || item.status === "dismissed" ? {payload: ""} : {}),
			baseline: [...item.baseline],
		}))));
	} catch { /* Storage can be unavailable; receipts/history still reconcile in memory. */ }
}
