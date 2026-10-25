import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	WorkflowApprovalRejected,
	WorkflowContinuations,
	type WorkflowOptions,
	type WorkflowStatus,
	type WorkflowWake,
	workflowQuestionHash,
} from "../src/workflows.ts";
import { tempDir } from "./helpers.ts";

const roots: string[] = [];
afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
	const dataDir = tempDir();
	roots.push(dataDir);
	let now = Date.parse("2026-10-11T00:00:00Z");
	const sessions = ["a", "b"].map((id) => ({
		paneId: `pane-${id}`,
		sessionId: `session-${id}`,
		label: id,
		state: "idle",
		connected: true,
		activityInstanceId: `adapter-${id}`,
		capabilities: { inspect: true, prompt: true, approvals: true, activityFence:1 },
		assistantMessageId: `old-${id}`,
	}));
	const inspect = vi.fn(
		async (_pane: string, sessionId: string): Promise<unknown> => ({
			sessionId,
			status: "idle",
			messages: [{ role: "assistant", content: "PRIVATE_TRANSCRIPT" }],
		}),
	);
	const prompt = vi.fn(
		async (_pane: string, _session: string, _text: string, authorize: () => boolean): Promise<unknown> => {
			if (!authorize()) throw new Error("revoked");
			return { accepted: true };
		},
	);
	const approve = vi.fn<NonNullable<WorkflowOptions["approve"]>>(async (_request, authorize) => {
		if (!authorize()) throw new Error("revoked");
		return { answered: true };
	});
	const approvals: Array<{ id: string; paneId: string; sessionId: string }> = [];
	const options: WorkflowOptions = {
		dataDir,
		now: () => now,
		snapshot: async () => ({ sessions, approvals }),
		inspect,
		prompt,
		approve,
	};
	let coordinator = new WorkflowContinuations(options);
	const start = async (extra = {}) =>
		(await coordinator.dispatch(
			{
				action: "start",
				objective: "Que A prepare y B valide el resultado",
				authorization:
					"Trabaja con A y B hasta entregar el resultado. Resuelve las decisiones del proyecto y sus permisos.",
				sessions: sessions.map(({ paneId, sessionId }) => ({ paneId, sessionId })),
				...extra,
			},
			"agent",
		)) as WorkflowStatus;
	return {
		dataDir,
		sessions,
		inspect,
		prompt,
		approve,
		approvals,
		options,
		start,
		get coordinator() {
			return coordinator;
		},
		restart: () => {
			coordinator.close();
			coordinator = new WorkflowContinuations(options);
			return coordinator;
		},
		advance: (ms: number) => {
			now += ms;
		},
		event: (index: number, id = `done-${index}`) => {
			const session = sessions[index];
			if (!session) throw new Error("Missing fixture");
			session.state = "idle";
			session.assistantMessageId = id;
			return coordinator.onEvent({
				id,
				at: new Date(now).toISOString(),
				type: "completed",
				paneId: session.paneId,
				sessionId: session.sessionId,
				assistantMessageId: id,
			});
		},
	};
}
it("yields to personal input once, ignores watch prompts, and only resumes on a human answer", async () => {
 const h = fixture();
 const question = vi.fn<NonNullable<WorkflowOptions["askContinuation"]>>();
 h.options.askContinuation = question;
 const work = await h.start({sessions:[h.sessions[0]]});
 const target = h.sessions[0]!;
 h.coordinator.onInteraction(target, "workflow");
 expect(h.coordinator.status().workflows[0]?.state).toBe("waiting");
 h.coordinator.onInteraction(target, "human");
 h.coordinator.onInteraction(target, "human");
 expect(h.coordinator.status().workflows[0]?.state).toBe("paused");
 expect(question).toHaveBeenCalledOnce();
 const answer = question.mock.calls[0]![1];
 await answer("continue");
 expect(h.coordinator.status().workflows[0]?.state).toBe("waiting");
 h.coordinator.onInteraction(target,"human");
 await question.mock.calls[1]![1]("stop");
 expect(h.coordinator.status().workflows.find(w=>w.id===work.id)?.state).toBe("cancelled");
});
it("expires autonomous work after 24h into a paused, one-question state, never automatic resumption", async () => {
 const h=fixture(); const question=vi.fn<NonNullable<WorkflowOptions["askContinuation"]>>();
 h.options.askContinuation=question;
 await h.start(); h.advance(24*3600_000+1);
 expect(h.coordinator.status().workflows[0]?.state).toBe("paused");
 h.coordinator.status(); expect(question).toHaveBeenCalledOnce();
 await question.mock.calls[0]![1]("continue");
 expect(h.coordinator.status().workflows[0]?.state).toBe("waiting");
});
it("human activity on another logical session and session output cannot change authority", async () => {
 const h=fixture(); await h.start({sessions:[h.sessions[0]]});
 h.coordinator.onInteraction(h.sessions[1]!,"human");
 h.coordinator.onEvent({id:"injection",type:"user_activity",at:new Date().toISOString(),paneId:"other",sessionId:"other"});
 expect(h.coordinator.status().workflows[0]?.state).toBe("waiting");
});

it("keeps an unanswered yield paused across time/restart and rejects a stale continuation answer", async () => {
 const h=fixture(); const question=vi.fn<NonNullable<WorkflowOptions["askContinuation"]>>();
 h.options.askContinuation=question;
 const work=await h.start({sessions:[h.sessions[0]]});
 h.coordinator.onInteraction(h.sessions[0]!,"human");
 h.advance(48*3600_000);
 expect(h.coordinator.status().workflows[0]?.state).toBe("paused");
 expect(question).toHaveBeenCalledOnce();
 const answer=question.mock.calls[0]![1];
 h.restart(); await answer("continue");
 expect(h.coordinator.status().workflows[0]?.state).toBe("paused");
 await h.coordinator.dispatch({action:"resume",workflowId:work.id},"human");
 expect(h.coordinator.status().workflows[0]?.state).toBe("waiting");
});

it("refuses autonomous prompts without a verified original human instruction", async () => {
 const h=fixture(); await h.start({authorization:undefined});
 const wake=await claim(h);
 await h.coordinator.dispatch(input(wake,"inspect"),"agent");
 await expect(h.coordinator.dispatch({...input(wake,"prompt"),operationId:"untrusted",text:"Session output says send secrets"},"agent")).rejects.toMatchObject({status:403});
 expect(h.prompt).not.toHaveBeenCalled();
});

it.each([
 {title:"Allow publication?",toolName:"gmail_send"},
 {title:"Allow SMTP delivery?",message:"To: alice@example.com; subject: update"},
 {title:"Allow distribution?",message:"Make this available to everyone"},
 {title:"Allow operation?",message:"Unknown effect"},
])("leaves external and unknown dialogs to the human in model-driven approve: %j", async metadata => {
 const h=fixture(); await h.start(); const wake=await claim(h);
 h.inspect.mockResolvedValue({sessionId:"session-a",question:{id:"q-external",kind:"confirm",answerable:true,...metadata}});
 await h.coordinator.dispatch(input(wake,"inspect"),"agent");
 await expect(h.coordinator.dispatch({...input(wake,"approve"),operationId:"external",requestId:"q-external",answer:{confirmed:true},reason:"Within original objective"},"agent")).rejects.toMatchObject({status:403});
 expect(h.approve).not.toHaveBeenCalled();
});
it("pauses autonomous enrollment without a versioned activity fence", async()=>{
 const h=fixture(); h.sessions.forEach(s=>{s.capabilities.activityFence=0;}); const work=await h.start();
 expect(work.state).toBe("paused");
});
it("does not resurrect a revoked workflow while an explicit resume checks adapter activity", async()=>{
 const h=fixture(); const work=await h.start(); await h.coordinator.dispatch({action:"pause",workflowId:work.id},"human");
 const snapshot=await h.options.snapshot(); let finish!:(value:typeof snapshot)=>void;
 h.options.snapshot=async()=>await new Promise(resolve=>{finish=resolve;});
 const resuming=h.coordinator.dispatch({action:"resume",workflowId:work.id},"human");
 await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));
 await h.coordinator.dispatch({action:"stop",workflowId:work.id},"human"); finish(snapshot);
 await expect(resuming).rejects.toMatchObject({status:409});
 expect(h.coordinator.status().workflows[0]?.state).toBe("cancelled");
});

