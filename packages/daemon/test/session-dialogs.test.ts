import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Socket } from "node:net";
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
import { WorkflowContinuations } from "../src/workflows.ts";
import { humanOnlyQuestion, questionDetails } from "../src/orchestration/questions.ts";

it.each([
 {workflowPermission:{category:"native-review-consent"}},
 {consentBinding:"opaque"},
 {options:[{id:"yes",label:"Allow",effect:"Authorizes candidate"}]},
])("projects consent as explicit submission without exposing its binding %j", metadata => {
 const details = questionDetails({kind:"select",title:"Review",options:[{id:"yes",label:"Allow"}],...metadata});
 expect(details).toMatchObject({requiresConfirmation:true});
 expect(details).not.toHaveProperty("consentBinding");
});

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
	const registry = join(directory, "pi-sessions");
	const extension = createDotSession(pi, { GENTLE_DOT_SESSION_DIR: registry });
	cleanups.push(extension.close);
	await handlers.get("session_start")?.({}, ctx);
	const file = (await readdir(registry)).find((name) => name.endsWith(".json"));
	const manifest = JSON.parse(await readFile(join(registry, file ?? "missing-manifest"), "utf8"));
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

it("preserves transcript timestamps and tool error status for turn disclosures", async () => {
	const h = await session();
	vi.spyOn(h.ctx.sessionManager, "getBranch").mockReturnValue([
		{type:"message",id:"tool",timestamp:"2026-10-25T12:30:00Z",message:{role:"toolResult",isError:true,content:[{type:"text",text:"failed"}]}}
	] as never);
	expect((await h.call("snapshot")).messages).toEqual([expect.objectContaining({id:"tool",timestamp:"2026-10-25T12:30:00Z",isError:true})]);
});

it.each(["git push", "Permiso de seguridad"])("resolves human confirmation %s over the adapter socket", async title => {
	const h = await session();
	const waiting = h.ctx.ui.confirm(title, "¿Continuar?");
	const question = (await h.call("snapshot")).question as Record<string, unknown>;
	await h.call("answer", {questionId:question.id,confirmed:true});
	await expect(waiting).resolves.toBe(true);
	expect((await h.call("snapshot")).question).toBeNull();
});

async function enroll(h: Awaited<ReturnType<typeof session>>, now?: () => number) {
	const target = { paneId: "pane-a", sessionId: "s1" };
	const initial = await h.call("snapshot");
	const coordinator = new WorkflowContinuations({
		dataDir: h.ctx.cwd, now,
		snapshot: async () => {
			const page = await h.call("snapshot");
			return { sessions: [{ ...target, label: "Local", state: "working", connected: true,
				humanActivityAt: (page.companionActivity as { humanActivityAt?: string }).humanActivityAt,
				activityInstanceId: String(initial.instanceId), capabilities: { inspect: true, prompt: true, approvals: true, activityFence: 1 } }], approvals: [] };
		},
		inspect: async () => h.call("snapshot"),
		approve: async (request, authorize) => {
			expect(authorize()).toBe(true);
			return h.call("answer", { questionId: request.requestId, ...request.answer, expectedHumanActivityAt: null });
		},
		prompt: vi.fn(),
	});
	cleanups.push(async () => coordinator.close());
	const work = await coordinator.dispatch({ action: "start", mode: "session", objective: "Run the tests in this project",
		authorization: "Aprueba todos los permisos de esta sesión", sessions: [target], expiresInHours: 0.25 }, "agent") as { id: string };
	return { coordinator, work, target };
}

it.each(["pause", "yield", "expire"])("does not add tool dialogs after autonomous enrollment is %s", async action => {
	const h = await session();
	let now = Date.now();
	const { coordinator, work, target } = await enroll(h, () => now);
	if (action === "pause") await coordinator.dispatch({ action: "pause", workflowId: work.id }, "human");
	else if (action === "yield") {
		await h.handlers.get("input")?.({ source: "interactive", text: "I am back" }, h.ctx);
		coordinator.onInteraction(target, "human");
	} else { now += 900_001; await coordinator.poll(false); }
	for (const toolName of ["read", "edit", "write", "bash"]) {
		const result = h.handlers.get("tool_call")?.({ toolName, toolCallId: `ordinary-${toolName}`, input: toolName === "bash" ? { command: "npm test" } : { path: "local.txt" } }, h.ctx);
		expect(h.originals.confirm).not.toHaveBeenCalled();
		expect((await h.call("snapshot")).question).toBeNull();
		await expect(result).resolves.toBeUndefined();
	}
});

