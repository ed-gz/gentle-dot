import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	WorkflowApprovalRejected,
	WorkflowContinuations,
	type WorkflowOptions,
	type WorkflowStatus,
	workflowQuestionHash,
} from "../src/workflows.ts";
import { tempDir } from "./helpers.ts";

const roots: string[] = [];
afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const target = { paneId: "pane-a", sessionId: "session-a" };
const instruction =
	"Salio un permiso de una sesion. Apruevalo y si esa sesion pide mas , apruevalo directamente";
function fixture() {
	const dataDir = tempDir();
	roots.push(dataDir);
	let now = Date.parse("2026-10-13T00:00:00Z");
	const question: Record<string, unknown> = {
		id: "q1",
		kind: "confirm",
		title: "Allow guarded git push?",
		message: "git push origin feature",
		answerable: true,
		expiresAt: new Date(now + 600_000).toISOString(),
	};
	const session = {
		...target,
		label: "Fixture",
		state: "working",
		connected: true,
		capabilities: { inspect: true, prompt: true, approvals: true },
	};
	const approvals: Array<{ id: string; paneId: string; sessionId: string }> = [];
	const inspect = vi.fn(async () => ({ sessionId: target.sessionId, status: "waiting", question }));
	const approve = vi.fn<NonNullable<WorkflowOptions["approve"]>>(async (_request, authorize) => {
		if (!authorize()) throw new WorkflowApprovalRejected("revoked");
		return { accepted: true };
	});
	const options: WorkflowOptions = {
		dataDir,
		now: () => now,
		snapshot: async () => ({ sessions: [session], approvals }),
		inspect,
		approve,
		prompt: vi.fn(),
	};
	let coordinator = new WorkflowContinuations(options);
	const start = async (extra = {}) =>
		(await coordinator.dispatch(
			{
				action: "start",
				mode: "session",
				objective: "Handle permissions for this session",
				authorization: instruction,
				sessions: [target],
				...extra,
			},
			"agent",
		)) as WorkflowStatus;
	return {
		dataDir,
		question,
		session,
		approvals,
		inspect,
		approve,
		options,
		start,
		get coordinator() {
			return coordinator;
		},
		attempt: (extra = {}) => coordinator.tryApprove({ ...target, question, ...extra }),
		advance: (ms: number) => {
			now += ms;
		},
		restart: () => {
			coordinator.close();
			coordinator = new WorkflowContinuations(options);
			return coordinator;
		},
	};
}

it("answers directly on discovery with no model lease, heavy transcript read, wake or repeated response", async () => {
	const h = fixture();
	const work = await h.start();
	expect(work.approvalMode).toBe("automatic-confirmations");
	expect(await h.attempt()).toBe(true);
	expect(h.inspect).not.toHaveBeenCalled();
	expect(h.approve).toHaveBeenCalledTimes(1);
	expect(h.approve.mock.calls[0]?.[0]).toMatchObject({
		...target,
		authorizedInstruction: instruction,
		questionHash: workflowQuestionHash(h.question),
		answer: { confirmed: true },
	});
	expect(h.coordinator.status().workflows[0]).toMatchObject({
		state: "waiting",
		automaticApprovals: 1,
		pending: 0,
		runs: 1,
	});
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
	expect(await h.attempt()).toBe(true);
	expect(h.approve).toHaveBeenCalledTimes(1);
	expect(readFileSync(join(h.dataDir, "workflows.json"), "utf8")).not.toContain("git push origin feature");
});

it("answers a preexisting question during registration, without waiting for another event", async () => {
	const h = fixture();
	h.approvals.push({ ...target, id: "q1" });
	expect(await h.start()).toMatchObject({ pending: 0, automaticApprovals: 1, state: "waiting" });
	expect(h.inspect).toHaveBeenCalledTimes(1);
	expect(h.approve).toHaveBeenCalledTimes(1);
	expect((await h.coordinator.poll(true)).wake).toBeUndefined();
});