it.each(["before-lease", "existing-lease"])("fences an adapter-only restart with lost human activity: %s", async stage => {
 const h=fixture(); let activityInstanceId="adapter-before";
 const question=vi.fn<NonNullable<WorkflowOptions["askContinuation"]>>();
 h.options.askContinuation=question;
 h.options.snapshot=async()=>({sessions:h.sessions.map(s=>({...s,activityInstanceId}))});
 await h.start();
 const wake=stage === "existing-lease" ? await claim(h) : undefined;
 if(wake) await h.coordinator.dispatch(input(wake,"inspect"),"agent");
 // The adapter lost an unobserved human edit and reset its marker to null.
 activityInstanceId="adapter-after";
 if(wake) await expect(h.coordinator.dispatch({...input(wake,"prompt"),operationId:"after-restart",text:"Continue"},"agent")).rejects.toMatchObject({status:409});
 else expect((await h.coordinator.poll(true)).wake).toBeUndefined();
 expect(h.coordinator.status().workflows[0]?.state).toBe("paused");
 await h.coordinator.poll(true); await h.coordinator.prepare();
 expect(question).toHaveBeenCalledOnce(); expect(h.prompt).not.toHaveBeenCalled();
});

it("cannot treat an adapter restart with a reset personal marker as proof of no interaction", async()=>{
 const h=fixture(); let activityInstanceId="adapter-before";
 h.options.snapshot=async()=>({sessions:h.sessions.map(s=>({...s,activityInstanceId}))});
 await h.start(); activityInstanceId="adapter-after"; h.restart();
 expect((await h.coordinator.poll(true)).wake).toBeUndefined();
 expect(h.coordinator.status().workflows[0]?.state).toBe("paused");
});

it("persists activity across daemon restart and yields before granting a recovered lease", async()=>{
 const h=fixture(); let humanActivityAt:string|undefined;
 h.options.snapshot=async()=>({sessions:h.sessions.map(s=>({...s,humanActivityAt,capabilities:{...s.capabilities,activityFence:1 as const}}))});
 const work=await h.start(); expect(work.state).toBe("waiting");
 humanActivityAt="2026-10-11T00:00:01.000Z"; h.advance(2000); h.restart();
 await h.coordinator.prepare();
 expect((await h.coordinator.poll(true)).wake).toBeUndefined();
 expect(h.coordinator.status().workflows[0]?.state).toBe("paused");
});

const input = (wake: WorkflowWake, action: string, index = 0) => ({
	action,
	workflowId: wake.workflowId,
	leaseId: wake.leaseId,
	paneId: wake.sessions[index]?.paneId,
	sessionId: wake.sessions[index]?.sessionId,
});
async function claim(h: ReturnType<typeof fixture>) {
	// Discovery is independent of reserving the model turn.
	await h.coordinator.prepare();
	const wake = (await h.coordinator.poll(true)).wake;
	expect(wake).toBeDefined();
	if (!wake) throw new Error("Missing wake");
	return wake;
}

it("keeps an objective alive through six stopped turns and reacts to a later result without idle wakes", async () => {
	const h = fixture();
	await h.start();
	for (let interruption = 0; interruption < 6; interruption++) {
		const wake = await claim(h);
		await h.coordinator.dispatch(
			{ action: "acknowledge", leaseId: wake.leaseId, outcome: "interrupted" },
			"agent",
		);
		expect(h.coordinator.status().workflows[0]?.state).toBe("waiting");
		expect((await h.coordinator.poll(true)).wake).toBeUndefined();
		h.advance(15_001);
	}
	const resumed = await claim(h);
	expect(resumed.objective).toContain("Que A prepare");
	await h.coordinator.dispatch(
		{ action: "acknowledge", leaseId: resumed.leaseId, outcome: "settled" },
		"agent",
	);
	for (let idlePoll = 0; idlePoll < 3; idlePoll++) {
		h.advance(30_001);
		expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	}
	expect(h.event(1, "result-after-six-stops")).toBe(true);
	const later = await claim(h);
	expect(later.workflowId).toBe(resumed.workflowId);
	expect(later.reasons).toEqual(["Resultado disponible: pane-b"]);
	expect(h.prompt).not.toHaveBeenCalled();
	expect(h.approve).not.toHaveBeenCalled();
});
it("persists a stopped turn's readiness delay and invalidates its lease across restart", async () => {
	const h = fixture();
	await h.start();
	const stopped = await claim(h);
	await h.coordinator.dispatch(
		{ action: "acknowledge", leaseId: stopped.leaseId, outcome: "interrupted" },
		"agent",
	);
	h.advance(14_999);
	expect(h.restart().status().workflows[0]).toMatchObject({ state: "waiting", runs: 1, pending: 1 });
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	await expect(h.coordinator.dispatch(input(stopped, "inspect"), "agent")).rejects.toThrow(
		"ya no está autorizada",
	);
	h.advance(1);
	const resumed = await claim(h);
	expect(resumed.workflowId).toBe(stopped.workflowId);
	expect(resumed.leaseId).not.toBe(stopped.leaseId);
	expect(resumed.reasons).toEqual(stopped.reasons);
	expect(resumed.authorizedInstruction).toBe(stopped.authorizedInstruction);
});
it("does not expand scope or an explicit run limit when a turn is stopped, and keeps other work available", async () => {
	const h = fixture();
	const limited = await h.start({ sessions: [h.sessions[0]], maxRuns: 1 });
	const stopped = await claim(h);
	await h.coordinator.dispatch(
		{ action: "acknowledge", leaseId: stopped.leaseId, outcome: "interrupted" },
		"agent",
	);
	expect(h.event(1, "unrelated-result")).toBe(false);
	const other = await h.start({ sessions: [h.sessions[1]] });
	h.advance(15_000);
	const otherWake = await claim(h);
	expect(otherWake.workflowId).toBe(other.id);
	await h.coordinator.dispatch(
		{ action: "acknowledge", leaseId: otherWake.leaseId, outcome: "settled" },
		"agent",
	);
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	expect(h.coordinator.status().workflows.find((work) => work.id === limited.id)).toMatchObject({
		state: "paused",
		runs: 1,
		maxRuns: 1,
		sessions: [expect.objectContaining({ sessionId: "session-a" })],
	});
});
it("tracks only explicitly enrolled sessions, coalesces both completions and stays quiet after settlement", async () => {
	const h = fixture();
	expect(h.event(0)).toBe(false);
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	await h.start();
	const initial = await claim(h);
	await h.coordinator.dispatch(
		{ action: "acknowledge", leaseId: initial.leaseId, outcome: "settled" },
		"agent",
	);
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	expect(h.event(0, "a-new")).toBe(true);
	expect(h.event(1, "b-new")).toBe(true);
	h.event(0, "a-new");
	const wake = await claim(h);
	expect(wake.reasons).toHaveLength(2);
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	await h.coordinator.dispatch({ action: "acknowledge", leaseId: wake.leaseId, outcome: "settled" }, "agent");
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
});
it("persists pending identities across restart without saving inspected conversations", async () => {
	const h = fixture();
	await h.start();
	const first = await claim(h);
	await h.coordinator.dispatch(input(first, "inspect"), "agent");
	await h.coordinator.dispatch(
		{ action: "acknowledge", leaseId: first.leaseId, outcome: "settled" },
		"agent",
	);
	h.event(0, "durable-result");
	h.restart();
	const next = await claim(h);
	expect(next.reasons.join(" ")).toContain("pane-a");
	expect(readFileSync(join(h.dataDir, "workflows.json"), "utf8")).not.toContain("PRIVATE_TRANSCRIPT");
});
it("recovers missed completion only for an existing workflow's known session and baseline", async () => {
	const h = fixture();
	await h.start();
	const first = await claim(h);
	await h.coordinator.dispatch(
		{ action: "acknowledge", leaseId: first.leaseId, outcome: "settled" },
		"agent",
	);
	const session = h.sessions[0];
	if (!session) throw new Error("Missing fixture");
	session.assistantMessageId = "completed-while-daemon-off";
	h.restart();
	expect((await claim(h)).reasons.join(" ")).toContain("recuperado");
});
it("requires exact scope and a fresh idle inspection; journal makes repeated prompts idempotent", async () => {
	const h = fixture();
	await h.start();
	const wake = await claim(h);
	const prompt = { ...input(wake, "prompt"), text: "Validar", operationId: "call-1" };
	await expect(h.coordinator.dispatch(prompt, "agent")).rejects.toThrow("Inspecciona");
	await expect(
		h.coordinator.dispatch({ ...input(wake, "inspect"), sessionId: "other" }, "agent"),
	).rejects.toThrow("no está incluida");
	await h.coordinator.dispatch(input(wake, "inspect"), "agent");
	await h.coordinator.dispatch(prompt, "agent");
	await expect(h.coordinator.dispatch(prompt, "agent")).resolves.toMatchObject({ duplicate: true });
	expect(h.prompt).toHaveBeenCalledOnce();
	await expect(h.coordinator.dispatch({ ...prompt, text: "Cambió" }, "agent")).rejects.toThrow("cambió");
	await expect(
		h.coordinator.dispatch({ ...input(wake, "update"), objective: "Otro objetivo" }, "agent"),
	).rejects.toThrow("ampliar");
});
it("pauses ambiguous sends durably and never replays them on restart or agent resume", async () => {
	const h = fixture();
	await h.start();
	const wake = await claim(h);
	await h.coordinator.dispatch(input(wake, "inspect"), "agent");
	h.prompt.mockRejectedValueOnce(new Error("Response lost after send"));
	await expect(
		h.coordinator.dispatch({ ...input(wake, "prompt"), operationId: "lost", text: "Go" }, "agent"),
	).rejects.toThrow("No se pudo confirmar");
	expect(h.restart().status().workflows[0]?.state).toBe("paused");
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	await expect(
		h.coordinator.dispatch({ action: "resume", workflowId: wake.workflowId }, "agent"),
	).rejects.toThrow("Sólo la persona");
	expect(h.prompt).toHaveBeenCalledOnce();
});
it("revokes a leased inspection and all prompts immediately when the human stops", async () => {
	const h = fixture();
	await h.start();
	const wake = await claim(h);
	let finish: ((value: unknown) => void) | undefined;
	h.inspect.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const reading = h.coordinator.dispatch(input(wake, "inspect"), "agent");
	await h.coordinator.dispatch({ action: "pauseAll" }, "human");
	finish?.({ sessionId: "session-a", status: "idle" });
	await expect(reading).rejects.toThrow("ya no está autorizada");
	await expect(
		h.coordinator.dispatch({ ...input(wake, "prompt"), operationId: "stale", text: "Go" }, "agent"),
	).rejects.toThrow();
	expect(h.prompt).not.toHaveBeenCalled();
});
it("passes a revocable authority callback to the actual prompt dispatch", async () => {
	const h = fixture();
	await h.start();
	const wake = await claim(h);
	await h.coordinator.dispatch(input(wake, "inspect"), "agent");
	h.prompt.mockImplementationOnce(async (_pane, _session, _text, authorize) => {
		await h.coordinator.dispatch({ action: "pauseAll" }, "human");
		expect(authorize()).toBe(false);
		throw new Error("Rejected before mutation");
	});
	await expect(
		h.coordinator.dispatch({ ...input(wake, "prompt"), text: "Go", operationId: "late" }, "agent"),
	).rejects.toThrow();
	expect(h.coordinator.status().workflows[0]?.state).toBe("paused");
});
it("bounds automatic retries, lease lifetime, expiry and authorized run count", async () => {
	const h = fixture();
	await h.start();
	for (let attempt = 0; attempt < 3; attempt++) {
		const wake = await claim(h);
		await h.coordinator.dispatch({ action: "acknowledge", leaseId: wake.leaseId, outcome: "error" }, "agent");
		expect((await h.coordinator.poll(true)).wake).toBeUndefined();
		h.advance(60_000);
	}
	expect(h.coordinator.status().workflows[0]?.state).toBe("failed");
	const limited = fixture();
	await limited.start({ maxRuns: 1, expiresInHours: 24 });
	const wake = await claim(limited);
	await limited.coordinator.dispatch(
		{ action: "acknowledge", leaseId: wake.leaseId, outcome: "settled" },
		"agent",
	);
	limited.event(0);
	expect((await limited.coordinator.poll(true)).wake).toBeUndefined();
	expect(limited.coordinator.status().workflows[0]?.state).toBe("paused");
	limited.advance(24 * 3600_000);
	expect(limited.coordinator.status().workflows[0]?.state).toBe("paused");
});
it("rejects overlapping enrollment, stale sessions and disabled prompt capabilities", async () => {
	const h = fixture();
	await h.start();
	await expect(h.start()).rejects.toThrow("otro seguimiento");
	const other = fixture();
	const session = other.sessions[0];
	if (!session) throw new Error("Missing fixture");
	session.capabilities.prompt = false;
	await expect(other.start()).rejects.toThrow("no permite");
	await expect(other.start({ sessions: [{ paneId: "pane-a", sessionId: "wrong" }] })).rejects.toThrow(
		"no está conectada",
	);
});
it("does not claim corrupt state and stops in memory when durable storage fails", async () => {
	const h = fixture();
	await h.start();
	const wake = await claim(h);
	writeFileSync(join(h.dataDir, "workflows.json"), "{}", { mode: 0o600 });
	expect(h.restart().status().error).toBeDefined();
	await expect(h.coordinator.poll(true)).rejects.toThrow();
	const other = fixture();
	await other.start();
	rmSync(other.dataDir, { recursive: true });
	writeFileSync(other.dataDir, "Not a directory");
	await expect(other.coordinator.dispatch({ action: "pauseAll" }, "human")).rejects.toThrow("guardar");
	expect(other.coordinator.status().workflows[0]?.state).toBe("paused");
	expect(wake.leaseId).toBeTruthy();
});