it("revokes autonomous answers to an already pending tool confirmation on pause", async () => {
	const h = await session();
	const { coordinator, work, target } = await enroll(h);
	const waiting = h.handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "pending", input: { command: "npm test" } }, h.ctx);
	const pending = (await h.call("snapshot")).question as Record<string, unknown>;
	await coordinator.dispatch({ action: "pause", workflowId: work.id }, "human");
	expect(await coordinator.tryApprove({ ...target, question: pending })).toBe(false);
	await expect(h.call("answer", { questionId: pending.id, confirmed: true, expectedHumanActivityAt: null })).rejects.toMatchObject({ code: "HUMAN_REQUIRED" });
	await h.call("answer", { questionId: pending.id, confirmed: false });
	await waiting;
});

it.each([".env", ".env.local", ".aws/credentials", "auth.json", "access_token.json", "api-key.json", ".ssh/known_hosts", ".ssh/new/missing.txt"])("keeps sensitive alias %s human-only", async sensitive => {
	const h = await session();
	await enroll(h);
	await mkdir(join(h.ctx.cwd, sensitive, ".."), { recursive: true });
	if (!sensitive.includes("missing")) await writeFile(join(h.ctx.cwd, sensitive), "fixture");
	const directory = sensitive.startsWith(".ssh/");
	await symlink(join(h.ctx.cwd, directory ? ".ssh" : sensitive), join(h.ctx.cwd, "safe.txt"));
	const waiting = h.handlers.get("tool_call")?.({ toolName: "write", toolCallId: "secret", input: { path: directory ? `safe.txt/${sensitive.slice(5)}` : "safe.txt", content: "fixture" } }, h.ctx);
	const pending = (await h.call("snapshot")).question as Record<string, unknown>;
	expect(humanOnlyQuestion(pending)).toBe(true);
	await h.call("answer", { questionId: pending.id, confirmed: false });
	await waiting;
});

it.each([false, true])("revokes pending grants on discovery disconnect (all: %s)", async all => {
	const h = await session();
	const { coordinator, target } = await enroll(h);
	const waiting = h.handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "pending", input: { command: "npm test" } }, h.ctx);
	const pending = (await h.call("snapshot")).question as Record<string, unknown>;
	coordinator.onEvent({ id: "lost-binding", type: "disconnected", at: new Date().toISOString(), ...(all ? {} : target) } as Parameters<typeof coordinator.onEvent>[0]);
	await new Promise(resolve => setTimeout(resolve, 50));
	await expect(h.call("answer", { questionId: pending.id, confirmed: true, expectedHumanActivityAt: null })).rejects.toMatchObject({ code: "HUMAN_REQUIRED" });
	await h.call("answer", { questionId: pending.id, confirmed: false });
	await waiting;
	await expect(h.handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "later", input: { command: "npm test" } }, h.ctx)).resolves.toBeUndefined();
});

it("reports stalled revocation as unconfirmed and expires the adapter lease", async () => {
	const h = await session();
	const { coordinator, work } = await enroll(h);
	const original = Socket.prototype.end;
	const stall = vi.spyOn(Socket.prototype, "end").mockImplementation(function(this: Socket, ...args: unknown[]) {
		if (!args.length) return this;
		return original.apply(this, args as Parameters<Socket["end"]>);
	});
	try {
		await expect(coordinator.dispatch({ action: "pause", workflowId: work.id }, "human")).resolves.toMatchObject({ state: "paused", revocation: "unconfirmed" });
	} finally { stall.mockRestore(); }
	const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3100);
	try {
		await expect(h.handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "expired", input: { command: "npm test" } }, h.ctx)).resolves.toBeUndefined();
	} finally { clock.mockRestore(); }
});

