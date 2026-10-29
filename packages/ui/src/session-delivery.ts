import type { AgentConversation, AgentDelivery } from "./orchestration.ts";

export interface OutgoingMessage {
	id: string;
	identity: string;
	text: string;
	payload: string;
	createdAt: number;
	status: "sending" | "dismissed" | AgentDelivery["status"];
	/** Strong identity evidence; absent for legacy receipts and text matches. */
	evidence?: "correlated-v1";
	baseline: Set<string>;
	attachmentNames?: string[];
	/** IndexedDB revision used for compare-and-swap across views. */
	storageVersion?: number;
}
/** Legacy identities were colon-delimited and cannot reliably identify an owner. */
export const legacyDeliveryIdentity = (identity: string) => `legacy:${JSON.stringify(identity)}`;
export const sessionDeliveryIdentity = (scope: string, pane: string, session: string) => `session-v2:${JSON.stringify([scope, pane, session])}`;
export const isLegacyDelivery = (item: OutgoingMessage) => item.identity.startsWith("legacy:");
function matchesMessage(item: OutgoingMessage, message: AgentConversation["messages"][number]) {
	if (message.role !== "user" || message.provenance) return false;
	// deliveryId also names an attachment batch and does not identify a prompt.
	return message.clientMessageId === item.id;
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
		const verified = receipt.status === "delivered" && receipt.evidence === "correlated-v1";
		if (identity && !verified && !updated.some(item => item.identity === identity && item.id === receipt.id)) {
			updated.push({
				id: receipt.id, identity, text: receipt.preview ?? "", payload: "",
				createdAt: Date.parse(receipt.acceptedAt), status: receipt.status === "delivered" ? "unconfirmed" : receipt.status, baseline: new Set(),
			});
		}
	}
	// Reserve already-confirmed evidence too. One real turn cannot confirm two identical sends.
	const used = new Set<string>();
	return updated.map(item => {
		if (item.identity !== identity || item.status === "dismissed") return item;
		// A stale host snapshot from a previous attempt cannot unlock an active send.
		if (item.status === "sending") return item;
		const receipt = conversation.deliveries?.find(receipt => receipt.id === item.id);
		const match = conversation.messages.find(message => !used.has(message.id) && matchesMessage(item, message));
		if (match) used.add(match.id);
		const verified = Boolean(match || (item.status === "delivered" && item.evidence === "correlated-v1") || (receipt?.status === "delivered" && receipt.evidence === "correlated-v1"));
		const status = verified ? "delivered" : receipt?.status === "delivered" || item.status === "delivered" ? "unconfirmed"
			: receipt?.status ?? (item.status === "accepted" && now - item.createdAt > 30_000 ? "unconfirmed" : item.status);
		const { evidence: _previousEvidence, ...safe } = item;
		return { ...safe, status, ...(verified ? { evidence: "correlated-v1" as const } : {}) } as OutgoingMessage;
	}).filter(item => Number.isFinite(item.createdAt));
}

const STORAGE_KEY = "gentle-dot:session-outbox:v1";
const DATABASE = "gentle-dot:session-outbox:v2";
type StoredDelivery = Omit<OutgoingMessage, "baseline"> & { baseline: string[] };
function decode(value: unknown, recover = true): OutgoingMessage {
	if (!value || typeof value !== "object") throw new Error("El registro de envío no es válido.");
	const item = value as Record<string, unknown>;
	if (typeof item.id !== "string" || !item.id || typeof item.identity !== "string" || !item.identity ||
		typeof item.text !== "string" || typeof item.payload !== "string" || typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt) ||
		!["sending", "accepted", "queued", "unconfirmed", "delivered", "dismissed"].includes(String(item.status)) ||
		(item.baseline !== undefined && (!Array.isArray(item.baseline) || item.baseline.some(id => typeof id !== "string"))) ||
		(item.attachmentNames !== undefined && (!Array.isArray(item.attachmentNames) || item.attachmentNames.some(name => typeof name !== "string"))) ||
		(item.storageVersion !== undefined && (!Number.isSafeInteger(item.storageVersion) || (item.storageVersion as number) < 0)))
		throw new Error("El registro de envío no es válido.");
	return {
		id: item.id, identity: item.identity, text: item.text, payload: item.payload, createdAt: item.createdAt,
		status: item.status === "dismissed" ? "dismissed" : item.status === "delivered" && item.evidence === "correlated-v1" ? "delivered" : recover || item.status === "delivered" ? "unconfirmed" : item.status as OutgoingMessage["status"],
		...(item.status === "delivered" && item.evidence === "correlated-v1" ? { evidence: "correlated-v1" as const } : {}),
		baseline: new Set<string>((item.baseline as string[] | undefined) ?? []),
		attachmentNames: (item.attachmentNames as string[] | undefined) ?? [],
		storageVersion: (item.storageVersion as number | undefined) ?? 0,
	};
}
function encode(item: OutgoingMessage): StoredDelivery {
	return { ...item, baseline: [...item.baseline],
		...(item.status === "dismissed" || (item.status === "delivered" && item.evidence === "correlated-v1") ? { payload: "" } : {}) };
}
function deliveryKey(item: Pick<OutgoingMessage, "id" | "identity">) { return JSON.stringify([item.identity, item.id]); }
function terminal(item: OutgoingMessage) { return item.status === "dismissed" || (item.status === "delivered" && item.evidence === "correlated-v1"); }
function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE, 1);
		let settled = false;
		const timer = setTimeout(() => { settled = true; reject(new Error("El almacén no respondió.")); }, 12_000);
		request.onupgradeneeded = () => request.result.createObjectStore("deliveries");
		request.onerror = () => { clearTimeout(timer); settled = true; reject(request.error ?? new Error("No se pudo abrir el almacén.")); };
		request.onblocked = () => { clearTimeout(timer); settled = true; reject(new Error("El almacén está bloqueado por otra ventana.")); };
		request.onsuccess = () => { if (settled) request.result.close(); else { clearTimeout(timer); settled = true; resolve(request.result); } };
	});
}
/** A readwrite transaction merges per-record updates so another view's outbox
 * cannot be replaced. Legacy bytes are retained: an old view can still write
 * them, and localStorage and IndexedDB cannot be migrated atomically together. */