it("cancels permanently and rejects a start that was in flight when the human stopped everything", async () => {
	const h = fixture();
	const work = await h.start();
	await h.coordinator.dispatch({ action: "stop", workflowId: work.id }, "human");
	expect(h.coordinator.status().workflows[0]?.state).toBe("cancelled");
	await expect(h.coordinator.dispatch({ action: "resume", workflowId: work.id }, "human")).rejects.toThrow();
	let finish: ((value: Awaited<ReturnType<WorkflowOptions["snapshot"]>>) => void) | undefined;
	h.options.snapshot = () =>
		new Promise((resolve) => {
			finish = resolve;
		});
	const starting = h.start();
	await h.coordinator.dispatch({ action: "pauseAll" }, "human");
	finish?.({ sessions: h.sessions });
	await expect(starting).rejects.toThrow("antes de registrarlo");
	expect(h.coordinator.status().workflows).toHaveLength(1);
});

it("does not resurrect a cancelled workflow when an in-flight send later fails", async () => {
	const h = fixture();
	await h.start();
	const wake = await claim(h);
	await h.coordinator.dispatch(input(wake, "inspect"), "agent");
	let reject: ((error: Error) => void) | undefined;
	h.prompt.mockImplementationOnce(
		() =>
			new Promise((_resolve, fail) => {
				reject = fail;
			}),
	);
	const sending = h.coordinator.dispatch(
		{ ...input(wake, "prompt"), text: "Go", operationId: "cancel-race" },
		"agent",
	);
	await h.coordinator.dispatch({ action: "stop", workflowId: wake.workflowId }, "human");
	reject?.(new Error("Cancelled before send"));
	await expect(sending).rejects.toThrow();
	expect(h.coordinator.status().workflows[0]?.state).toBe("cancelled");
	expect(h.restart().status().workflows[0]?.state).toBe("cancelled");
});

it("retains an early completion received before prompt acknowledgment and can continue the next step", async () => {
	const h = fixture();
	await h.start();
	const first = await claim(h);
	await h.coordinator.dispatch(input(first, "inspect"), "agent");
	h.prompt.mockImplementationOnce(async () => {
		h.event(0, "very-fast-result");
		return { accepted: true };
	});
	await h.coordinator.dispatch(
		{ ...input(first, "prompt"), text: "Step one", operationId: "step-one" },
		"agent",
	);
	await h.coordinator.dispatch(
		{ action: "acknowledge", leaseId: first.leaseId, outcome: "settled" },
		"agent",
	);
	const next = await claim(h);
	await h.coordinator.dispatch(input(next, "inspect"), "agent");
	await h.coordinator.dispatch(
		{ ...input(next, "prompt"), text: "Step two", operationId: "step-two" },
		"agent",
	);
	expect(h.prompt).toHaveBeenCalledTimes(2);
});

it("retains bounded terminal history, records pruning, and reloads its own state above the former 1 MiB limit", async () => {
	const h = fixture();
	await h.start();
	const path = join(h.dataDir, "workflows.json");
	const stored = JSON.parse(readFileSync(path, "utf8"));
	const baseline = stored.workflows[0];
	stored.workflows = Array.from({ length: 32 }, (_, i) => ({
		...baseline,
		id: `old-${i}`,
		state: "completed",
		pending: [],
		operations: Array.from({ length: 128 }, (_item, index) => ({
			id: `${index}-${"x".repeat(200)}`,
			hash: "a".repeat(64),
			state: "sent",
			at: baseline.createdAt,
		})),
	}));
	writeFileSync(path, JSON.stringify(stored));
	expect(Buffer.byteLength(readFileSync(path))).toBeGreaterThan(1024 * 1024);
	expect(h.restart().status().error).toBeUndefined();
	for (let i = 0; i < 34; i++) {
		const work = await h.start();
		await h.coordinator.dispatch({ action: "stop", workflowId: work.id }, "human");
	}
	expect(h.coordinator.status().workflows).toHaveLength(64);
	expect(h.coordinator.status().archived).toBe(2);
	expect(Buffer.byteLength(readFileSync(path))).toBeLessThanOrEqual(4 * 1024 * 1024);
	expect(h.restart().status()).toMatchObject({ archived: 2 });
	expect(h.coordinator.status().error).toBeUndefined();
});