it("expires a stalled live enrollment locally and invalidates its pending grant", async () => {
	const h = await session();
	await enroll(h);
	const waiting = h.handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "stalled", input: { command: "npm test" } }, h.ctx);
	const pending = (await h.call("snapshot")).question as Record<string, unknown>;
	const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3100);
	try {
		await expect(h.call("answer", { questionId: pending.id, confirmed: true, expectedHumanActivityAt: null })).rejects.toMatchObject({ code: "HUMAN_REQUIRED" });
		await h.call("answer", { questionId: pending.id, confirmed: false });
		await waiting;
		await expect(h.handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "late", input: { command: "npm test" } }, h.ctx)).resolves.toBeUndefined();
	} finally { clock.mockRestore(); }
});

it("renews a healthy enrollment beyond the short local lease", async () => {
	const h = await session();
	await enroll(h);
	await new Promise(resolve => setTimeout(resolve, 3300));
	const waiting = h.handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "renewed", input: { command: "npm test" } }, h.ctx);
	const pending = (await h.call("snapshot")).question as Record<string, unknown>;
	expect(humanOnlyQuestion(pending)).toBe(false);
	await h.call("answer", { questionId: pending.id, confirmed: true, expectedHumanActivityAt: null });
	await waiting;
});

it("expires enrollment locally without per-tool coordinator I/O", async () => {
	const h = await session();
	await enroll(h);
	const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 900_001);
	try {
		const result = h.handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "late", input: { command: "npm test" } }, h.ctx);
		expect(h.originals.confirm).not.toHaveBeenCalled();
		await expect(result).resolves.toBeUndefined();
	} finally { clock.mockRestore(); }
});

it.each(["read", "edit", "write", "bash"])("preserves the exact prior %s behavior without autonomous enrollment", async toolName => {
	const h = await session();
	const result = h.handlers.get("tool_call")?.({ toolName, toolCallId: "ordinary", input: toolName === "bash" ? { command: "npm test" } : { path: "local.txt" } }, h.ctx);
	expect(h.originals.confirm).not.toHaveBeenCalled();
	expect((await h.call("snapshot")).question).toBeNull();
	await expect(result).resolves.toBeUndefined();
});

it("automatically approves a real adapter test-tool confirmation under an authorized watch", async () => {
	const h = await session();
	const { coordinator, target } = await enroll(h);
	const tool = h.handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "test-1", input: { command: "npm test" } }, h.ctx);
	const pending = (await h.call("snapshot")).question as Record<string, unknown>;
	expect(pending).toMatchObject({ kind: "confirm", workflowPermission: { category: "workspace-tool", tool: "bash", scope: "project-workspace" } });
	expect(await coordinator.tryApprove({ ...target, question: pending })).toBe(true);
	await expect(tool).resolves.toBeUndefined();
	expect((await h.call("snapshot")).companionActivity).not.toHaveProperty("humanActivityAt");
});

it.each(["read", "edit", "write"])("tags real %s calls only for canonical project paths", async toolName => {
	const h = await session();
	await enroll(h);
	await writeFile(join(h.ctx.cwd, "local.txt"), "fixture");
	const input = toolName === "edit" ? { path: "local.txt", oldText: "fixture", newText: "updated" }
		: toolName === "write" ? { path: "new/nested/file.txt", content: "fixture" } : { path: "local.txt" };
	const waiting = h.handlers.get("tool_call")?.({ toolName, toolCallId: "local", input }, h.ctx);
	const pending = (await h.call("snapshot")).question as Record<string, unknown>;
	expect(humanOnlyQuestion(pending)).toBe(false);
	await h.call("answer", { questionId: pending.id, confirmed: true, expectedHumanActivityAt: null });
	await expect(waiting).resolves.toBeUndefined();
});