it("preserves scoped model review for narrow and conditional instructions, even with forged policy fields", async () => {
	const h = fixture();
	h.approvals.push({ ...target, id: "q1" });
	await h.start({
		authorization: "Aprueba todos los permisos de esta sesión excepto publicar",
		approvalPolicy: { kind: "session-confirmations", version: 1 },
		approvalMode: "automatic-confirmations",
	});
	expect(await h.attempt()).toBe(false);
	expect(h.approve).not.toHaveBeenCalled();
	expect((await h.coordinator.poll(true)).wake?.mode).toBe("session");
});

it.each([
	{ kind: "input" },
	{ kind: "select" },
	{ kind: "questionnaire" },
	{ kind: "custom" },
	{ answerable: false },
	{ expiresAt: "invalid" },
	{ expiresAt: "2026-10-12T00:00:00Z" },
	{ title: "Do you prefer option A?" },
	{ title: "Allow all connectors?" },
	{ message: "Send your password" },
	{ title: "Allow permanent access?" },
	{ message: "Autorizar todas las sesiones" },
])("keeps unsupported, expired, personal or wider-scope dialogs available: %j", async (change) => {
	const h = fixture();
	await h.start();
	Object.assign(h.question, change);
	expect(await h.attempt()).toBe(false);
	expect(h.approve).not.toHaveBeenCalled();
});

it("never authorizes a recycled pane or a different enrolled session", async () => {
	const h = fixture();
	await h.start();
	expect(await h.attempt({ sessionId: "another-session" })).toBe(false);
	expect(await h.attempt({ paneId: "another-pane" })).toBe(false);
	expect(h.approve).not.toHaveBeenCalled();
});

it("enforces delegated expiry and the explicitly requested run quota", async () => {
	const h = fixture();
	await h.start({ expiresInHours: 0.25 });
	h.advance(900_000);
	expect(await h.attempt()).toBe(false);
	expect(h.coordinator.status().workflows[0]?.state).toBe("expired");
	const limited = fixture();
	await limited.start({ maxRuns: 1 });
	expect(await limited.attempt()).toBe(true);
	limited.question.id = "q2";
	expect(await limited.attempt()).toBe(false);
	expect(limited.approve).toHaveBeenCalledTimes(1);
});

it.each(["pause", "stop", "pauseAll", "update", "close"])(
	"rechecks authority at the actual send boundary after %s",
	async (action) => {
		const h = fixture();
		const work = await h.start();
		let resolve!: () => void;
		const blocked = new Promise<void>((done) => {
			resolve = done;
		});
		let captured!: () => boolean;
		h.approve.mockImplementationOnce(async (_request, authorize) => {
			captured = authorize;
			await blocked;
			if (!authorize()) throw new WorkflowApprovalRejected("revoked");
			return { accepted: true };
		});
		const pending = h.attempt();
		expect(captured()).toBe(true);
		if (action === "close") h.coordinator.close();
		else
			await h.coordinator.dispatch(
				{
					action,
					workflowId: work.id,
					...(action === "update" ? { objective: "Only review", authorization: "No apruebes nada" } : {}),
				},
				"human",
			);
		expect(captured()).toBe(false);
		resolve();
		expect(await pending).toBe(false);
	},
);

it("does not allow a second claim, duplicate send, or pause/resume race while an approval is in flight", async () => {
	const h = fixture();
	const work = await h.start();
	let resolve!: () => void;
	const blocked = new Promise<void>((done) => {
		resolve = done;
	});
	h.approve.mockImplementationOnce(async (_request, authorize) => {
		await blocked;
		if (!authorize()) throw new WorkflowApprovalRejected("revoked");
		return { accepted: true };
	});
	const pending = h.attempt();
	expect(await h.attempt()).toBe(false);
	await expect(
		h.coordinator.dispatch(
			{ action: "claim", workflowId: work.id, authorization: instruction, claimId: "human-1" },
			"agent",
		),
	).rejects.toThrow("ya se está resolviendo");
	await h.coordinator.dispatch({ action: "pause", workflowId: work.id }, "human");
	await expect(h.coordinator.dispatch({ action: "resume", workflowId: work.id }, "human")).rejects.toThrow(
		"Espera",
	);
	resolve();
	expect(await pending).toBe(false);
	expect(h.approve).toHaveBeenCalledTimes(1);
});