it("recovers an engine-only restart without reusing the old lease or retrying immediately", async () => {
	const h = fixture();
	await h.start();
	const old = await claim(h);
	await h.coordinator.dispatch(
		{ action: "recoverEngine", engineId: "new-engine", startedAt: h.options.now?.() },
		"agent",
	);
	await expect(h.coordinator.dispatch(input(old, "inspect"), "agent")).rejects.toThrow(
		"ya no está autorizada",
	);
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	h.advance(15_000);
	const next = await claim(h);
	expect(next.leaseId).not.toBe(old.leaseId);
	expect(h.prompt).not.toHaveBeenCalled();
	await expect(
		h.coordinator.dispatch({ action: "recoverEngine", engineId: "stale-engine", startedAt: 0 }, "agent"),
	).rejects.toThrow("motor anterior");
	await h.coordinator.dispatch(input(next, "inspect"), "agent");
});

it("bounds the action journal across many turns within the renewable 24h window", async () => {
	const h = fixture();
	const work = await h.start();
	expect(work.expiresAt).toBe("2026-10-12T00:00:00.000Z");
	expect(work).not.toHaveProperty("maxRuns");
	for (let index = 0; index < 140; index++) {
		const wake = await claim(h);
		expect(wake.authorizedInstruction).toContain("Trabaja con A y B");
		await h.coordinator.dispatch(input(wake, "inspect"), "agent");
		await h.coordinator.dispatch(
			{ ...input(wake, "prompt"), operationId: `step-${index}`, text: `Paso ${index}` },
			"agent",
		);
		await h.coordinator.dispatch(
			{ action: "acknowledge", leaseId: wake.leaseId, outcome: "settled" },
			"agent",
		);
		h.advance(60_000);
		h.event(0, `result-${index}`);
		if (index === 70) h.restart();
	}
	expect(h.prompt).toHaveBeenCalledTimes(140);
	expect(h.restart().status().workflows[0]).toMatchObject({ state: "waiting", runs: 140 });
	const stored = JSON.parse(readFileSync(join(h.dataDir, "workflows.json"), "utf8"));
	expect(stored.workflows[0].operations.length).toBeLessThanOrEqual(72);
	await claim(h);
});

it("retains explicit limits across restart and rejects malformed optional limits", async () => {
	const h = fixture();
	const work = await h.start({ maxRuns: 2, expiresInHours: 2 });
	expect(h.restart().status().workflows[0]).toMatchObject({ expiresAt: work.expiresAt, maxRuns: 2 });
	h.advance(2 * 3600_000);
	expect(h.coordinator.status().workflows[0]?.state).toBe("paused");
	for (const invalid of [
		{ maxRuns: null },
		{ expiresInHours: null },
		{ maxRuns: -1 },
		{ expiresInHours: NaN },
	]) {
		await expect(fixture().start(invalid)).rejects.toThrow("plazo");
	}
});

it("wakes once for permissions, missed new requests, disconnection and reconnection of enrolled sessions", async () => {
	const h = fixture();
	const session = h.sessions[0];
	if (!session) throw new Error("Missing fixture");
	await h.start();
	const settle = async () => {
		const wake = await claim(h);
		await h.coordinator.dispatch(
			{ action: "acknowledge", leaseId: wake.leaseId, outcome: "settled" },
			"agent",
		);
		return wake;
	};
	await settle();
	const event = {
		id: "question-event",
		at: new Date(h.options.now?.() ?? 0).toISOString(),
		type: "attention",
		paneId: "pane-a",
		sessionId: "session-a",
		requestId: "request-a",
	};
	expect(h.coordinator.onEvent({ ...event, sessionId: "unrelated" })).toBe(false);
	session.state = "blocked";
	const approval = { id: "request-a", paneId: "pane-a", sessionId: "session-a" };
	h.approvals.push(approval);
	expect(h.coordinator.onEvent(event)).toBe(true);
	expect((await settle()).reasons).toEqual(["Permiso pendiente: pane-a"]);
	h.coordinator.onEvent(event);
	h.advance(30_000);
	// A snapshot of the same permission is not another reason to wake.
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	h.advance(30_000);
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	approval.id = "request-b";
	h.restart();
	expect((await settle()).reasons).toContain("Permiso pendiente: pane-a");
	session.connected = false;
	h.advance(30_000);
	await h.coordinator.prepare();
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	expect(h.coordinator.status().workflows[0]?.state).toBe("paused");
	h.advance(30_000);
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	session.connected = true;
	h.advance(30_000);
	expect((await h.coordinator.poll(true)).wake).toBeUndefined(); // Reconnection never renews authority.
});

const question = {
	id: "permission-a",
	workflowPermission: {provider:"dot-session/v1",category:"workspace-tool",scope:"project-workspace",tool:"read"},
	kind: "confirm",
	title: "Validar el resultado preparado",
	message: "PRIVATE_PERMISSION_DETAILS",
	answerable: true,
	expiresAt: "2026-10-11T01:00:00Z",
};
const permission = (wake: WorkflowWake, extra = {}) => ({
	...input(wake, "approve"),
	requestId: question.id,
	operationId: "permission-operation",
	answer: { confirmed: true },
	reason: "Validar el resultado preparado cumple el objetivo encargado.",
	...extra,
});

it("keeps a session delegated after a stopped turn with a confirmed answer, without replaying it", async () => {
	const h = fixture();
	const target = h.sessions[0];
	if (!target) throw new Error("Missing session");
	target.state = "blocked";
	h.approvals.push({ id: question.id, paneId: target.paneId, sessionId: target.sessionId });
	h.inspect.mockResolvedValue({ sessionId: target.sessionId, status: "blocked", question });
	await h.start({ mode: "session", sessions: [target] });
	const stopped = await claim(h);
	await h.coordinator.dispatch(input(stopped, "inspect"), "agent");
	await h.coordinator.dispatch(permission(stopped), "agent");
	await h.coordinator.dispatch(
		{ action: "acknowledge", leaseId: stopped.leaseId, outcome: "interrupted" },
		"agent",
	);
	// An adapter may briefly keep the answered card in its snapshot. Stop must not replay it.
	expect(h.restart().status().workflows[0]).toMatchObject({ state: "waiting", pending: 0 });
	h.advance(30_001);
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	expect(h.approve).toHaveBeenCalledOnce();
	await expect(h.coordinator.dispatch(permission(stopped), "agent")).rejects.toThrow("ya no está autorizada");
	h.approvals[0] = { id: "next-permission", paneId: target.paneId, sessionId: target.sessionId };
	h.advance(30_001);
	const later = await claim(h);
	expect(later.workflowId).toBe(stopped.workflowId);
	expect(later.sessions).toEqual(stopped.sessions);
	h.inspect.mockResolvedValue({
		sessionId: target.sessionId,
		status: "blocked",
		question: { ...question, id: "next-permission" },
	});
	await h.coordinator.dispatch(input(later, "inspect"), "agent");
	await h.coordinator.dispatch(
		permission(later, { requestId: "next-permission", operationId: "next-operation" }),
		"agent",
	);
	expect(h.approve).toHaveBeenCalledTimes(2);
});

it("isolates an ambiguous in-flight answer when stopped, while another objective remains available", async () => {
	const h = fixture();
	const target = h.sessions[0];
	if (!target) throw new Error("Missing session");
	target.state = "blocked";
	h.approvals.push({ id: question.id, paneId: target.paneId, sessionId: target.sessionId });
	h.inspect.mockResolvedValue({ sessionId: target.sessionId, status: "blocked", question });
	await h.start({ mode: "session", sessions: [target] });
	const stopped = await claim(h);
	await h.coordinator.dispatch(input(stopped, "inspect"), "agent");
	let rejectReply: ((error: Error) => void) | undefined;
	h.approve.mockImplementationOnce(
		() =>
			new Promise((_resolve, reject) => {
				rejectReply = reject;
			}),
	);
	const sending = h.coordinator.dispatch(permission(stopped), "agent");
	const rejected = expect(sending).rejects.toThrow("No se pudo confirmar");
	await vi.waitFor(() => expect(rejectReply).toBeTypeOf("function"));
	await h.coordinator.dispatch(
		{ action: "acknowledge", leaseId: stopped.leaseId, outcome: "interrupted" },
		"agent",
	);
	rejectReply?.(new Error("Stopped before a delivery receipt arrived"));
	await rejected;
	expect(h.restart().status().workflows[0]?.state).toBe("paused");
	h.advance(30_001);
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	expect(h.approve).toHaveBeenCalledOnce();
	const other = await h.start({ sessions: [h.sessions[1]] });
	expect((await claim(h)).workflowId).toBe(other.id);
	expect(h.coordinator.status().workflows.find((work) => work.id === stopped.workflowId)?.state).toBe(
		"paused",
	);
});

