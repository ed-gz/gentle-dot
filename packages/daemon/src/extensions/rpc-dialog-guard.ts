// Narrow, opt-in RPC dialog primitive. It is not registered by the daemon yet.
// The pending dialog lives beside the Pi consumer; callers must expose it only
// through an authenticated, capability-negotiated transport.
import { createHash, randomUUID } from "node:crypto";
import type { ExtensionContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

type Kind = "confirm" | "select" | "input";
type Details = { kind: Kind; title: string; message?: string; options?: string[]; placeholder?: string };
export type RpcQuestion = Readonly<Details & { instanceId: string; sessionId: string; questionId: string; revision: string; expiresAt: number | null }>;
type Response = { instanceId: string; sessionId: string; questionId: string; revision: string; confirmed?: boolean; value?: string; cancelled?: true };
type Pending = { question: RpcQuestion; resolve: (value: boolean | string | undefined) => void };

/** A stale answer never reaches the original dialog's consumer. */
export function installRpcDialogGuard(ui: ExtensionContext["ui"], session: () => string) {
	const instanceId = randomUUID();
	const original = { confirm: ui.confirm, select: ui.select, input: ui.input };
	let pending: Pending | undefined;
	let disposed = false;

	function invoke<T extends boolean | string | undefined>(details: Details, options: ExtensionUIDialogOptions | undefined,
		local: (options?: ExtensionUIDialogOptions) => Promise<T>, cancelled: T): Promise<T> {
		if (disposed || pending || options?.signal?.aborted) return local(options);
		const sessionId = session();
		const expiresAt = options?.timeout && Number.isFinite(options.timeout) && options.timeout > 0 ? Date.now() + options.timeout : null;
		const data = { ...details, ...(details.options ? { options: Object.freeze([...details.options]) } : {}),
			instanceId, sessionId, questionId: randomUUID(), expiresAt };
		const serialized = JSON.stringify(data);
		if (Buffer.byteLength(serialized) > 65_536) return local(options);
		const question = Object.freeze({ ...data, revision: createHash("sha256").update(serialized).digest("hex") }) as RpcQuestion;
		const controller = new AbortController();
		let settleRemote!: (value: T) => void;
		const remote = new Promise<T>(resolve => { settleRemote = resolve; });
		const active: Pending = { question, resolve: value => { settleRemote(value === undefined ? cancelled : value as T); controller.abort(); } };
		pending = active;
		const abort = () => controller.abort();
		options?.signal?.addEventListener("abort", abort, { once: true });
		const localResult = Promise.resolve().then(() => local({ ...options, signal: controller.signal })).then(value => {
			if (pending === active) pending = undefined;
			return value;
		});
		return Promise.race([remote, localResult]).finally(() => {
			if (pending === active) pending = undefined;
			options?.signal?.removeEventListener("abort", abort);
			controller.abort();
		});
	}

	const confirm: typeof ui.confirm = (title, message, options) => invoke({ kind: "confirm", title, message }, options, opts => original.confirm.call(ui, title, message, opts), false);
	const select: typeof ui.select = (title, choices, options) => {
		const frozen = [...choices];
		return invoke({ kind: "select", title, options: frozen }, options, opts => original.select.call(ui, title, frozen, opts), undefined);
	};
	const input: typeof ui.input = (title, placeholder, options) => invoke({ kind: "input", title, ...(placeholder === undefined ? {} : { placeholder }) }, options, opts => original.input.call(ui, title, placeholder, opts), undefined);
	ui.confirm = confirm;
	ui.select = select;
	ui.input = input;

	return {
		snapshot(): RpcQuestion | null {
			if (!pending || pending.question.sessionId !== session() || (pending.question.expiresAt !== null && pending.question.expiresAt <= Date.now())) return null;
			return pending.question;
		},
		answer(response: Response): boolean {
			const current = pending;
			if (!current || !response || typeof response !== "object") return false;
			const q = current.question;
			if (response.instanceId !== instanceId || response.sessionId !== q.sessionId || response.sessionId !== session() ||
				response.questionId !== q.questionId || response.revision !== q.revision || (q.expiresAt !== null && q.expiresAt <= Date.now())) return false;
			const keys = Object.keys(response);
			if (keys.some(key => !["instanceId", "sessionId", "questionId", "revision", "cancelled", "confirmed", "value"].includes(key))) return false;
			let value: boolean | string | undefined;
			if (response.cancelled === true && response.confirmed === undefined && response.value === undefined) value = undefined;
			else if (response.cancelled !== undefined) return false;
			else if (q.kind === "confirm" && typeof response.confirmed === "boolean" && response.value === undefined) value = response.confirmed;
			else if (q.kind !== "confirm" && response.confirmed === undefined && typeof response.value === "string" && response.value.length <= 32_000 &&
				(q.kind !== "select" || q.options?.includes(response.value))) value = response.value;
			else return false;
			pending = undefined;
			current.resolve(value);
			return true;
		},
		dispose() {
			disposed = true;
			const current = pending;
			pending = undefined;
			current?.resolve(undefined);
			if (ui.confirm === confirm) ui.confirm = original.confirm;
			if (ui.select === select) ui.select = original.select;
			if (ui.input === input) ui.input = original.input;
		},
	};
}