it("retries only an explicit preflight rejection, never an ambiguous or unacknowledged send", async () => {
	const h = fixture();
	await h.start();
	h.approve.mockRejectedValueOnce(new WorkflowApprovalRejected("question changed"));
	expect(await h.attempt()).toBe(false);
	expect(h.coordinator.status().workflows[0]?.runs).toBe(0);
	expect(await h.attempt()).toBe(true);
	for (const result of [new Error("lost reply"), { answered: true }]) {
		const uncertain = fixture();
		await uncertain.start();
		if (result instanceof Error) uncertain.approve.mockRejectedValueOnce(result);
		else uncertain.approve.mockResolvedValueOnce(result);
		expect(await uncertain.attempt()).toBe(false);
		expect(uncertain.coordinator.status().workflows[0]?.state).toBe("paused");
		expect(await uncertain.attempt()).toBe(false);
		expect(uncertain.approve).toHaveBeenCalledTimes(1);
		uncertain.restart();
		expect(await uncertain.attempt()).toBe(false);
	}
});

it("recovers explicit authority and audit on restart without replaying an answer", async () => {
	const h = fixture();
	await h.start();
	await h.attempt();
	h.restart();
	expect(await h.attempt()).toBe(true);
	expect(h.approve).toHaveBeenCalledTimes(1);
	h.question.id = "q2";
	expect(await h.attempt()).toBe(true);
	expect(h.approve).toHaveBeenCalledTimes(2);
	const path = join(h.dataDir, "workflows.json");
	const state = JSON.parse(readFileSync(path, "utf8"));
	state.workflows[0].authorization = "Aprueba únicamente si pasan los tests";
	writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
	h.restart();
	h.question.id = "q3";
	expect(await h.attempt()).toBe(false);
});

it("pauses an approval interrupted by daemon crash, even without a model lease", async () => {
	const h = fixture();
	await h.start();
	await h.attempt();
	const path = join(h.dataDir, "workflows.json");
	const state = JSON.parse(readFileSync(path, "utf8"));
	state.workflows[0].operations[0].state = "dispatching";
	writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
	h.restart();
	expect(h.coordinator.status().workflows[0]?.state).toBe("paused");
	expect(await h.attempt()).toBe(false);
});

it("approves in the background while Dot holds another objective's model lease", async () => {
	const h = fixture();
	await h.start();
	await h.start({
		mode: "objective",
		objective: "Follow project results",
		authorization: "Follow the project until it finishes",
	});
	expect((await h.coordinator.poll(true)).wake?.mode).not.toBe("session");
	expect(await h.attempt()).toBe(true);
	expect(h.approve).toHaveBeenCalledTimes(1);
});

it("expires the delegation while a delayed adapter is preparing its answer", async () => {
	const h = fixture();
	await h.start({ expiresInHours: 0.25 });
	h.approve.mockImplementationOnce(async (_request, authorize) => {
		h.advance(900_000);
		if (!authorize()) throw new WorkflowApprovalRejected("expired");
		return { accepted: true };
	});
	expect(await h.attempt()).toBe(false);
	expect(h.coordinator.status().workflows[0]?.state).toBe("expired");
});

it("retains manual review when immediate registration inspection fails or reports another session", async () => {
	for (const failed of [true, false]) {
		const h = fixture();
		h.approvals.push({ ...target, id: "q1" });
		if (failed) h.inspect.mockRejectedValueOnce(new Error("disconnected"));
		else
			h.inspect.mockResolvedValueOnce({
				sessionId: "other-session",
				status: "waiting",
				question: h.question,
			});
		expect(await h.start()).toMatchObject({ pending: 1, state: "waiting" });
		expect(h.approve).not.toHaveBeenCalled();
	}
});