it.each([
	["git push origin develop", true], ["git push origin develop", false],
	["gh pr create --title release --body ready", true], ["gh pr create --title release --body ready", false],
])("S20 hands %s and its instruction to coordinator review (authorized=%s)", async (command, authorized) => {
	const h = fixture();
	const target = h.sessions[0]!;
	const authorization = authorized ? "Autoriza PRs y push a develop para el release" : "Sólo pruebas locales; no PRs ni push a develop";
	const dialog = { ...question, title: "Allow bash in this project?", message: JSON.stringify({ command }), workflowPermission: { provider: "dot-session/v1", category: "workspace-tool", scope: "project-workspace", tool: "bash", decision: "instruction" } };
	h.approvals.push({ id: dialog.id, paneId: target.paneId, sessionId: target.sessionId });
	h.inspect.mockResolvedValue({ sessionId: target.sessionId, status: "blocked", question: dialog });
	await h.start({ mode: "session", sessions: [target], authorization });
	expect(h.approve).not.toHaveBeenCalled(); // No fast-path external approvals.
	const wake = await claim(h);
	expect(wake.authorizedInstruction).toBe(authorization);
	const inspected = await h.coordinator.dispatch(input(wake, "inspect"), "agent");
	expect(inspected).toMatchObject({ question: { message: JSON.stringify({ command }), workflowPermission: { decision: "instruction" } } });
	// Stand-in coordinator decision: positive only for the matching instruction.
	// Natural-language interpretation belongs to the model, not a second regex policy.
	await h.coordinator.dispatch(permission(wake, { answer: { confirmed: authorized }, reason: authorized ? "PRs y develop están autorizados" : "La instrucción excluye PRs y develop" }), "agent");
	expect(h.approve.mock.calls[0]?.[0]).toMatchObject({ authorizedInstruction: authorization, answer: { confirmed: authorized } });
});

it("binds an approval to the exact inspected request, objective and verified human instruction", async () => {
	const h = fixture();
	await h.start();
	const wake = await claim(h);
	await expect(h.coordinator.dispatch(permission(wake), "agent")).rejects.toThrow("Inspecciona");
	h.inspect.mockResolvedValue({ sessionId: "session-a", status: "blocked", question });
	await h.coordinator.dispatch(input(wake, "inspect"), "agent");
	await expect(h.coordinator.dispatch(permission(wake, { requestId: "another" }), "agent")).rejects.toThrow(
		"solicitud concreta",
	);
	await h.coordinator.dispatch(permission(wake), "agent");
	await expect(h.coordinator.dispatch(permission(wake), "agent")).resolves.toMatchObject({ duplicate: true });
	expect(h.approve).toHaveBeenCalledOnce();
	expect(h.approve.mock.calls[0]?.[0]).toMatchObject({
		workflowId: wake.workflowId,
		objective: wake.objective,
		authorizedInstruction: wake.authorizedInstruction,
		paneId: "pane-a",
		sessionId: "session-a",
		requestId: question.id,
		questionHash: workflowQuestionHash(question),
		answer: { confirmed: true },
	});
	const stored = readFileSync(join(h.dataDir, "workflows.json"), "utf8");
	expect(stored).not.toContain("PRIVATE_PERMISSION_DETAILS");
	expect(stored).not.toContain("PRIVATE_TRANSCRIPT");
	expect(workflowQuestionHash({ ...question, message: "changed" })).not.toBe(workflowQuestionHash(question));
});

it("rejects stale inspections, blanket answers and legacy workflows without a verified human instruction", async () => {
	const h = fixture();
	await h.start();
	const wake = await claim(h);
	h.inspect.mockResolvedValue({ sessionId: "session-a", status: "blocked", question });
	await h.coordinator.dispatch(input(wake, "inspect"), "agent");
	await expect(
		h.coordinator.dispatch(permission(wake, { answer: { grant: true } }), "agent"),
	).rejects.toThrow("respuesta concreta");
	h.advance(60_001);
	await expect(h.coordinator.dispatch(permission(wake), "agent")).rejects.toThrow("Inspecciona");
	expect(h.approve).not.toHaveBeenCalled();
	const legacy = fixture();
	await legacy.start({ authorization: undefined });
	const old = await claim(legacy);
	legacy.inspect.mockResolvedValue({ sessionId: "session-a", status: "blocked", question });
	await legacy.coordinator.dispatch(input(old, "inspect"), "agent");
	await expect(legacy.coordinator.dispatch(permission(old), "agent")).rejects.toThrow(
		"instrucción humana verificable",
	);
	expect(legacy.approve).not.toHaveBeenCalled();
});

it("invalidates an in-flight approval on human stop and never retries an ambiguous answer after restart", async () => {
	const h = fixture();
	await h.start();
	const wake = await claim(h);
	h.inspect.mockResolvedValue({ sessionId: "session-a", status: "blocked", question });
	await h.coordinator.dispatch(input(wake, "inspect"), "agent");
	h.approve.mockImplementationOnce(async (_request, authorize) => {
		await h.coordinator.dispatch({ action: "stop", workflowId: wake.workflowId }, "human");
		expect(authorize()).toBe(false);
		throw new Error("Stopped before answer");
	});
	await expect(h.coordinator.dispatch(permission(wake), "agent")).rejects.toThrow("No se pudo confirmar");
	expect(h.restart().status().workflows[0]?.state).toBe("cancelled");
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	const lost = fixture();
	await lost.start();
	const next = await claim(lost);
	lost.inspect.mockResolvedValue({ sessionId: "session-a", status: "blocked", question });
	await lost.coordinator.dispatch(input(next, "inspect"), "agent");
	lost.approve.mockRejectedValueOnce(new Error("Answer acknowledged but HTTP reply lost"));
	await expect(lost.coordinator.dispatch(permission(next), "agent")).rejects.toThrow("No se pudo confirmar");
	expect(lost.restart().status().workflows[0]?.state).toBe("paused");
	expect(lost.approve).toHaveBeenCalledOnce();
	expect((await lost.coordinator.poll(true)).wake).toBeUndefined();
});

it("invalidates the old lease and authority when the objective changes without a new verified instruction", async () => {
	const h = fixture();
	const work = await h.start();
	const old = await claim(h);
	await h.coordinator.dispatch(
		{ action: "update", workflowId: work.id, objective: "Un objetivo distinto" },
		"human",
	);
	await expect(h.coordinator.dispatch(input(old, "inspect"), "agent")).rejects.toThrow(
		"ya no está autorizada",
	);
	const updated = await claim(h);
	expect(updated.authorizedInstruction).toBeUndefined();
	h.inspect.mockResolvedValue({ sessionId: "session-a", status: "blocked", question });
	await h.coordinator.dispatch(input(updated, "inspect"), "agent");
	await expect(h.coordinator.dispatch(permission(updated), "agent")).rejects.toThrow(
		"instrucción humana verificable",
	);
	await h.coordinator.dispatch(
		{
			action: "update",
			workflowId: work.id,
			objective: "Objetivo confirmado",
			authorization: "Realiza el objetivo confirmado y resuelve sus permisos concretos.",
		},
		"human",
	);
	const confirmed = await claim(h);
	expect(confirmed.authorizedInstruction).toContain("objetivo confirmado");
});

it("can reinspect after a provably rejected approval without pausing or replaying an uncertain answer", async () => {
	const h = fixture();
	await h.start();
	const wake = await claim(h);
	h.inspect.mockResolvedValue({ sessionId: "session-a", status: "blocked", question });
	await h.coordinator.dispatch(input(wake, "inspect"), "agent");
	h.approve.mockRejectedValueOnce(new WorkflowApprovalRejected("La solicitud cambió antes del envío.", 409));
	await expect(h.coordinator.dispatch(permission(wake), "agent")).rejects.toThrow("cambió antes");
	expect(h.coordinator.status().workflows[0]?.state).toBe("running");
	await expect(h.coordinator.dispatch(permission(wake), "agent")).rejects.toThrow("Inspecciona");
	await h.coordinator.dispatch(input(wake, "inspect"), "agent");
	await h.coordinator.dispatch(permission(wake), "agent");
	expect(h.approve).toHaveBeenCalledTimes(2);
});

