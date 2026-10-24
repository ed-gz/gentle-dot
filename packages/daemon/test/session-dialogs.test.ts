import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIDialogOptions,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDotSession } from "../src/extensions/dot-session.ts";
import { localRequest } from "../src/orchestration/herdr.ts";

initTheme("dark", false);

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
async function session(withCustom = true) {
	const directory = await mkdtemp(join(tmpdir(), "dot-dialog-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const events = {
		on(name: string, callback: (data: unknown) => void) {
			const group = listeners.get(name) ?? new Set();
			group.add(callback);
			listeners.set(name, group);
			return () => {
				group.delete(callback);
			};
		},
		emit(name: string, data: unknown) {
			for (const callback of listeners.get(name) ?? []) callback(data);
		},
	};
	const native = { aborted: 0, resolve: (_value: unknown) => {} };
	const wait = <T>(options: ExtensionUIDialogOptions | undefined, cancelled: T) =>
		new Promise<T>((resolve) => {
			native.resolve = (value) => resolve(value as T);
			options?.signal?.addEventListener(
				"abort",
				() => {
					native.aborted++;
					resolve(cancelled);
				},
				{ once: true },
			);
		});
	const originals = {
		notify: vi.fn(),
		confirm: vi.fn((_title: string, _message: string, options?: ExtensionUIDialogOptions) =>
			wait(options, false),
		),
		select: vi.fn((_title: string, _choices: string[], options?: ExtensionUIDialogOptions) =>
			wait<string | undefined>(options, undefined),
		),
		input: vi.fn((_title: string, _placeholder?: string, options?: ExtensionUIDialogOptions) =>
			wait<string | undefined>(options, undefined),
		),
	};
	let finishCustom: ((value: unknown) => void) | undefined;
	const custom = vi.fn(
		(factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
			new Promise((resolve) => {
				finishCustom = resolve;
				factory(
					{ requestRender: vi.fn() } as unknown as Parameters<typeof factory>[0],
					{} as Parameters<typeof factory>[1],
					{ matches: () => false } as unknown as Parameters<typeof factory>[2],
					resolve,
				);
			}),
	);
	const editor = vi.fn(() => wait<string | undefined>(undefined, undefined));
	const ctx = {
		mode: "tui",
		cwd: directory,
		ui: { ...originals, editor, ...(withCustom ? { custom } : {}) },
		isIdle: () => true,
		abort: vi.fn(),
		sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined, getBranch: () => [] },
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, callback: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) =>
			handlers.set(name, callback),
		events,
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	const extension = createDotSession(pi, { GENTLE_DOT_SESSION_DIR: directory });
	cleanups.push(extension.close);
	await handlers.get("session_start")?.({}, ctx);
	const file = (await readdir(directory)).find((name) => name.endsWith(".json"));
	const manifest = JSON.parse(await readFile(join(directory, file ?? "missing-manifest"), "utf8"));
	const call = (method: string, params = {}) =>
		localRequest(manifest.socketPath, method, {
			expectedSessionId: "s1",
			expectedInstanceId: manifest.instanceId,
			...params,
		});
	return {
		ctx,
		sendUserMessage: pi.sendUserMessage,
		native,
		originals,
		call,
		events,
		handlers,
		extension,
		editor,
		custom,
		finishCustom: (value: unknown) => finishCustom?.(value),
	};
}

it("queues human extra detail behind the question in order, never as an answer, while refusing workflow prompts", async()=>{
 const h=await session(); const waiting=h.ctx.ui.confirm("Continue?","Choose first");
 const page=await h.call("snapshot"); const q=page.question as {id:string};
 await expect(h.call("prompt",{text:"autonomous"})).rejects.toMatchObject({code:"QUESTION_PENDING"});
 await expect(h.call("prompt",{text:"extra one",humanInteraction:true,clientMessageId:"queue-human-001",deliverAs:"steer"})).resolves.toMatchObject({accepted:true});
 await h.call("prompt",{text:"extra two",humanInteraction:true,clientMessageId:"queue-human-002"});
 expect(h.sendUserMessage).not.toHaveBeenCalled();
 expect((await h.call("snapshot")).deliveries).toMatchObject([{id:"queue-human-001",status:"queued",deliverAs:"followUp"},{id:"queue-human-002",status:"queued"}]);
 vi.mocked(h.sendUserMessage).mockImplementationOnce(()=>{ void h.handlers.get("input")?.({source:"extension",text:"extra one"},h.ctx); });
 await h.call("answer",{questionId:q.id,confirmed:true}); expect(await waiting).toBe(true);
 await vi.waitFor(()=>expect(h.sendUserMessage).toHaveBeenCalledTimes(2));
 expect(vi.mocked(h.sendUserMessage).mock.calls.map(c=>c[0])).toEqual(["extra one","extra two"]);
 expect(vi.mocked(h.sendUserMessage).mock.calls[0]?.[1]).toMatchObject({deliverAs:"followUp"});
});
it("acknowledges an accepted queued retry at capacity without admitting a new message", async()=>{
 const h=await session(); const waiting=h.ctx.ui.confirm("Continue?","Choose first");
 const q=(await h.call("snapshot")).question as {id:string};
 for(let i=0;i<16;i++) await h.call("prompt",{text:`extra ${i}`,humanInteraction:true,clientMessageId:`capacity-msg-${i}`});
 await expect(h.call("prompt",{text:"extra 0",humanInteraction:true,clientMessageId:"capacity-msg-0"})).resolves.toMatchObject({accepted:true});
 await expect(h.call("prompt",{text:"overflow",humanInteraction:true,clientMessageId:"capacity-overflow"})).rejects.toMatchObject({code:"DELIVERY_LIMIT"});
 await h.call("answer",{questionId:q.id,confirmed:true}); await waiting;
 await vi.waitFor(()=>expect(h.sendUserMessage).toHaveBeenCalledTimes(16));
 await h.call("prompt",{text:"overflow",humanInteraction:true,clientMessageId:"capacity-overflow"});
 expect(h.sendUserMessage).toHaveBeenCalledTimes(17);
});

it("refuses autonomous answers to generic dialogs and counts human answers as personal activity", async()=>{
 const h=await session(); const first=h.ctx.ui.confirm("Continue?","Question");
 const q=(await h.call("snapshot")).question as {id:string};
 await expect(h.call("answer",{questionId:q.id,confirmed:true,expectedHumanActivityAt:null})).rejects.toMatchObject({code:"HUMAN_REQUIRED"});
 expect((await h.call("snapshot")).companionActivity).not.toHaveProperty("humanActivityAt");
 await h.call("answer",{questionId:q.id,confirmed:true}); await first;
 const second=h.ctx.ui.confirm("Continue again?","Question");
 const next=(await h.call("snapshot")).question as {id:string};
 await h.call("answer",{questionId:next.id,confirmed:true}); await second;
 expect((await h.call("snapshot")).companionActivity).toHaveProperty("humanActivityAt");
});

describe("real session UI answers", () => {
	it("exports activity events through the bound socket without draft or submitted text", async () => {
		const h = await session();
		h.events.emit("gentle-dot:editor-activity", { sessionId: "another", kind: "changed" });
		expect((await h.call("snapshot")).companionActivity).toMatchObject({ phase: "idle", capabilities: { typing: false } });
		h.events.emit("gentle-dot:editor-activity", { sessionId: "s1", kind: "changed" });
		expect((await h.call("snapshot")).companionActivity).toMatchObject({ phase: "typing", capabilities: { typing: true } });
		const history = vi.spyOn(h.ctx.sessionManager, "getBranch");
		expect((await h.call("companion.activity")).companionActivity).toMatchObject({ phase: "typing" });
		expect(history).not.toHaveBeenCalled();
		await h.handlers.get("input")?.({ text: "private fixture instruction", source: "interactive" }, h.ctx);
		const submitted = (await h.call("snapshot")).companionActivity;
		expect(submitted).toMatchObject({ phase: "submitted", submittedAt: expect.any(String) });
		expect(JSON.stringify(submitted)).not.toContain("private");
		h.ctx.isIdle = () => false;
		await h.handlers.get("agent_start")?.({}, h.ctx);
		expect((await h.call("snapshot")).companionActivity).toMatchObject({ phase: "working", responseStartedAt: expect.any(String) });
		h.ctx.isIdle = () => true;
		await h.handlers.get("agent_end")?.({}, h.ctx);
		expect((await h.call("snapshot")).companionActivity).toMatchObject({ phase: "idle", responseEndedAt: expect.any(String) });
	});
	it("preserves unsupported terminal prompt context as a visible waiting request", async () => {
		const h = await session();
		await h.handlers.get("ui_prompt_start")?.({ kind: "custom", title: "Review and allow this session" }, h.ctx);
		const snapshot = await h.call("snapshot");
		expect(snapshot.status).toBe("waiting");
		expect(snapshot.question).toMatchObject({ kind: "custom", title: "Review and allow this session", answerable: false });
		expect((snapshot.question as Record<string, unknown>).message).toContain("Responde o cancela en la terminal");
		await h.handlers.get("ui_prompt_end")?.({}, h.ctx);
		expect((await h.call("snapshot")).question).toBeNull();
	});
	it("publishes editable prefill, rejects mismatched answers and closes the terminal editor on remote completion", async () => {
		const h = await session();
		const pending = h.ctx.ui.editor("Editar plan", "  primera\nsegunda  ");
		const question = (await h.call("snapshot")).question as Record<string, unknown>;
		expect(question).toMatchObject({ kind: "editor", answerable: true, message: "  primera\nsegunda  " });
		for (const invalid of [
			{ approved: true },
			{ optionId: "0" },
			{ text: "bad\0value" },
			{ text: "x".repeat(65_537) },
		])
			await expect(h.call("answer", { questionId: question.id, ...invalid })).rejects.toMatchObject({
				code: "INVALID_ANSWER",
			});
		expect((await h.call("snapshot")).question).toMatchObject({ id: question.id });
		await h.call("answer", { questionId: question.id, text: "  revised\n$literal  " });
		await expect(pending).resolves.toBe("  revised\n$literal  ");
		expect(h.custom).toHaveBeenCalledOnce();
		expect(h.editor).not.toHaveBeenCalled();
		expect((await h.call("snapshot")).question).toBeNull();
		await expect(h.call("answer", { questionId: question.id, text: "late" })).rejects.toMatchObject({
			code: "QUESTION_CHANGED",
		});
	});

	it("rejects expired editor responses without deciding, then closes on session abort", async () => {
		const h = await session();
		const pending = h.ctx.ui.editor("Expiry");
		const question = (await h.call("snapshot")).question as Record<string, unknown>;
		const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse(String(question.expiresAt)) + 1);
		try {
			await expect(h.call("answer", { questionId: question.id, text: "late" })).rejects.toMatchObject({
				code: "QUESTION_CHANGED",
			});
			expect((await h.call("snapshot")).question).toMatchObject({ id: question.id });
		} finally {
			now.mockRestore();
		}
		await h.call("abort");
		await expect(pending).resolves.toBeUndefined();
		expect(h.ctx.abort).toHaveBeenCalledOnce();
	});

	it("closes the native editor when its deadline elapses", async () => {
		const h = await session();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		try {
			const pending = h.ctx.ui.editor("Timeout");
			await vi.advanceTimersByTimeAsync(600_001);
			await expect(pending).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
		expect((await h.call("snapshot")).question).toBeNull();
	});

	it.each([false, true])("keeps unpublishable editors local (custom transport: %s)", async (withCustom) => {
		const h = await session(withCustom);
		const prefill = withCustom ? "x".repeat(66_000) : "local only";
		const pending = h.ctx.ui.editor("Local", prefill);
		expect((await h.call("snapshot")).question).toBeNull();
		expect(h.editor).toHaveBeenCalledExactlyOnceWith("Local", prefill);
		expect(h.custom).not.toHaveBeenCalled();
		h.native.resolve("original editor result");
		await expect(pending).resolves.toBe("original editor result");
	});

	it("distinguishes empty editor content, cancellation, native completion and shutdown; restores editor ownership", async () => {
		const h = await session();
		for (const response of [{ text: "" }, { cancelled: true }]) {
			const pending = h.ctx.ui.editor("Editar");
			const question = (await h.call("snapshot")).question as Record<string, unknown>;
			await h.call("answer", { questionId: question.id, ...response });
			await expect(pending).resolves.toBe("text" in response ? "" : undefined);
		}
		const local = h.ctx.ui.editor("Local");
		const question = (await h.call("snapshot")).question as Record<string, unknown>;
		h.finishCustom("native\nresult");
		await expect(local).resolves.toBe("native\nresult");
		await expect(h.call("answer", { questionId: question.id, text: "late" })).rejects.toMatchObject({
			code: "QUESTION_CHANGED",
		});
		const closing = h.ctx.ui.editor("Cerrar");
		await h.extension.close();
		await expect(closing).resolves.toBeUndefined();
		expect(h.ctx.ui.editor).toBe(h.editor);
		expect(h.ctx.ui.custom).toBe(h.custom);
	});
	it("preserves explicit confirmation rejection on the shared dialog route", async () => {
		const h = await session();
		const pending = h.ctx.ui.confirm("Publish", "Publish this change?");
		const question = (await h.call("snapshot")).question as Record<string, unknown>;
		await expect(h.call("answer", { questionId: question.id, text: "yes" })).rejects.toMatchObject({
			code: "INVALID_ANSWER",
		});
		expect(h.native.aborted).toBe(0);
		await h.call("answer", { questionId: question.id, approved: false });
		await expect(pending).resolves.toBe(false);
		expect(h.native.aborted).toBe(1);
	});

	it("returns the exact selected value and closes the native selector, without interpreting labels as approval", async () => {
		const h = await session();
		const choices = ["No, cancel", "Yes, but inspect only", "Allow all future actions"];
		const pending = h.ctx.ui.select("Choose scope", choices);
		choices[1] = "MUTATED";
		const page = await h.call("snapshot");
		const question = page.question as Record<string, unknown>;
		expect(question).toMatchObject({
			kind: "select",
			answerable: true,
			options: [
				{ id: "0", label: "No, cancel" },
				{ id: "1", label: "Yes, but inspect only" },
				{ id: "2", label: "Allow all future actions" },
			],
		});
		expect(question.fingerprint).toBeUndefined();
		await expect(h.call("answer", { questionId: question.id, confirmed: true })).rejects.toMatchObject({
			code: "INVALID_ANSWER",
		});
		await expect(
			h.call("answer", { questionId: question.id, optionId: "Yes, but inspect only" }),
		).rejects.toMatchObject({ code: "INVALID_ANSWER" });
		await h.call("answer", { questionId: question.id, optionId: "1" });
		await expect(pending).resolves.toBe("Yes, but inspect only");
		expect(h.native.aborted).toBe(1);
		await expect(h.call("answer", { questionId: question.id, optionId: "1" })).rejects.toMatchObject({
			code: "QUESTION_CHANGED",
		});
	});

	it("returns literal input whitespace and newlines, and distinguishes cancellation from an empty value", async () => {
		const h = await session();
		const pending = h.ctx.ui.input("Text", "Placeholder");
		let question = (await h.call("snapshot")).question as Record<string, unknown>;
		expect(question.placeholder).toBe("Placeholder");
		await h.call("answer", { questionId: question.id, text: "  /reload\n$literal  " });
		await expect(pending).resolves.toBe("  /reload\n$literal  ");
		const empty = h.ctx.ui.input("Empty allowed");
		question = (await h.call("snapshot")).question as Record<string, unknown>;
		await h.call("answer", { questionId: question.id, text: "" });
		await expect(empty).resolves.toBe("");
		const cancelled = h.ctx.ui.input("Cancel");
		question = (await h.call("snapshot")).question as Record<string, unknown>;
		await h.call("answer", { questionId: question.id, cancelled: true });
		await expect(cancelled).resolves.toBeUndefined();
	});

	it("keeps the original native decision authoritative and denies a late mobile answer", async () => {
		const h = await session();
		const pending = h.ctx.ui.select("Choose", ["a", "b"]);
		const question = (await h.call("snapshot")).question as Record<string, unknown>;
		h.native.resolve("b");
		await expect(pending).resolves.toBe("b");
		await expect(h.call("answer", { questionId: question.id, optionId: "0" })).rejects.toMatchObject({
			code: "QUESTION_CHANGED",
		});
	});

	it("closes pending input on caller abort, timeout and extension shutdown; restores original methods", async () => {
		const h = await session();
		const abort = new AbortController();
		const pending = h.ctx.ui.input("Abort", undefined, { signal: abort.signal });
		abort.abort();
		await expect(pending).resolves.toBeUndefined();
		await expect(h.ctx.ui.select("Timeout", ["a"], { timeout: 5 })).resolves.toBeUndefined();
		const closing = h.ctx.ui.input("Close");
		await h.extension.close();
		await expect(closing).resolves.toBeUndefined();
		expect(h.ctx.ui.confirm).toBe(h.originals.confirm);
		expect(h.ctx.ui.select).toBe(h.originals.select);
		expect(h.ctx.ui.input).toBe(h.originals.input);
	});

	it("does not truncate oversized native choices into a remotely answerable prompt", async () => {
		const h = await session();
		const value = "x".repeat(66_000);
		const pending = h.ctx.ui.select("Long", [value]);
		expect((await h.call("snapshot")).question).toBeNull();
		h.native.resolve(value);
		await expect(pending).resolves.toBe(value);
	});

	it("relays cooperative questionnaires only after the original tool acknowledges the exact indexed response", async () => {
		const h = await session();
		h.events.emit("herdr-connect:question:request", {
			id: "form",
			sessionId: "s1",
			questions: [
				{ id: "0", question: "Which?", options: [{ label: "A", preview: "exact A" }, { label: "B" }] },
			],
		});
		const question = (await h.call("snapshot")).question as Record<string, unknown>;
		expect(question).toMatchObject({ kind: "questionnaire", answerable: true });
		await expect(
			h.call("answer", { questionId: "form", answers: [{ questionId: "0", optionIndices: [0] }] }),
		).rejects.toMatchObject({ code: "QUESTION_CHANGED" });
		const received: unknown[] = [];
		h.events.on("herdr-connect:question:answer", (payload) => {
			const answer = payload as Record<string, unknown>;
			received.push(answer.answers);
			answer.accepted = true;
			h.events.emit("herdr-connect:question:closed", { id: "form", sessionId: "s1" });
		});
		await h.call("answer", {
			questionId: "form",
			answers: [{ questionId: "0", optionIndices: [1], label: "FORGED" }],
		});
		expect(received).toEqual([[{ questionId: "0", optionIndices: [1] }]]);
		expect((await h.call("snapshot")).question).toBeNull();
	});
});

it("pages the active branch without duplicates while new messages arrive", async () => {
	const h = await session();
	const branch = Array.from({ length: 127 }, (_, index) => ({
		type: "message",
		id: `m-${index}`,
		message: {
			role: index % 2 ? "assistant" : "user",
			content: [{ type: "text", text: `Mensaje ${index}` }],
			stopReason: "stop",
		},
	}));
	h.ctx.sessionManager.getBranch = () =>
		branch as unknown as ReturnType<typeof h.ctx.sessionManager.getBranch>;
	const first = await h.call("snapshot", { limit: 50 });
	expect(first.history).toEqual({ supported: true, hasEarlier: true, before: "m-77" });
	expect((first.messages as Array<{ id: string }>).map((message) => message.id)).toEqual(
		branch.slice(77).map((entry) => entry.id),
	);
	branch.push({
		type: "message",
		id: "new-live",
		message: { role: "assistant", content: [{ type: "text", text: "Nuevo" }], stopReason: "stop" },
	});
	const second = await h.call("snapshot", { limit: 50, before: "m-77" });
	expect(second.history).toEqual({ supported: true, hasEarlier: true, before: "m-27" });
	expect((second.messages as Array<{ id: string }>).map((message) => message.id)).toEqual(
		branch.slice(27, 77).map((entry) => entry.id),
	);
	const third = await h.call("snapshot", { before: "m-27", limit: 50 });
	expect(third.history).toEqual({ supported: true, hasEarlier: false });
	expect(third.messages).toHaveLength(27);
	await expect(h.call("snapshot", { before: "other-branch" })).rejects.toMatchObject({
		code: "HISTORY_CHANGED",
	});
	for (const limit of [0, 101, 1.5, "50"])
		await expect(h.call("snapshot", { limit })).rejects.toMatchObject({ code: "INVALID_HISTORY" });
});

it("freezes cooperative question options and consumes an accepted response before a delayed close", async () => {
	const h = await session();
	const questions = [
		{ id: "0", question: "¿Autorizar?", options: [{ label: "Sólo revisar" }, { label: "Publicar" }] },
	];
	h.events.emit("herdr-connect:question:request", { id: "frozen", sessionId: "s1", questions });
	const firstOption = questions[0]?.options[0];
	if (!firstOption) throw new Error("Missing original option");
	firstOption.label = "Publicar todo";
	const pending = (await h.call("snapshot")).question as Record<string, unknown>;
	expect(pending.questions).toEqual([
		{
			id: "0",
			question: "¿Autorizar?",
			multiSelect: false,
			options: [{ label: "Sólo revisar" }, { label: "Publicar" }],
		},
	]);
	const accepted = vi.fn((payload: unknown) => {
		(payload as Record<string, unknown>).accepted = true;
	});
	h.events.on("herdr-connect:question:answer", accepted);
	await h.call("answer", { questionId: "frozen", answers: [{ questionId: "0", optionIndices: [0] }] });
	expect((await h.call("snapshot")).question).toBeNull();
	await expect(
		h.call("answer", { questionId: "frozen", answers: [{ questionId: "0", optionIndices: [0] }] }),
	).rejects.toMatchObject({ code: "QUESTION_CHANGED" });
	expect(accepted).toHaveBeenCalledOnce();
});