async function transact(incoming?: OutgoingMessage[]): Promise<OutgoingMessage[]> {
	const raw = localStorage.getItem(STORAGE_KEY);
	const legacy: unknown = raw === null ? [] : JSON.parse(raw);
	if (!Array.isArray(legacy)) throw new Error("El registro anterior no es válido.");
	const previous = legacy.map(value => {
		const item = decode(value);
		// The old store had no correlation contract, even if an unexpected field
		// happens to use the new marker's name.
		const { evidence: _legacyEvidence, ...safe } = item;
		return { ...safe, status: item.status === "delivered" ? "unconfirmed" as const : item.status, identity: legacyDeliveryIdentity(item.identity) };
	});
	const db = await openDatabase();
	try {
		return await new Promise((resolve, reject) => {
			const tx = db.transaction("deliveries", "readwrite");
			const store = tx.objectStore("deliveries");
			const request = store.getAll();
			let result: OutgoingMessage[] = [];
			const updated: Array<{ item: OutgoingMessage; version: number }> = [];
			let failure: unknown;
			const timer = setTimeout(() => { try { tx.abort(); } catch { /* It may already have committed. */ } reject(new Error("El almacenamiento no confirmó la operación.")); }, 12_000);
			request.onsuccess = () => {
				try {
					const known = new Map<string, OutgoingMessage>();
					for (const value of request.result) { const item = decode(value, false); known.set(deliveryKey(item), item); }
					for (const item of previous) {
						const key = deliveryKey(item);
						if (!known.has(key)) { known.set(key, item); store.put(encode(item), key); }
					}
					for (const item of incoming ?? []) {
						const key = deliveryKey(item), old = known.get(key);
						// Compare the revision inside the same transaction as the write.
						if (old && (item.storageVersion === undefined || (old.storageVersion ?? 0) !== item.storageVersion)) throw new Error("El envío cambió en otra ventana.");
						if (old && terminal(old) && !terminal(item)) throw new Error("El envío ya fue resuelto en otra ventana.");
						const next = { ...item, storageVersion: (old?.storageVersion ?? -1) + 1 };
						known.set(key, next); store.put(encode(next), key);
						updated.push({item, version: next.storageVersion});
					}
					result = [...known.values()];
				} catch (error) { failure = error; tx.abort(); }
			};
			tx.oncomplete = () => { clearTimeout(timer); for (const entry of updated) entry.item.storageVersion = entry.version; resolve(result); };
			tx.onabort = () => { clearTimeout(timer); reject(failure ?? tx.error ?? new Error("No se pudo guardar el envío.")); };
			tx.onerror = () => { /* onabort reports the failed transaction */ };
		});
	} finally { db.close(); }
}
export async function restoreDeliveries(): Promise<OutgoingMessage[]> { return (await transact()).map(item => decode(encode(item))); }
export async function persistDeliveries(items: OutgoingMessage[]): Promise<boolean> {
	try { await transact(items); return true; } catch { return false; }
}