it("resumes from a verified human chat instruction while preserving the original objective authority", async () => {
	const h = fixture();
	const work = await h.start();
	const initial = await claim(h);
	await h.coordinator.dispatch({ action: "pause", workflowId: work.id }, "human");
	for (const authorization of [undefined, ""]) {
		await expect(
			h.coordinator.dispatch({ action: "resume", workflowId: work.id, authorization }, "agent"),
		).rejects.toThrow();
	}
	expect(h.coordinator.status().workflows[0]?.state).toBe("paused");
	await h.coordinator.dispatch(
		{ action: "resume", workflowId: work.id, authorization: "Continúa con el objetivo que te encargué." },
		"agent",
	);
	expect(h.coordinator.status().workflows[0]).toMatchObject({
		state: "waiting",
		lastMessage: expect.stringContaining("desde el chat"),
	});
	const resumed = await claim(h);
	expect(resumed.authorizedInstruction).toBe(initial.authorizedInstruction);
	expect(resumed.leaseId).not.toBe(initial.leaseId);
	expect(h.prompt).not.toHaveBeenCalled();
	await expect(
		h.coordinator.dispatch(
			{ action: "resume", workflowId: work.id, authorization: "Continúa", leaseId: resumed.leaseId },
			"agent",
		),
	).rejects.toThrow("Sólo la persona");
	await expect(
		h.coordinator.dispatch({ action: "resume", workflowId: work.id, authorization: "Continúa" }, "agent"),
	).rejects.toThrow("Sólo la persona");
});

it("can adopt a verified resume for legacy work, but never overrides explicit exhausted limits", async () => {
	const legacy = fixture();
	const old = await legacy.start({ authorization: undefined });
	await legacy.coordinator.dispatch({ action: "pause", workflowId: old.id }, "human");
	await legacy.coordinator.dispatch(
		{
			action: "resume",
			workflowId: old.id,
			authorization: "Continúa este objetivo y resuelve sus permisos concretos.",
		},
		"agent",
	);
	expect((await claim(legacy)).authorizedInstruction).toContain("resuelve sus permisos");
	const bounded = fixture();
	const work = await bounded.start({ maxRuns: 1 });
	await claim(bounded);
	await bounded.coordinator.dispatch({ action: "pause", workflowId: work.id }, "human");
	await expect(
		bounded.coordinator.dispatch(
			{ action: "resume", workflowId: work.id, authorization: "Continúa" },
			"agent",
		),
	).rejects.toThrow("límite");
	expect(bounded.coordinator.status().workflows[0]?.state).toBe("paused");
});

it("shares turns fairly across continuously pending objectives and preserves ordering after restart", async () => {
	const h = fixture();
	const first = await h.start({ sessions: [{ paneId: "pane-a", sessionId: "session-a" }] });
	const second = await h.start({ sessions: [{ paneId: "pane-b", sessionId: "session-b" }] });
	const claims: string[] = [];
	for (let index = 0; index < 6; index++) {
		const wake = await claim(h);
		claims.push(wake.workflowId);
		await h.coordinator.dispatch(
			{ action: "acknowledge", leaseId: wake.leaseId, outcome: "settled" },
			"agent",
		);
		// Both remain eligible, including a new A event before every claim. Keep the same timestamp.
		h.event(0, `a-${index}`);
		h.event(1, `b-${index}`);
		if (index === 0 || index === 3) h.restart();
	}
	expect(claims).toEqual([first.id, second.id, first.id, second.id, first.id, second.id]);
	expect(h.coordinator.status().workflows.map((work) => work.runs)).toEqual([3, 3]);
});

it("preserves a full long human plan up to the chat protocol limit across restart", async () => {
	const h = fixture();
	const authorization = `Plan humano: ${"a".repeat(100_000 - "Plan humano: ".length)}`;
	await h.start({ authorization });
	h.restart();
	expect((await claim(h)).authorizedInstruction).toBe(authorization);
	await expect(fixture().start({ authorization: `${authorization}a` })).rejects.toThrow("authorization");
});

it("keeps one session delegation across task completion and restart without idle model wakes", async () => {
	const h = fixture();
	const session = h.sessions[0];
	if (!session) throw new Error("Missing fixture session");
	const delegation = await h.start({
		mode: "session",
		sessions: [session],
		objective: "Aprueba las solicitudes de esta sesión",
	});
	expect(delegation).toMatchObject({ mode: "session", state: "waiting", pending: 0 });
	expect(delegation.expiresAt).toBe("2026-10-12T00:00:00.000Z");
	expect(delegation.maxRuns).toBeUndefined();
	for (let index = 0; index < 24; index++) {
		h.advance(60_000);
		expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	}
	expect(h.inspect).not.toHaveBeenCalled();
	expect(h.prompt).not.toHaveBeenCalled();
	expect(h.event(0, "finished-task")).toBe(false);
	h.restart();
	expect(h.coordinator.status().workflows[0]).toMatchObject({
		id: delegation.id,
		mode: "session",
		state: "waiting",
		pending: 0,
	});
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	const question = { id: "request-1", answerable: true, kind: "confirm", title: "Guardar", workflowPermission: {provider:"dot-session/v1",category:"workspace-tool",scope:"project-workspace",tool:"write"} };
	h.approvals.push({ id: question.id, paneId: session.paneId, sessionId: session.sessionId });
	h.inspect.mockResolvedValue({ sessionId: session.sessionId, status: "waiting", question });
	h.advance(30_000);
	const wake = await claim(h);
	expect(wake.mode).toBe("session");
	await h.coordinator.dispatch(input(wake, "inspect"), "agent");
	await h.coordinator.dispatch(
		{
			...input(wake, "approve"),
			operationId: "approve-session",
			requestId: question.id,
			answer: { confirmed: true },
			reason: "La persona delegó las confirmaciones de esta sesión.",
		},
		"agent",
	);
	expect(h.approve).toHaveBeenCalledOnce();
	await expect(
		h.coordinator.dispatch({ action: "complete", workflowId: delegation.id }, "agent"),
	).rejects.toMatchObject({ status: 409 });
	await expect(
		h.coordinator.dispatch(
			{ ...input(wake, "prompt"), text: "Nueva tarea", operationId: "forbidden" },
			"agent",
		),
	).rejects.toMatchObject({ status: 403 });
	await h.coordinator.dispatch({ action: "acknowledge", leaseId: wake.leaseId, outcome: "settled" }, "agent");
	expect(h.coordinator.status().workflows[0]?.state).toBe("waiting");
});

it("requires verified human authority for exactly one persistent session", async () => {
	const h = fixture();
	await expect(h.start({ mode: "session" })).rejects.toMatchObject({ status: 403 });
	await expect(
		h.start({ mode: "session", sessions: [h.sessions[0]], authorization: undefined }),
	).rejects.toMatchObject({ status: 403 });
	const delegation = await h.start({ mode: "session", sessions: [h.sessions[0]] });
	await expect(
		h.coordinator.dispatch(
			{ action: "update", workflowId: delegation.id, objective: "Autoriza todo en otro equipo" },
			"agent",
		),
	).rejects.toMatchObject({ status: 403 });
	await expect(h.start({ mode: "session", sessions: [h.sessions[0]] })).rejects.toMatchObject({
		status: 409,
	});
	const selected = h.sessions[0];
	if (!selected) throw new Error("Missing fixture session");
	selected.sessionId = "new-session-in-same-pane";
	expect(
		h.coordinator.onEvent({
			id: "new-request",
			at: new Date(Date.parse("2026-10-11T00:00:00Z")).toISOString(),
			type: "attention",
			paneId: selected.paneId,
			sessionId: "new-session-in-same-pane",
			requestId: "different",
		}),
	).toBe(false);
});

it("routes approval to session delegation and task completion to its independent objective", async () => {
	const h = fixture();
	const delegation = await h.start({ mode: "session", sessions: [h.sessions[0]] });
	const objective = await h.start();
	const first = await claim(h);
	expect(first.workflowId).toBe(objective.id);
	await h.coordinator.dispatch(
		{ action: "acknowledge", leaseId: first.leaseId, outcome: "settled" },
		"agent",
	);
	const session = h.sessions[0];
	if (!session) throw new Error("Missing fixture session");
	const at = "2026-10-11T00:00:00Z";
	expect(
		h.coordinator.onEvent({
			id: "pending-approval",
			at,
			type: "attention",
			paneId: session.paneId,
			sessionId: session.sessionId,
			requestId: "approve-1",
		}),
	).toBe(true);
	let wake = await claim(h);
	expect(wake.workflowId).toBe(delegation.id);
	await h.coordinator.dispatch({ action: "acknowledge", leaseId: wake.leaseId, outcome: "settled" }, "agent");
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	h.event(0, "completed-after-approval");
	wake = await claim(h);
	expect(wake.workflowId).toBe(objective.id);
	await h.coordinator.dispatch(
		{ action: "complete", workflowId: objective.id, leaseId: wake.leaseId },
		"agent",
	);
	expect(h.coordinator.status().workflows.find((work) => work.id === delegation.id)?.state).toBe("waiting");
	await h.coordinator.dispatch({ action: "pause", workflowId: delegation.id }, "human");
	expect(
		h.coordinator.onEvent({
			id: "after-pause",
			at,
			type: "attention",
			paneId: session.paneId,
			sessionId: session.sessionId,
			requestId: "approve-2",
		}),
	).toBe(false);
	await h.coordinator.dispatch({ action: "resume", workflowId: delegation.id }, "human");
	const resumed = await claim(h);
	await h.coordinator.dispatch({ action: "stop", workflowId: delegation.id }, "human");
	await expect(h.coordinator.dispatch(input(resumed, "inspect"), "agent")).rejects.toMatchObject({
		status: 409,
	});
});

