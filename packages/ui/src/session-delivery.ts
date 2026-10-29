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
	/** An archived suppression marker; never write it back as a delivery. */
	archived?: true;
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
// Do not evict pending work or tombstones to make space. At the limit new
// records fail closed; updates to existing records remain available.
export const MAX_OUTBOX_RECORDS = 10_000;
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
		const request = indexedDB.open(DATABASE, 2);
		let settled = false;
		const timer = setTimeout(() => { settled = true; reject(new Error("El almacén no respondió.")); }, 12_000);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains("deliveries")) db.createObjectStore("deliveries");
			if (!db.objectStoreNames.contains("archived")) db.createObjectStore("archived");
		};
		request.onerror = () => { clearTimeout(timer); settled = true; reject(request.error ?? new Error("No se pudo abrir el almacén.")); };
		request.onblocked = () => { clearTimeout(timer); settled = true; reject(new Error("El almacén está bloqueado por otra ventana.")); };
		request.onsuccess = () => { if (settled) request.result.close(); else { clearTimeout(timer); settled = true; resolve(request.result); } };
	});
}
function readLegacy(): OutgoingMessage[] {
	const raw = localStorage.getItem(STORAGE_KEY);
	const legacy: unknown = raw === null ? [] : JSON.parse(raw);
	if (!Array.isArray(legacy)) throw new Error("El registro anterior no es válido.");
	return legacy.map(value => {
		const item = decode(value);
		// The old store had no correlation contract, even if an unexpected field
		// happens to use the new marker's name.
		const { evidence: _legacyEvidence, ...safe } = item;
		return { ...safe, status: item.status === "delivered" ? "unconfirmed" as const : item.status, identity: legacyDeliveryIdentity(item.identity) };
	});
}
/** Retain legacy bytes because an old view can still write them. */
async function transactRestore(): Promise<OutgoingMessage[]> {
	const previous = readLegacy();
	const db = await openDatabase();
	try {
		return await new Promise((resolve, reject) => {
			const tx = db.transaction(["deliveries", "archived"], "readwrite");
			const store = tx.objectStore("deliveries");
			const request = store.getAll();
			const archived = tx.objectStore("archived").getAll();
			let result: OutgoingMessage[] = [];
			let failure: unknown;
			const timer = setTimeout(() => { try { tx.abort(); } catch { /* It may already have committed. */ } reject(new Error("El almacenamiento no confirmó la operación.")); }, 12_000);
			let remaining = 2;
			const ready = () => {
				if (--remaining) return;
				try {
					const known = new Map<string, OutgoingMessage>();
					for (const value of archived.result) {
						const item = decode(value, false), key = deliveryKey(item);
						known.set(key, { ...item, archived: true });
					}
					for (const value of request.result) { const item = decode(value, false); if (known.has(deliveryKey(item))) throw new Error("El envío archivado reapareció; revisa el almacenamiento."); known.set(deliveryKey(item), item); }
					for (const item of previous) {
						const key = deliveryKey(item);
						if (!known.has(key)) { known.set(key, item); store.put(encode(item), key); }
					}
					result = [...known.values()];
				} catch (error) { failure = error; tx.abort(); }
			};
			request.onsuccess = ready; archived.onsuccess = ready;
			tx.oncomplete = () => { clearTimeout(timer); resolve(result); };
			tx.onabort = () => { clearTimeout(timer); reject(failure ?? tx.error ?? new Error("No se pudo guardar el envío.")); };
			tx.onerror = () => { /* onabort reports the failed transaction */ };
		});
	} finally { db.close(); }
}

/** Check and update only requested keys in a single transaction. In particular,
 * never load every stored payload just to send or update one message. */
async function writeRecords(items: OutgoingMessage[]): Promise<void> {
	readLegacy(); // Fail closed if legacy data cannot be read or is malformed.
	if (items.some(item => item.archived)) throw new Error("Los marcadores archivados no son envíos activos.");
	const keys = items.map(deliveryKey);
	if (new Set(keys).size !== keys.length) throw new Error("El envío está repetido.");
	const db = await openDatabase();
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(["deliveries", "archived"], "readwrite");
			const store = tx.objectStore("deliveries");
			const archived = tx.objectStore("archived");
			const count = store.count();
			const reads = keys.map(key => store.get(key));
			const markers = keys.map(key => archived.get(key));
			const updated: Array<{ item: OutgoingMessage; version: number }> = [];
			let failure: unknown;
			let pending = reads.length + markers.length + 1;
			const timer = setTimeout(() => { try { tx.abort(); } catch { /* It may already have committed. */ } reject(new Error("El almacenamiento no confirmó la operación.")); }, 12_000);
			const ready = () => {
				if (--pending) return;
				try {
					if (markers.some(marker => marker.result !== undefined)) throw new Error("El envío ya fue archivado; vuelve a leer la bandeja.");
					const old = reads.map(read => read.result === undefined ? undefined : decode(read.result, false));
					const newCount = old.filter(item => !item).length;
					if (newCount && count.result + newCount > MAX_OUTBOX_RECORDS) throw new Error("La bandeja alcanzó su capacidad.");
					for (let i = 0; i < items.length; i++) {
						const item = items[i]!, prior = old[i];
						if (prior && (item.storageVersion === undefined || (prior.storageVersion ?? 0) !== item.storageVersion)) throw new Error("El envío cambió en otra ventana.");
						if (prior && terminal(prior) && !terminal(item)) throw new Error("El envío ya fue resuelto en otra ventana.");
						const next = { ...item, storageVersion: (prior?.storageVersion ?? -1) + 1 };
						store.put(encode(next), keys[i]!);
						updated.push({ item, version: next.storageVersion });
					}
				} catch (error) { failure = error; tx.abort(); }
			};
			count.onsuccess = ready;
			for (const read of [...reads, ...markers]) read.onsuccess = ready;
			tx.oncomplete = () => { clearTimeout(timer); for (const entry of updated) entry.item.storageVersion = entry.version; resolve(); };
			tx.onabort = () => { clearTimeout(timer); reject(failure ?? tx.error ?? new Error("No se pudo guardar el envío.")); };
			tx.onerror = () => { /* onabort reports the failed transaction */ };
		});
	} finally { db.close(); }
}
export async function restoreDeliveries(): Promise<OutgoingMessage[]> { return (await transactRestore()).map(item => ({ ...decode(encode(item)), ...(item.archived ? { archived: true as const } : {}) })); }
export async function persistDeliveries(items: OutgoingMessage[]): Promise<boolean> {
	try { await writeRecords(items); return true; } catch { return false; }
}