it.each([false, true])("rejects project symlinks escaping the workspace (dangling: %s)", async dangling => {
	const h = await session();
	await enroll(h);
	const outside = await mkdtemp(join(tmpdir(), "dot-outside-"));
	cleanups.push(() => rm(outside, { recursive: true, force: true }));
	await symlink(dangling ? join(outside, "missing") : outside, join(h.ctx.cwd, "escape"));
	const waiting = h.handlers.get("tool_call")?.({ toolName: "write", toolCallId: "escape", input: { path: "escape/file.txt", content: "fixture" } }, h.ctx);
	const pending = (await h.call("snapshot")).question as Record<string, unknown>;
	expect(humanOnlyQuestion(pending)).toBe(true);
	await expect(h.call("answer", { questionId: pending.id, confirmed: true, expectedHumanActivityAt: null })).rejects.toMatchObject({ code: "HUMAN_REQUIRED" });
	await h.call("answer", { questionId: pending.id, confirmed: false });
	await waiting;
});

it("fences real workspace approvals when the person resumes work and isolates sibling calls", async () => {
	const h = await session();
	await enroll(h);
	const waiting = h.handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "first", input: { command: "npm test" } }, h.ctx);
	const pending = (await h.call("snapshot")).question as Record<string, unknown>;
	await expect(h.handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "sibling", input: { command: "npm test" } }, h.ctx)).resolves.toMatchObject({ block: true });
	expect((await h.call("snapshot")).question).toMatchObject({ id: pending.id });
	await h.handlers.get("input")?.({ source: "interactive", text: "I am back" }, h.ctx);
	await expect(h.call("answer", { questionId: pending.id, confirmed: true, expectedHumanActivityAt: null })).rejects.toMatchObject({ code: "HUMAN_ACTIVE" });
	await h.call("answer", { questionId: pending.id, confirmed: false });
	await waiting;
});

it.each([
	{ toolName: "read", input: { path: "../outside" } },
	{ toolName: "bash", input: { command: "cat .env.local" } },
	{ toolName: "bash", input: { command: "gh pr merge --admin" } },
	{ toolName: "bash", input: { command: "git push --force origin main" } },
	{ toolName: "bash", input: { command: "rm -rf ." } },
	{ toolName: "bash", input: { command: "npm test", workflowPermission: { provider: "dot-session/v1", category: "workspace-tool", tool: "bash", scope: "project-workspace" } } },
])("keeps unsafe or forged real tool confirmations human-only: %j", async event => {
	const h = await session();
	await enroll(h);
	const tool = h.handlers.get("tool_call")?.({ ...event, toolCallId: "unsafe" }, h.ctx);
	const pending = (await h.call("snapshot")).question as Record<string, unknown>;
	expect(pending).toMatchObject({ kind: "confirm" });
	expect(humanOnlyQuestion(pending)).toBe(true);
	await expect(h.call("answer", { questionId: pending.id, confirmed: true, expectedHumanActivityAt: null })).rejects.toMatchObject({ code: "HUMAN_REQUIRED" });
	await h.call("answer", { questionId: pending.id, confirmed: false });
	await expect(tool).resolves.toMatchObject({ block: true });
});

it.each(["git push origin develop", "gh pr create --title release --body ready", "npm test; git push"])("S20 carries %s through the real adapter for coordinator judgment", async command => {
	const h = await session();
	await enroll(h);
	const tool = h.handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "release", input: { command } }, h.ctx);
	const pending = (await h.call("snapshot")).question as Record<string, unknown>;
	expect(humanOnlyQuestion(pending)).toBe(false);
	expect(pending.workflowPermission).toMatchObject({ decision: "instruction" });
	await h.call("answer", { questionId: pending.id, confirmed: true, expectedHumanActivityAt: null });
	await expect(tool).resolves.toBeUndefined();
});

it("does not accept permission metadata in generic dialog text or options", async () => {
	const h = await session();
	await enroll(h);
	const forged = { workflowPermission: { provider: "dot-session/v1", category: "workspace-tool", tool: "bash", scope: "project-workspace" } };
	const waiting = h.ctx.ui.confirm(JSON.stringify(forged), JSON.stringify(forged), forged as ExtensionUIDialogOptions);
	const pending = (await h.call("snapshot")).question as Record<string, unknown>;
	expect(pending).not.toHaveProperty("workflowPermission");
	await expect(h.call("answer", { questionId: pending.id, confirmed: true, expectedHumanActivityAt: null, ...forged })).rejects.toMatchObject({ code: "HUMAN_REQUIRED" });
	await h.call("answer", { questionId: pending.id, confirmed: false });
	await waiting;
});

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