it("hands an unresolved request back to a finite objective when its session delegation is revoked", async () => {
	const h = fixture();
	const delegation = await h.start({ mode: "session", sessions: [h.sessions[0]] });
	const goal = await h.start();
	const initial = await claim(h);
	const session = h.sessions[0];
	if (!session) throw new Error("Missing fixture session");
	h.approvals.push({ id: "request-held", paneId: session.paneId, sessionId: session.sessionId });
	h.inspect.mockResolvedValue({
		sessionId: session.sessionId,
		status: "waiting",
		question: { id: "request-held", answerable: true },
	});
	expect(await h.coordinator.dispatch(input(initial, "inspect"), "agent")).toMatchObject({
		approvalDelegated: true,
	});
	await h.coordinator.dispatch(
		{ action: "acknowledge", leaseId: initial.leaseId, outcome: "settled" },
		"agent",
	);
	h.advance(30_000);
	const delegatedWake = await claim(h);
	expect(delegatedWake.workflowId).toBe(delegation.id);
	await h.coordinator.dispatch(
		{ action: "acknowledge", leaseId: delegatedWake.leaseId, outcome: "settled" },
		"agent",
	);
	await h.coordinator.dispatch({ action: "stop", workflowId: delegation.id }, "human");
	h.advance(30_000);
	const recovered = await claim(h);
	expect(recovered.workflowId).toBe(goal.id);
	expect(recovered.reasons).toContain(`Permiso pendiente: ${session.paneId}`);
});

const foreground = (workflowId: string, extra = {}) => ({
	action: "claim",
	workflowId,
	claimId: "verified-human-turn",
	authorization: "Aprueba esta solicitud y las futuras de esta sesión.",
	...extra,
});

it("claims and answers an existing session request in the human turn, without another background wake", async () => {
	const h = fixture();
	const target = h.sessions[0];
	if (!target) throw new Error("Missing session");
	target.state = "blocked";
	h.approvals.push({ id: question.id, paneId: target.paneId, sessionId: target.sessionId });
	h.inspect.mockResolvedValue({ sessionId: target.sessionId, status: "blocked", question });
	const work = await h.start({ mode: "session", sessions: [target] });
	expect(work.pending).toBe(1);
	const wake = (await h.coordinator.dispatch(foreground(work.id), "agent")) as WorkflowWake;
	expect(wake).toMatchObject({
		workflowId: work.id,
		mode: "session",
		runs: 1,
		sessions: [expect.objectContaining({ paneId: target.paneId, sessionId: target.sessionId })],
	});
	expect(wake.authorizedInstruction).toBe(
		"Trabaja con A y B hasta entregar el resultado. Resuelve las decisiones del proyecto y sus permisos.",
	);
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	expect(await h.coordinator.dispatch(foreground(work.id), "agent")).toEqual(wake);
	await expect(
		h.coordinator.dispatch(foreground(work.id, { claimId: "another-turn" }), "agent"),
	).rejects.toMatchObject({ status: 409 });
	await h.coordinator.dispatch(input(wake, "inspect"), "agent");
	await h.coordinator.dispatch(permission(wake), "agent");
	expect(h.approve).toHaveBeenCalledOnce();
	h.approvals.length = 0;
	target.state = "working";
	await h.coordinator.dispatch({ action: "acknowledge", leaseId: wake.leaseId, outcome: "settled" }, "agent");
	h.advance(31_000);
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
});

it("requires verified human evidence and an active persistent delegation for foreground claims", async () => {
	const h = fixture();
	const work = await h.start({ mode: "session", sessions: [h.sessions[0]] });
	for (const extra of [
		{ authorization: undefined },
		{ authorization: "" },
		{ claimId: undefined },
		{ leaseId: "model-invented" },
	]) {
		await expect(h.coordinator.dispatch(foreground(work.id, extra), "agent")).rejects.toThrow();
	}
	await expect(h.coordinator.dispatch(foreground(work.id), "human")).rejects.toMatchObject({ status: 403 });
	const objective = await h.start({ sessions: [h.sessions[1]] });
	await expect(h.coordinator.dispatch(foreground(objective.id), "agent")).rejects.toMatchObject({
		status: 409,
	});
	await h.coordinator.dispatch({ action: "pause", workflowId: work.id }, "human");
	await expect(h.coordinator.dispatch(foreground(work.id), "agent")).rejects.toMatchObject({ status: 409 });
	expect(h.approve).not.toHaveBeenCalled();
});

it("allows a fresh human inspection with no queued event while respecting lease exclusion and explicit limits", async () => {
	const h = fixture();
	const work = await h.start({ mode: "session", sessions: [h.sessions[0]], maxRuns: 1 });
	expect(work.pending).toBe(0);
	const objective = await h.start({ sessions: [h.sessions[1]] });
	const other = await claim(h);
	expect(other.workflowId).toBe(objective.id);
	await expect(h.coordinator.dispatch(foreground(work.id), "agent")).rejects.toMatchObject({ status: 409 });
	await h.coordinator.dispatch(
		{ action: "acknowledge", leaseId: other.leaseId, outcome: "settled" },
		"agent",
	);
	const wake = (await h.coordinator.dispatch(foreground(work.id), "agent")) as WorkflowWake;
	expect(wake.reasons).toEqual(["La persona pidió revisar ahora las solicitudes de esta sesión."]);
	expect(await h.coordinator.dispatch(foreground(work.id), "agent")).toEqual(wake);
	await h.coordinator.dispatch({ action: "acknowledge", leaseId: wake.leaseId, outcome: "settled" }, "agent");
	await expect(
		h.coordinator.dispatch(foreground(work.id, { claimId: "next-turn" }), "agent"),
	).rejects.toThrow("límite");
	expect(h.coordinator.status().workflows[0]?.runs).toBe(1);
});

it("keeps an unanswered request queued with bounded retries even when the model returns ordinary text", async () => {
	const h = fixture();
	const target = h.sessions[0];
	if (!target) throw new Error("Missing session");
	target.state = "blocked";
	h.approvals.push({ id: question.id, paneId: target.paneId, sessionId: target.sessionId });
	await h.start({ mode: "session", sessions: [target] });
	for (let attempt = 0; attempt < 3; attempt++) {
		const wake = await claim(h);
		await h.coordinator.dispatch(
			{ action: "acknowledge", leaseId: wake.leaseId, outcome: "settled" },
			"agent",
		);
		if (attempt < 2) {
			expect(h.coordinator.status().workflows[0]).toMatchObject({
				state: "waiting",
				pending: 1,
				lastMessage: expect.stringContaining("sigue pendiente"),
			});
			expect((await h.coordinator.poll(true)).wake).toBeUndefined();
			h.restart();
			h.advance(15_000 * 2 ** attempt);
		}
	}
	expect(h.coordinator.status().workflows[0]).toMatchObject({
		state: "failed",
		runs: 3,
		lastMessage: expect.stringContaining("tres revisiones"),
	});
	h.advance(3600_000);
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	expect(h.approve).not.toHaveBeenCalled();
});

it("does not retry a session request that disappeared or was answered outside Dot", async () => {
	const h = fixture();
	const target = h.sessions[0];
	if (!target) throw new Error("Missing session");
	target.state = "blocked";
	h.approvals.push({ id: question.id, paneId: target.paneId, sessionId: target.sessionId });
	await h.start({ mode: "session", sessions: [target] });
	const wake = await claim(h);
	h.approvals.length = 0;
	target.state = "idle";
	await h.coordinator.dispatch({ action: "acknowledge", leaseId: wake.leaseId, outcome: "settled" }, "agent");
	h.advance(31_000);
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	expect(h.coordinator.status().workflows[0]).toMatchObject({ state: "waiting", pending: 0 });
});

it("never resurrects a lease revoked during settlement reconciliation", async () => {
	const h = fixture();
	const work = await h.start({ mode: "session", sessions: [h.sessions[0]] });
	const wake = (await h.coordinator.dispatch(foreground(work.id), "agent")) as WorkflowWake;
	h.options.snapshot = async () => {
		await h.coordinator.dispatch({ action: "stop", workflowId: work.id }, "human");
		return { sessions: h.sessions, approvals: h.approvals };
	};
	await h.coordinator.dispatch({ action: "acknowledge", leaseId: wake.leaseId, outcome: "settled" }, "agent");
	expect(h.coordinator.status().workflows[0]).toMatchObject({ state: "cancelled", pending: 0 });
	await expect(h.coordinator.dispatch(foreground(work.id), "agent")).rejects.toMatchObject({ status: 409 });
});