const ARCHIVE_BATCH = 250;
export interface DeliveryArchive {
	readonly bytes: Uint8Array;
	readonly sha256: string;
	readonly count: number;
	readonly records: readonly OutgoingMessage[];
}
/** Freeze only resolved records. Pending messages are never candidates. */
export async function prepareDeliveryArchive(hashBytes?: (bytes: Uint8Array) => Promise<string>): Promise<DeliveryArchive> {
	let records = (await transactRestore()).filter(item => !item.archived && !isLegacyDelivery(item) && terminal(item))
		.sort((a, b) => a.createdAt - b.createdAt).slice(0, ARCHIVE_BATCH);
	if (!records.length) throw new Error("No hay envíos resueltos compatibles para archivar; los registros heredados se conservan.");
	let bytes = new TextEncoder().encode(JSON.stringify({ format: "capri-session-deliveries", version: 1, records: records.map(encode) }));
	while (bytes.length > 8 * 1024 * 1024 && records.length > 1) {
		records = records.slice(0, Math.ceil(records.length / 2));
		bytes = new TextEncoder().encode(JSON.stringify({ format: "capri-session-deliveries", version: 1, records: records.map(encode) }));
	}
	if (bytes.length > 8 * 1024 * 1024) throw new Error("Un registro excede el límite de exportación. No se archivó nada.");
	if (!hashBytes && !globalThis.crypto?.subtle) throw new Error("Este dispositivo no puede verificar el archivo.");
	const sha256 = hashBytes ? await hashBytes(bytes) : [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
	if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("No se pudo comprobar la copia.");
	return { bytes, sha256, count: records.length, records };
}
/** Compact only after the user reopens the exact exported bytes; keep a marker
 * for every key to suppress stale host receipts. Legacy records remain intact. */
export async function compactDeliveryArchive(archive: DeliveryArchive, exported: Uint8Array): Promise<number> {
	if (archive.bytes.length !== exported.length || archive.bytes.some((byte, i) => exported[i] !== byte)) throw new Error("El archivo elegido no coincide con la copia descargada. No se archivó nada.");
	if (!archive.records.length || archive.records.length > ARCHIVE_BATCH || archive.count !== archive.records.length) throw new Error("La selección de envíos no es válida.");
	const expectedBytes = new TextEncoder().encode(JSON.stringify({ format: "capri-session-deliveries", version: 1, records: archive.records.map(encode) }));
	if (expectedBytes.length !== exported.length || expectedBytes.some((byte, i) => exported[i] !== byte)) throw new Error("La selección de envíos cambió. Descarga otra copia.");
	readLegacy();
	const keys = archive.records.map(deliveryKey);
	if (new Set(keys).size !== keys.length || archive.records.some(item => item.archived || isLegacyDelivery(item) || !terminal(item))) throw new Error("La selección de envíos no es válida.");
	const db = await openDatabase();
	try {
		return await new Promise<number>((resolve, reject) => {
			const tx = db.transaction(["deliveries", "archived"], "readwrite");
			const store = tx.objectStore("deliveries"), markers = tx.objectStore("archived");
			const reads = keys.map(key => store.get(key));
			const existing = keys.map(key => markers.get(key));
			let pending = reads.length + existing.length, failure: unknown;
			const timer = setTimeout(() => { try { tx.abort(); } catch { /* Already settled. */ } reject(new Error("El almacenamiento no confirmó el archivo.")); }, 12_000);
			const ready = () => {
				if (--pending) return;
				try {
					for (let i = 0; i < keys.length; i++) {
						const current = reads[i]!.result === undefined ? undefined : decode(reads[i]!.result, false);
						if (!current || existing[i]!.result !== undefined || !terminal(current) || JSON.stringify(encode(current)) !== JSON.stringify(encode(archive.records[i]!))) throw new Error("Un envío cambió durante la revisión. Descarga otra copia.");
					}
					for (const item of archive.records) {
						const marker: OutgoingMessage = { id: item.id, identity: item.identity, createdAt: item.createdAt, text: "", payload: "", status: "dismissed", baseline: new Set() };
						const key = deliveryKey(item);
						markers.put(encode(marker), key); store.delete(key);
					}
				} catch (error) { failure = error; tx.abort(); }
			};
			for (const read of [...reads, ...existing]) read.onsuccess = ready;
			tx.oncomplete = () => { clearTimeout(timer); resolve(keys.length); };
			tx.onabort = () => { clearTimeout(timer); reject(failure ?? tx.error ?? new Error("No se pudo archivar la bandeja.")); };
			tx.onerror = () => {};
		});
	} finally { db.close(); }
}
