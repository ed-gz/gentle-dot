import { randomUUID } from "node:crypto";
import { APPROVAL_WAIT_MS, type AppApproval } from "./app-channel.ts";

export interface MobileApproval {
	id: string;
	title: string;
	message: string;
	expiresAt: string;
	revision: string;
}
interface Pending {
	view: MobileApproval;
	expires: number;
	finish: (approved: boolean) => void;
	timer: ReturnType<typeof setTimeout>;
	removeAbort: () => void;
}
interface Options {
	waitMs?: number;
	now?: () => number;
}

const MAX_PREVIEW_BYTES = 64 * 1024;
const MAX_PENDING = 64;

function approvalView(id: string, request: AppApproval, expires: number): MobileApproval {
	if (
		!request ||
		typeof request.connector !== "string" ||
		typeof request.action !== "string" ||
		!Array.isArray(request.preview) ||
		(request.title !== undefined && typeof request.title !== "string") ||
		(request.summary !== undefined && typeof request.summary !== "string") ||
		request.preview.some((field) => !field || typeof field.name !== "string")
	)
		throw new Error("Invalid mobile approval preview");
	// Inputs normally come from JSON tool arguments. Reject values JSON would silently omit.
	const serialize = (value: unknown) =>
		JSON.stringify(
			value,
			(_key, item: unknown) => {
				if (
					["undefined", "function", "symbol", "bigint"].includes(typeof item) ||
					(typeof item === "number" && !Number.isFinite(item))
				)
					throw new Error("Mobile approval preview must contain JSON values");
				return item;
			},
			2,
		);
	const fields = request.preview.map(
		({ name, value }) => `${name}:\n${typeof value === "string" ? value : serialize(value)}`,
	);
	const view = {
		id,
		title: request.title ?? `¿Permitir a ${request.connector} ${request.action}?`,
		message: [
			`Conector: ${request.connector}\nAcción: ${request.action}`,
			...(request.summary ? [request.summary] : []),
			...fields,
		].join("\n\n"),
		expiresAt: new Date(expires).toISOString(),
		revision: randomUUID(),
	};
	// The full review is sent back in a 64 KiB request body. Include the
	// envelope and the longer boolean so a displayed card is answerable.
	if (Buffer.byteLength(JSON.stringify({ requestId: id, approved: false, review: view }), "utf8") > MAX_PREVIEW_BYTES)
		throw new Error("Mobile approval preview exceeds 64 KiB; no truncated approval was created");
	return view;
}

/** A per-request human decision broker. Transport authentication belongs to the gateway. */
export class MobileApprovals {
	private readonly pending = new Map<string, Pending>();
	private readonly waitMs: number;
	private readonly now: () => number;
	private closed = false;
	constructor(options: Options = {}) {
		this.waitMs = options.waitMs ?? APPROVAL_WAIT_MS;
		this.now = options.now ?? Date.now;
		if (!Number.isFinite(this.waitMs) || this.waitMs <= 0 || this.waitMs > 600_000)
			throw new Error("Invalid mobile approval timeout");
	}

	begin(
		requestId: string,
		request: AppApproval,
		signal?: AbortSignal,
	): { answer: Promise<boolean>; cancel(): void } {
		if (this.closed || signal?.aborted) return { answer: Promise.resolve(false), cancel() {} };
		this.expire();
		if (!requestId || requestId.length > 200 || this.pending.has(requestId))
			throw new Error("Mobile approval requires a unique request id");
		if (this.pending.size >= MAX_PENDING) throw new Error("Too many pending mobile approvals");
		const expires = this.now() + this.waitMs;
		const view = approvalView(requestId, request, expires);
		let finish!: (approved: boolean) => void;
		const answer = new Promise<boolean>((resolve) => {
			finish = resolve;
		});
		let entry: Pending;
		const cancel = () => {
			if (this.pending.get(requestId) === entry) this.settle(requestId, false);
		};
		const timer = setTimeout(cancel, this.waitMs);
		timer.unref();
		entry = {
			view,
			expires,
			finish,
			timer,
			removeAbort: () => signal?.removeEventListener("abort", cancel),
		};
		this.pending.set(requestId, entry);
		signal?.addEventListener("abort", cancel, { once: true });
		return { answer, cancel };
	}

	list(): MobileApproval[] {
		this.expire();
		return [...this.pending.values()].map(({ view }) => ({ ...view }));
	}

	answer(id: string, approved: boolean): boolean {
		this.expire();
		if (typeof approved !== "boolean") return false;
		return this.settle(id, approved);
	}

	/** Atomically match the complete human-visible request before settling it. */
	answerExact(expected: MobileApproval, approved: boolean): boolean {
		this.expire();
		if (!expected || typeof expected.id !== "string" || typeof approved !== "boolean") return false;
		const entry = this.pending.get(expected.id);
		if (!entry || entry.view.id !== expected.id || entry.view.title !== expected.title || entry.view.message !== expected.message || entry.view.expiresAt !== expected.expiresAt || entry.view.revision !== expected.revision) return false;
		return this.settle(expected.id, approved);
	}

	close(): void {
		this.closed = true;
		this.cancelAll();
	}

	cancelAll(): void {
		for (const id of this.pending.keys()) this.settle(id, false);
	}

	private expire(): void {
		for (const [id, entry] of this.pending) if (entry.expires <= this.now()) this.settle(id, false);
	}
	private settle(id: string, approved: boolean): boolean {
		const entry = this.pending.get(id);
		if (!entry) return false;
		this.pending.delete(id);
		clearTimeout(entry.timer);
		entry.removeAbort();
		entry.finish(approved);
		return true;
	}
}