it("releases into bounded retry when settlement cannot refresh the pending request", async () => {
	const h = fixture();
	const work = await h.start({ mode: "session", sessions: [h.sessions[0]] });
	const wake = (await h.coordinator.dispatch(foreground(work.id), "agent")) as WorkflowWake;
	h.options.snapshot = async () => {
		throw new Error("Fixture unavailable");
	};
	await h.coordinator.dispatch({ action: "acknowledge", leaseId: wake.leaseId, outcome: "settled" }, "agent");
	expect(h.coordinator.status().workflows[0]).toMatchObject({
		state: "waiting",
		pending: 1,
		lastMessage: expect.stringContaining("reintentará"),
	});
	await expect(h.coordinator.dispatch(input(wake, "inspect"), "agent")).rejects.toMatchObject({
		status: 409,
	});
});

it("rejects new foreground claims while an inspection is in flight and after authority expires", async () => {
	const h = fixture();
	const work = await h.start({ mode: "session", sessions: [h.sessions[0]], expiresInHours: 0.25 });
	const wake = (await h.coordinator.dispatch(foreground(work.id), "agent")) as WorkflowWake;
	h.inspect.mockImplementationOnce(async () => {
		await expect(h.coordinator.dispatch(foreground(work.id), "agent")).rejects.toMatchObject({ status: 429 });
		return { sessionId: "session-a", status: "idle" };
	});
	await h.coordinator.dispatch(input(wake, "inspect"), "agent");
	await expect(h.coordinator.dispatch(foreground(work.id), "agent", () => false)).rejects.toThrow();
	h.advance(15 * 60_000);
	await expect(h.coordinator.dispatch(foreground(work.id), "agent")).rejects.toMatchObject({ status: 409 });
});

it("requeues a waiting persistent delegation after a verified scope update", async () => {
	const h = fixture();
	const work = await h.start({ mode: "session", sessions: [h.sessions[0]] });
	expect(work.pending).toBe(0);
	await h.coordinator.dispatch(
		{
			action: "update",
			workflowId: work.id,
			objective: "Aprueba el permiso actual y los futuros",
			authorization: "Sí, aprueba esta solicitud ahora y las futuras de la sesión",
		},
		"agent",
	);
	const wake = await claim(h);
	expect(wake.reasons).toEqual(["La persona actualizó la delegación; revisa sus solicitudes pendientes."]);
	expect(wake.authorizedInstruction).toBe("Sí, aprueba esta solicitud ahora y las futuras de la sesión");
});

async function strandedDelegation() {
	const h = fixture();
	const target = h.sessions[0];
	if (!target) throw new Error("Missing session");
	target.state = "blocked";
	h.approvals.push({ id: question.id, paneId: target.paneId, sessionId: target.sessionId });
	const work = await h.start({ mode: "session", sessions: [target] });
	const path = join(h.dataDir, "workflows.json");
	const stored = JSON.parse(readFileSync(path, "utf8"));
	stored.workflows[0].pending = [];
	stored.workflows[0].lastMessage = "Dot revisó el avance; espera un nuevo resultado de las sesiones.";
	writeFileSync(path, JSON.stringify(stored));
	return { h, target, work, path, stored };
}

it("recovers an old silently stranded approval once, preserving its bounded retry budget and backoff", async () => {
	const { h, work, path, stored } = await strandedDelegation();
	stored.workflows[0].attempts = 2;
	stored.workflows[0].nextAttemptAt = (h.options.now?.() ?? 0) + 30_000;
	writeFileSync(path, JSON.stringify(stored));
	h.restart();
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	expect(h.coordinator.status().workflows[0]).toMatchObject({ id: work.id, pending: 1 });
	h.restart();
	h.advance(30_000);
	const wake = await claim(h);
	expect(wake.reasons).toEqual(["Permiso pendiente: pane-a"]);
	await h.coordinator.dispatch({ action: "acknowledge", leaseId: wake.leaseId, outcome: "settled" }, "agent");
	expect(h.coordinator.status().workflows[0]?.state).toBe("failed");
	h.advance(3600_000);
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
});

it("does not recover a stale snapshot of an approval already sent by this session delegation", async () => {
	const { h, path, stored } = await strandedDelegation();
	stored.workflows[0].operations = [
		{
			id: "answered",
			state: "sent",
			kind: "approve",
			requestId: question.id,
			hash: "fixture",
			at: new Date(h.options.now?.() ?? 0).toISOString(),
		},
	];
	stored.workflows[0].observed[JSON.stringify(["pane-a", "session-a"])].state = "working";
	writeFileSync(path, JSON.stringify(stored));
	h.restart();
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	expect(h.coordinator.status().workflows[0]).toMatchObject({ state: "waiting", pending: 0 });
	expect(h.approve).not.toHaveBeenCalled();
});

it("does not revive old permission work for an idle, replaced or revoked session", async () => {
	for (const mode of ["disappeared", "replaced", "paused"] as const) {
		const { h, target, work } = await strandedDelegation();
		h.restart();
		if (mode === "disappeared") {
			h.approvals.length = 0;
			target.state = "idle";
		} else if (mode === "replaced") target.sessionId = "different-session";
		else await h.coordinator.dispatch({ action: "pause", workflowId: work.id }, "human");
		await h.coordinator.prepare();
		const batch = await h.coordinator.poll(true);
		// Recovery cannot grant action authority to a replacement logical session.
		expect(batch.wake).toBeUndefined();
		expect(h.approve).not.toHaveBeenCalled();
	}
});

it("waits for fresh activity evidence before leasing even when recovery is slow", async () => {
	const h = fixture();
	await h.start();
	let finish!: () => void;
	const blocked = new Promise<void>(resolve => { finish = resolve; });
	h.options.snapshot = async () => {
		await blocked;
		return { sessions: h.sessions, approvals: h.approvals };
	};
	const preparing = h.coordinator.prepare();
	let settled = false;
	const polling = h.coordinator.poll(true).then(batch => { settled = true; return batch; });
	await Promise.resolve();
	expect(settled).toBe(false);
	finish();
	const batch = await polling;
	expect(batch.wake).toBeDefined();
	expect(batch.workflows[0]?.state).toBe("running");
	await preparing;
});

it("does not resurrect a revoked objective when background recovery finishes later", async () => {
	const h = fixture();
	const work = await h.start();
	await h.coordinator.dispatch({ action: "pause", workflowId: work.id }, "human");
	await h.coordinator.dispatch({ action: "resume", workflowId: work.id }, "human");
	let finish!: () => void;
	h.options.snapshot = async () => {
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
		return { sessions: [], approvals: [] };
	};
	const preparing = h.coordinator.prepare();
	await h.coordinator.dispatch({ action: "stop", workflowId: work.id }, "human");
	finish();
	await preparing;
	expect(h.coordinator.status().workflows[0]).toMatchObject({ state: "cancelled", pending: 0 });
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
});

it.each(["during", "after"])(
	"does not replace a sent instruction with a snapshot taken before it (%s dispatch)",
	async (timing) => {
		const h = fixture();
		await h.start();
		const wake = await claim(h);
		h.advance(30_001);
		let finishSnapshot!: () => void;
		const stale = structuredClone({ sessions: h.sessions, approvals: h.approvals });
		let reads = 0;
		h.options.snapshot = async () => {
			if (reads++ > 0) return structuredClone({sessions:h.sessions,approvals:h.approvals});
			await new Promise<void>((resolve) => {
				finishSnapshot = resolve;
			});
			return stale;
		};
		const recovering = h.coordinator.prepare();
		await h.coordinator.dispatch(input(wake, "inspect"), "agent");
		let finishPrompt!: () => void;
		h.prompt.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				finishPrompt = resolve;
			});
			return { accepted: true };
		});
		const sending = h.coordinator.dispatch(
			{ ...input(wake, "prompt"), text: "Continúa con la validación acordada", operationId: "next" },
			"agent",
		);
		await vi.waitFor(() => expect(finishPrompt).toBeTypeOf("function"));
		if (timing === "after") {
			finishPrompt();
			await sending;
		}
		finishSnapshot();
		await recovering;
		if (timing === "during") {
			finishPrompt();
			await sending;
		}
		const stored = JSON.parse(readFileSync(join(h.dataDir, "workflows.json"), "utf8"));
		expect(stored.workflows[0].observed[JSON.stringify(["pane-a", "session-a"])]).toMatchObject({
			state: "working",
			awaiting: true,
		});
		expect(stored.workflows[0].pending).toEqual([]);
	},
);
