import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDotSession } from "../src/extensions/dot-session.ts";
import { localRequest, record } from "../src/orchestration/herdr.ts";
import { Orchestrator, type OrchestratorOptions } from "../src/orchestration/index.ts";
import type { Manifest } from "../src/orchestration/registry.ts";
import { questionRevision } from "../src/orchestration/questions.ts";
import { sessionNotice } from "../src/session-notifications.ts";
import {
	type WorkflowApprovalRequest,
	WorkflowContinuations,
	workflowQuestionHash,
} from "../src/workflows.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

function harness(extra: Partial<OrchestratorOptions> = {}) {
	let question: Record<string, unknown> | null = null;
	let state = "idle";
	let reportedStatus: string | undefined;
	let pid = 123;
	let sessionId = "s1";
	let unavailable = false;
	let messages: Array<Record<string, unknown>> = [];
	let capabilities: Record<string, unknown> = {};
	let beforeAnswer: (() => void) | undefined;
	const manifest: Manifest = {
		version: 1,
		socketPath: "/pi.sock",
		pid: 123,
		sessionId: "s1",
		managed: true,
		binding: { terminalId: "t1", herdrSocketPath: "/herdr.sock" },
	};
	const calls: Array<{ socket: string; method: string; params: Record<string, unknown> }> = [];
	const request = async (socket: string, method: string, params: Record<string, unknown> = {}) => {
		calls.push({ socket, method, params });
		if (unavailable) throw new Error("HERDR disconnected");
		if (method === "session.snapshot")
			return {
				snapshot: {
					panes: [
						{ pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", label: "Pi", agent_status: state },
					],
				},
			};
		if (method === "pane.get") return { pane: { pane_id: "w1:p1", terminal_id: "t1" } };
		if (method === "pane.process_info") return { process_info: { foreground_processes: [{ pid }] } };
		if (method === "snapshot")
			return { sessionId, instanceId:manifest.instanceId, status: reportedStatus ?? (question ? "waiting" : state), messages, question, capabilities, ...(question && capabilities.questionBinding===1 ? {questionRevision:questionRevision(question)} : {}) };
		if (method === "answer") {
			beforeAnswer?.();
			if (params.expectedQuestionRevision && (!question || params.expectedQuestionRevision !== questionRevision(question))) throw new Error("Question changed in adapter");
			if (params.questionId !== question?.id) throw new Error("Stale question");
			question = null;
		}
		if (["workspace.create", "tab.create"].includes(method))
			return { root_pane: { pane_id: "w2:p1", terminal_id: "t2" } };
		return { accepted: true, sessionId, instanceId:manifest.instanceId };
	};
	const orchestrator = new Orchestrator({
		dataDir: "/tmp/gentle-dot-orchestration-test",
		socketPath: "/herdr.sock",
		pollMs: 0,
		orcaCommand: false,
		terminalLauncher: false,
		request,
		registry: async () => [manifest],
		...extra,
	});
	cleanups.push(() => orchestrator.close());
	return {
		orchestrator,
		calls,
		manifest,
		request,
		setQuestion: (id = "q1", fingerprint = "exact-request") => {
			question = {
				id,
				kind: "confirm",
				answerable: true,
				title: "GitHub merge",
				message: "Merge PR #42",
				action: "Merge",
				fingerprint,
				createdAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
			};
		},
		setRawQuestion: (value: Record<string, unknown>) => {
			question = value;
		},
		setBeforeAnswer: (value: () => void) => { beforeAnswer=value; },
		setCapabilities: (value: Record<string, unknown>) => {
			capabilities = value;
		},
		setState: (value: string) => {
			state = value;
		},
		setReportedStatus: (value: string) => { reportedStatus = value; },
		setMessages: (value: Array<Record<string, unknown>>) => {
			messages = value;
		},
		setPid: (value: number) => {
			pid = value;
		},
		setSession: (value: string) => {
			sessionId = value;
		},
		setUnavailable: () => {
			unavailable = true;
		},
	};
}

async function delegatedRequest(h: ReturnType<typeof harness>): Promise<WorkflowApprovalRequest> {
	const page = (await h.orchestrator.dispatch(
		{ action: "inspect", paneId: "w1:p1", sessionId: "s1" },
		"agent",
	)) as { question: Record<string, unknown> };
	return {
		workflowId: "goal",
		objective: "Merge PR #42 after review",
		authorizedInstruction: "Review and merge PR #42",
		paneId: "w1:p1",
		sessionId: "s1",
		requestId: String(page.question.id),
		questionHash: workflowQuestionHash(page.question),
		answer: { confirmed: true },
		reason: "La revisión terminó y el merge forma parte del encargo.",
	};
}

describe("HERDR orchestration authority", () => {
	it("repairs a running legacy adapter using only its bound branch and preserves pagination authority", async () => {
		const h = harness();
		const directory = await mkdtemp(join(tmpdir(), "dot-transcript-"));
		cleanups.push(() => rm(directory, { recursive: true, force: true }));
		const path = join(directory, "session.jsonl");
		Object.assign(h.manifest, { cwd: directory, sessionFile: path });
		const nonce = "67da57d9-7fbe-47b6-9187-c31109fe4eba";
		const wake = `[System-generated Gentle Agents notification, not written by the user] Subagent output was delivered to this session above. Review it and continue. [gentle-agents wake: ${nonce}]`;
		const entries = [
			{ type: "session", id: "s1", cwd: directory },
			{ type: "model_change", id: "model", parentId: null, modelId: "active-model", provider: "fixture" },
			{ type: "thinking_level_change", id: "thinking", parentId: "model", thinkingLevel: "high" },
			{
				type: "custom",
				id: "identity",
				parentId: "thinking",
				customType: "gentle-agents.wake-identity",
				data: { sessionId: "s1", nonce, text: wake },
			},
			{
				type: "message",
				id: "human",
				parentId: "identity",
				message: { role: "user", content: "Review this change" },
			},
			{
				type: "custom_message",
				id: "child",
				parentId: "human",
				display: true,
				customType: "gentle-agents.result",
				content: "The review passed",
				details: { gentleAgents: { agent: "reviewer" } },
			},
			{ type: "message", id: "wake", parentId: "child", message: { role: "user", content: wake } },
			{
				type: "custom_message",
				id: "other",
				parentId: "human",
				display: true,
				customType: "gentle-agents.result",
				content: "OTHER_BRANCH",
			},
			{
				type: "model_change",
				id: "other-model",
				parentId: "other",
				modelId: "OTHER_BRANCH",
				provider: "fixture",
			},
		];
		await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n"), { mode: 0o600 });
		h.setMessages([
			{ id: "human", role: "user", content: [{ type: "text", text: "Review this change" }] },
			{ id: "wake", role: "user", content: [{ type: "text", text: wake }] },
		]);
		const page = await h.orchestrator.dispatch(
			{ action: "inspect", paneId: "w1:p1", sessionId: "s1" },
			"human",
		);
		expect(page).toMatchObject({
			messages: [
				{ id: "human", role: "user" },
				{ id: "child", role: "assistant", provenance: { kind: "subagent", label: "reviewer" } },
			],
			metadata: {
				source: "history",
				model: { id: "active-model", provider: "fixture" },
				thinkingLevel: "high",
			},
			history: { supported: false, hasEarlier: false },
		});
		expect(JSON.stringify(page)).not.toMatch(/OTHER_BRANCH|gentle-agents wake/);
		// A replaced file from another session cannot reclassify or suppress human messages.
		entries[0] = { type: "session", id: "different", cwd: directory };
		await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n"));
		const replaced = await h.orchestrator.dispatch(
			{ action: "inspect", paneId: "w1:p1", sessionId: "s1" },
			"human",
		);
		expect(replaced).toMatchObject({ messages: [{ id: "human" }, { id: "wake", role: "user" }] });
		expect((replaced as { metadata?: unknown }).metadata).toBeUndefined();
	});

	it("recognizes a completed reply already visible in a working snapshot, without alerting old availability", async () => {
		const h = harness();
		const answer = (id: string) => [
			{ id, role: "assistant", content: [{ type: "text", text: "Resultado" }] },
		];
		h.setMessages(answer("r1"));
		await h.orchestrator.snapshot();
		h.setState("working");
		h.setMessages(answer("r2"));
		await h.orchestrator.snapshot();
		h.setState("idle");
		const completed = await h.orchestrator.snapshot();
		expect(completed.events.at(-1)).toMatchObject({
			type: "completed",
			assistantMessageId: "r2",
			resultChanged: true,
		});
		h.setState("working");
		await h.orchestrator.snapshot();
		h.setState("idle");
		const available = await h.orchestrator.snapshot();
		expect(available.events.at(-1)).toMatchObject({
			type: "completed",
			assistantMessageId: "r2",
			resultChanged: false,
		});
	});

	it("answers only the concrete inspected local question through a workflow delegation without creating a future policy", async () => {
		const h = harness();
		h.setCapabilities({activityFence:1});
		h.setRawQuestion({id:"q1",kind:"confirm",answerable:true,title:"Allow running tests?",message:"Local unit tests",workflowPermission:{provider:"dot-session/v1",category:"workspace-tool",scope:"project-workspace",tool:"bash"},expiresAt:new Date(Date.now()+600_000).toISOString()});
		const request = await delegatedRequest(h);
		await expect(h.orchestrator.answerForWorkflow(request, () => true)).resolves.toMatchObject({
			accepted: true,
		});
		expect(h.calls.filter((call) => call.method === "answer")).toEqual([
			expect.objectContaining({ params: { questionId: "q1", confirmed: true, expectedSessionId: "s1", expectedHumanActivityAt: null } }),
		]);
		expect((await h.orchestrator.snapshot()).policies).toEqual([]);
		await expect(h.orchestrator.answerForWorkflow(request, () => true)).rejects.toMatchObject({
			code: "QUESTION_CHANGED",
		});
		expect(h.calls.filter((call) => call.method === "answer")).toHaveLength(1);
	});

	it("rejects changed request content, changed sessions, and a revoked objective before answering", async () => {
		const h = harness();
		h.setQuestion();
		const request = await delegatedRequest(h);
		h.setQuestion("q1", "different-command-with-same-id");
		await expect(h.orchestrator.answerForWorkflow(request, () => true)).rejects.toMatchObject({
			code: "QUESTION_CHANGED",
		});
		h.setSession("another-session");
		await expect(h.orchestrator.answerForWorkflow(request, () => true)).rejects.toMatchObject({
			code: "SESSION_CHANGED",
		});
		await expect(h.orchestrator.answerForWorkflow(request, () => false)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(h.calls.filter((call) => call.method === "answer")).toHaveLength(0);
	});

	it("stops a delegated response if its goal is paused during the fresh request read", async () => {
		const h = harness();
		h.setQuestion();
		const input = await delegatedRequest(h);
		let valid = true;
		const orchestrator = new Orchestrator({
			dataDir: "/tmp/gentle-dot-workflow-answer-test",
			socketPath: "/herdr.sock",
			pollMs: 0,
			orcaCommand: false,
			terminalLauncher: false,
			registry: async () => [h.manifest],
			request: async (socket, method, params = {}) => {
				const result = await h.request(socket, method, params);
				if (method === "snapshot") valid = false;
				return result;
			},
		});
		cleanups.push(() => orchestrator.close());
		await expect(orchestrator.answerForWorkflow(input, () => valid)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(h.calls.filter((call) => call.method === "answer")).toHaveLength(0);
	});

	it("exposes exact select options but never turns them into a temporary automatic policy", async () => {
		const h = harness();
		h.setRawQuestion({
			id: "choose",
			title: "Approve?",
			kind: "select",
			answerable: true,
			options: [
				{ id: "x", label: "Yes, once" },
				{ id: "y", label: "No" },
			],
			fingerprint: "forged-confirm",
		});
		const page = await h.orchestrator.snapshot();
		expect(page.approvals[0]).toMatchObject({
			kind: "select",
			answerable: true,
			policyEligible: false,
			options: [
				{ id: "x", label: "Yes, once" },
				{ id: "y", label: "No" },
			],
		});
		await expect(
			h.orchestrator.dispatch(
				{
					action: "grant",
					paneId: "w1:p1",
					sessionId: "s1",
					requestId: "choose",
					expiresAt: new Date(Date.now() + 60000).toISOString(),
					maxUses: 1,
				},
				"human",
			),
		).rejects.toMatchObject({ code: "INVALID_POLICY" });
		await expect(
			h.orchestrator.dispatch(
				{ action: "answer", paneId: "w1:p1", sessionId: "s1", requestId: "choose", approved: true },
				"human",
			),
		).rejects.toMatchObject({ code: "INVALID_ANSWER" });
		await h.orchestrator.dispatch(
			{ action: "answer", paneId: "w1:p1", sessionId: "s1", requestId: "choose", optionId: "x" },
			"human",
		);
		expect(h.calls.filter((call) => call.method === "answer")[0]?.params).toMatchObject({
			questionId: "choose",
			optionId: "x",
		});
	});
	it("identifies legacy native dialogs and accepts only its advertised cooperative questionnaire", async () => {
		const h = harness();
		h.manifest.managed = false;
		h.setRawQuestion({ id: "old", kind: "select", title: "Original", answerable: false });
		expect((await h.orchestrator.snapshot()).approvals[0]).toMatchObject({
			answerable: false,
			policyEligible: false,
			unavailableReason: "legacy_connection",
		});
		await expect(
			h.orchestrator.dispatch(
				{ action: "answer", paneId: "w1:p1", sessionId: "s1", requestId: "old", optionId: "0" },
				"human",
			),
		).rejects.toMatchObject({ code: "REMOTE_UNAVAILABLE" });
		h.setRawQuestion({
			id: "form",
			kind: "questionnaire",
			title: "Original form",
			answerable: true,
			questions: [{ id: "0", question: "Pick", options: [{ label: "A" }, { label: "B" }] }],
		});
		expect((await h.orchestrator.snapshot()).approvals[0]?.answerable).toBe(false);
		h.setCapabilities({ questions: true });
		expect((await h.orchestrator.snapshot()).approvals[0]).toMatchObject({
			answerable: true,
			policyEligible: false,
		});
		await expect(
			h.orchestrator.dispatch(
				{
					action: "answer",
					paneId: "w1:p1",
					sessionId: "s1",
					requestId: "form",
					answers: [{ questionId: "0", optionIndices: [2] }],
				},
				"human",
			),
		).rejects.toMatchObject({ code: "INVALID_ANSWER" });
		await h.orchestrator.dispatch(
			{
				action: "answer",
				paneId: "w1:p1",
				sessionId: "s1",
				requestId: "form",
				answers: [{ questionId: "0", optionIndices: [1] }],
			},
			"human",
		);
		expect(h.calls.filter((call) => call.method === "answer")).toHaveLength(1);
	});

	it("projects legacy inspect activity only from the bound manifest and selected transcript branch", async () => {
		const h = harness();
		const directory = await mkdtemp(join(tmpdir(), "dot-legacy-inspect-"));
		cleanups.push(() => rm(directory, { recursive: true, force: true }));
		h.manifest.cwd = directory;
		h.manifest.sessionFile = join(directory, "session.jsonl");
		const plan = (id: string, title: string) => ({
			type: "message",
			id,
			parentId: null,
			message: {
				role: "toolResult",
				toolName: "todo",
				toolCallId: id,
				content: [{ type: "text", text: "Result" }],
				details: { gentleTodo: { tasks: [{ id: 1, title, status: "in_progress" }] } },
			},
		});
		await writeFile(
			h.manifest.sessionFile,
			`${[
				{ type: "session", id: "s1", cwd: directory },
				plan("active", "Plan de la sesión seleccionada"),
				plan("sibling", "PRIVATE_OTHER_BRANCH"),
			]
				.map((value) => JSON.stringify(value))
				.join("\n")}\n`,
			{ mode: 0o600 },
		);
		h.setMessages([{ id: "active", role: "tool", toolName: "todo", toolCallId: "active", content: [] }]);
		const inspected = await h.orchestrator.dispatch(
			{ action: "inspect", paneId: "w1:p1", sessionId: "s1", sessionFile: "/ignored.jsonl", cwd: "/ignored" },
			"human",
		);
		expect(inspected).toMatchObject({
			work: {
				version: 1,
				plan: { source: "history", total: 1, tasks: [{ title: "Plan de la sesión seleccionada" }] },
			},
		});
		expect(JSON.stringify(inspected)).not.toContain("PRIVATE_OTHER_BRANCH");
		h.setPid(999);
		await expect(
			h.orchestrator.dispatch({ action: "inspect", paneId: "w1:p1", sessionId: "s1" }, "human"),
		).rejects.toMatchObject({ code: "UNBOUND" });
	});

	it("rechecks device revocation after asynchronous binding and before sending an answer or grant", async () => {
		for (const action of ["answer", "grant"]) {
			const h = harness();
			h.setQuestion();
			let authorized = true;
			const orchestrator = new Orchestrator({
				dataDir: "/tmp/dot-revoke-test",
				pollMs: 0,
				orcaCommand: false,
				terminalLauncher: false,
				registry: async () => [h.manifest],
				request: async (socket, method, params = {}) => {
					const result = await h.request(socket, method, params);
					if (method === "snapshot") authorized = false;
					return result;
				},
			});
			cleanups.push(() => orchestrator.close());
			await expect(
				orchestrator.dispatch(
					{
						action,
						paneId: "w1:p1",
						sessionId: "s1",
						requestId: "q1",
						approved: true,
						expiresAt: new Date(Date.now() + 3600_000).toISOString(),
						maxUses: 1,
					},
					"human",
					() => authorized,
				),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(h.calls.filter((call) => call.method === "answer")).toHaveLength(0);
			expect((await orchestrator.snapshot()).policies).toHaveLength(0);
		}
	});

	it("does not launch a command when access is revoked while HERDR creates the empty pane", async () => {
		const h = harness();
		const directory = await mkdtemp(join(tmpdir(), "dot-rev-create-"));
		cleanups.push(() => rm(directory, { recursive: true, force: true }));
		let authorized = true;
		const orchestrator = new Orchestrator({
			dataDir: join(directory, "data"),
			pollMs: 0,
			orcaCommand: false,
			terminalLauncher: false,
			request: async (socket, method, params = {}) => {
				const result = await h.request(socket, method, params);
				if (method === "workspace.create") authorized = false;
				return result;
			},
		});
		cleanups.push(() => orchestrator.close());
		await expect(
			orchestrator.dispatch({ action: "create", cwd: directory }, "human", () => authorized),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(h.calls.filter((call) => call.method === "pane.send_input")).toHaveLength(0);
	});

	it("requires a bound live foreground process and exact session when sending prompts", async () => {
		const h = harness();
		expect((await h.orchestrator.snapshot()).sessions[0]?.connected).toBe(true);
		await expect(
			h.orchestrator.dispatch({ action: "prompt", paneId: "w1:p1", sessionId: "wrong", text: "go" }, "agent"),
		).rejects.toMatchObject({ code: "SESSION_CHANGED" });
		h.setPid(999);
		await expect(
			h.orchestrator.dispatch({ action: "prompt", paneId: "w1:p1", sessionId: "s1", text: "go" }, "agent"),
		).rejects.toMatchObject({ code: "UNBOUND" });
		expect(h.calls.filter((call) => call.method === "prompt")).toHaveLength(0);
	});

	it("never exposes human approvals or policy mutations to the model", async () => {
		const h = harness();
		h.setQuestion();
		for (const action of ["answer", "grant", "revoke"])
			await expect(h.orchestrator.dispatch({ action, approved: true }, "agent")).rejects.toMatchObject({
				code: "HUMAN_REQUIRED",
			});
		expect(h.calls).toHaveLength(0);
	});

	it("rejects stale approval IDs and approves the current real request once", async () => {
		const h = harness();
		h.setQuestion();
		await expect(
			h.orchestrator.dispatch(
				{ action: "answer", paneId: "w1:p1", sessionId: "s1", requestId: "old", approved: true },
				"human",
			),
		).rejects.toMatchObject({ code: "QUESTION_CHANGED" });
		const input = { action: "answer", paneId: "w1:p1", sessionId: "s1", requestId: "q1", approved: true };
		await expect(h.orchestrator.dispatch(input, "human")).resolves.toMatchObject({ accepted: true });
		await expect(h.orchestrator.dispatch(input, "human")).rejects.toMatchObject({ code: "QUESTION_CHANGED" });
		expect(h.calls.filter((call) => call.method === "answer")).toHaveLength(1);
	});

	it("binds reviewed content through the adapter and rejects replacement after daemon snapshot", async () => {
        const h=harness();h.setCapabilities({questionBinding:1});
        const question={id:'q1',kind:'confirm',answerable:true,title:'Publicar',message:'Contenido revisado',expiresAt:new Date(Date.now()+60000).toISOString()};
        h.setRawQuestion(question);const revision=questionRevision(question);const snapshot=await h.orchestrator.snapshot();
        expect(snapshot.approvals[0]?.questionRevision).toBe(revision);
        h.setBeforeAnswer(()=>h.setRawQuestion({...question,message:'Contenido cambiado'}));
        await expect(h.orchestrator.dispatch({action:'answer',paneId:'w1:p1',sessionId:'s1',requestId:'q1',approved:true,expectedQuestionRevision:revision},'human')).rejects.toThrow('Question changed in adapter');
        expect(h.calls.filter(call=>call.method==='answer').at(-1)?.params.expectedQuestionRevision).toBe(revision);
    });

	it("fences a replaced Pi instance before a session mutation reaches the adapter", async () => {
        const h=harness();h.setCapabilities({close:true});h.manifest.instanceId='new-instance';
        const snapshot=await h.orchestrator.snapshot();expect(snapshot.mutationInstanceFence).toBe(1);
        await expect(h.orchestrator.dispatch({action:'close',paneId:'w1:p1',sessionId:'s1',expectedInstanceId:'old-instance'},'human')).rejects.toMatchObject({code:'SESSION_CHANGED'});
        expect(h.calls.filter(call=>call.method==='close')).toHaveLength(0);
        await expect(h.orchestrator.dispatch({action:'close',paneId:'w1:p1',sessionId:'s1',expectedInstanceId:'new-instance'},'human')).resolves.toMatchObject({accepted:true});
        expect(h.calls.find(call=>call.method==='close')?.params.expectedInstanceId).toBe('new-instance');
    });

	it("never silently downgrades a reviewed revision on an older adapter", async () => {
        const h=harness();h.setQuestion();
        const input={action:'answer',paneId:'w1:p1',sessionId:'s1',requestId:'q1',approved:true};
        await expect(h.orchestrator.dispatch({...input,expectedQuestionRevision:'a'.repeat(64)},'human')).rejects.toMatchObject({code:'QUESTION_CHANGED'});
        expect(h.calls.filter(call=>call.method==='answer')).toHaveLength(0);
        await expect(h.orchestrator.dispatch(input,'human')).resolves.toMatchObject({accepted:true});
    });

	it("matches night grants by exact request/session and consumes a bounded number of uses", async () => {
		const h = harness();
		h.setQuestion();
		await h.orchestrator.dispatch(
			{
				action: "grant",
				paneId: "w1:p1",
				sessionId: "s1",
				requestId: "q1",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
				maxUses: 1,
			},
			"human",
		);
		h.setQuestion("other", "different-command");
		expect((await h.orchestrator.snapshot()).approvals).toHaveLength(1);
		expect(h.calls.filter((call) => call.method === "answer")).toHaveLength(0);
		h.setQuestion("same-again");
		expect((await h.orchestrator.snapshot()).approvals).toHaveLength(0);
		h.setQuestion("third");
		expect((await h.orchestrator.snapshot()).approvals).toHaveLength(1);
		expect(h.calls.filter((call) => call.method === "answer")).toHaveLength(1);
	});

	it("fails closed for expired, revoked and overlong grants", async () => {
		const h = harness();
		h.setQuestion();
		const grant = { action: "grant", paneId: "w1:p1", sessionId: "s1", requestId: "q1", maxUses: 10 };
		for (const expiresAt of [
			new Date(Date.now() - 1).toISOString(),
			new Date(Date.now() + 13 * 3600_000).toISOString(),
		])
			await expect(h.orchestrator.dispatch({ ...grant, expiresAt }, "human")).rejects.toMatchObject({
				code: "INVALID_POLICY",
			});
		const result = (await h.orchestrator.dispatch(
			{ ...grant, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
			"human",
		)) as { policy: { id: string } };
		await h.orchestrator.dispatch({ action: "revoke", policyId: result.policy.id }, "human");
		expect((await h.orchestrator.snapshot()).approvals).toHaveLength(1);
		expect(h.calls.filter((call) => call.method === "answer")).toHaveLength(0);
	});

	it.each(["confirm", "select", "questionnaire", "input", "editor"])("classifies %s attention and defers completion until its dialog resolves", async kind => {
		const h = harness();
		h.setState("working");
		await h.orchestrator.snapshot();
		h.setState("idle");
		// Older adapters can report idle even while a resolvable dialog exists.
		h.setReportedStatus("idle");
		h.setRawQuestion({id:"phone-dialog",kind,title:"x".repeat(200),answerable:true,
			...(kind === "select" ? {options:[{id:"yes",label:"Continuar"}]} : {}),
			...(kind === "questionnaire" ? {questions:[{id:"q",question:"Pick",options:[{label:"A"},{label:"B"}]}]} : {})});
		const pending = await h.orchestrator.snapshot();
		expect(pending.events.filter(event => event.type === "completed")).toHaveLength(0);
		expect(pending.events.filter(event => event.type === "attention")).toEqual([expect.objectContaining({requestId:"phone-dialog",dialogKind:kind === "confirm" ? "permission" : "question",dialogTitle:"x".repeat(160)})]);
		await h.orchestrator.snapshot();
		await h.orchestrator.dispatch({action:"answer",paneId:"w1:p1",sessionId:"s1",requestId:"phone-dialog",...(kind === "confirm" ? {approved:true} : kind === "select" ? {optionId:"yes"} : kind === "questionnaire" ? {answers:[{questionId:"q",optionIndices:[0]}]} : {text:"ok"})}, "human");
		const finished = await h.orchestrator.snapshot();
		expect(finished.events.filter(event => event.type === "completed")).toHaveLength(1);
		expect((await h.orchestrator.snapshot()).events.filter(event => event.type === "completed")).toHaveLength(1);
	});

	it("notifies completion and attention once, and reports disconnect honestly", async () => {
		const h = harness();
		h.setState("working");
		await h.orchestrator.snapshot();
		h.setState("idle");
		await h.orchestrator.snapshot();
		h.setQuestion();
		await h.orchestrator.snapshot();
		const snapshot = await h.orchestrator.snapshot();
		expect(snapshot.events.filter((event) => event.type === "completed")).toHaveLength(1);
		expect(snapshot.events.filter((event) => event.type === "attention")).toEqual([
			expect.objectContaining({ paneId: "w1:p1", sessionId: "s1", requestId: "q1" }),
		]);
		h.setUnavailable();
		expect(await h.orchestrator.snapshot()).toMatchObject({ available: false, sessions: [], approvals: [] });
	});

	it("detects a final answer between polls without replaying old transcript entries or duplicate ids", async () => {
		const h = harness();
		const message = (id: string) => ({
			id,
			role: "assistant",
			content: [{ type: "text", text: "Respuesta" }],
		});
		h.setMessages([message("old-answer")]);
		expect((await h.orchestrator.snapshot()).events).toEqual([]);
		// Both sampled states are idle: the complete short run happened between polling intervals.
		h.setMessages([message("old-answer"), message("new-answer")]);
		const fresh = await h.orchestrator.snapshot();
		expect(fresh.sessions[0]?.assistantMessageId).toBe("new-answer");
		expect(fresh.events).toEqual([
			expect.objectContaining({ type: "completed", assistantMessageId: "new-answer", sessionId: "s1" }),
		]);
		expect((await h.orchestrator.snapshot()).events).toHaveLength(1);
		// A transcript without IDs uses the existing working → idle fallback only.
		h.setMessages([{ role: "assistant", content: [] }]);
		expect((await h.orchestrator.snapshot()).events).toHaveLength(1);
		h.setState("working");
		await h.orchestrator.snapshot();
		h.setState("idle");
		const legacy = await h.orchestrator.snapshot();
		expect(legacy.events).toHaveLength(2);
		expect(legacy.events.at(-1)).not.toHaveProperty("assistantMessageId");
	});

	it("detects the first short reply to an empty observed session without requiring old assistant text", async () => {
		const h = harness();
		await h.orchestrator.snapshot();
		h.setMessages([{ id: "first-answer", role: "assistant", content: [{ type: "text", text: "Listo" }] }]);
		expect((await h.orchestrator.snapshot()).events).toEqual([
			expect.objectContaining({ type: "completed", assistantMessageId: "first-answer" }),
		]);
	});

	it("does not attach the prior task's answer id to an unfinished new human request", async () => {
		const h = harness();
		h.setMessages([{ id: "old-answer", role: "assistant", content: [] }]);
		await h.orchestrator.snapshot();
		h.setMessages([
			{ id: "old-answer", role: "assistant", content: [] },
			{ id: "new-user", role: "user", content: [] },
		]);
		h.setState("working");
		await h.orchestrator.snapshot();
		h.setState("idle");
		const page = await h.orchestrator.snapshot();
		expect(page.events).toHaveLength(1);
		expect(page.events[0]).not.toHaveProperty("assistantMessageId");
	});

	it("sends a safely quoted startup command only to the newly created pane", async () => {
		const h = harness();
		const directory = await mkdtemp(join(tmpdir(), "dot-cwd-"));
		cleanups.push(() => rm(directory, { recursive: true, force: true }));
		const dataDir = await mkdtemp(join(tmpdir(), "dot-data-"));
		cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
		const orchestrator = new Orchestrator({
			dataDir,
			pollMs: 0,
			orcaCommand: false,
			terminalLauncher: false,
			request: h.request,
			registry: async () => [],
			piCommand: "/path/with 'quotes'/pi",
		});
		cleanups.push(() => orchestrator.close());
		await orchestrator.dispatch({ action: "create", cwd: directory, label: "$(unsafe)" }, "agent");
		const call = h.calls.find((entry) => entry.method === "pane.send_input");
		expect(call?.params.pane_id).toBe("w2:p1");
		expect(call?.params.text).toContain("'/path/with '\\''quotes'\\''/pi'");
		expect(h.calls.find((entry) => entry.method === "workspace.create")?.params.label).toBe("$(unsafe)");
	});
});

async function fixtureServer(
	path: string,
	handler: (request: Record<string, unknown>) => unknown,
): Promise<Server> {
	const server = createServer((socket) => {
		let data = "";
		socket.on("data", (chunk) => {
			data += chunk.toString();
			if (!data.includes("\n")) return;
			const request = JSON.parse(data.slice(0, data.indexOf("\n"))) as Record<string, unknown>;
			socket.end(`${JSON.stringify({ id: request.id, result: handler(request) })}\n`);
		});
	});
	server.listen(path);
	await once(server, "listening");
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return server;
}

describe("live Pi confirmation adapter with local socket", () => {
	it("resolves the actual local confirm from a bound remote decision and denies replay", async () => {
		const directory = await mkdtemp(join(tmpdir(), "dot-pi-"));
		cleanups.push(() => rm(directory, { recursive: true, force: true }));
		const herdr = join(directory, "herdr.sock");
		await fixtureServer(herdr, () => ({ pane: { terminal_id: "t1" } }));
		const handlers = new Map<string, (event: unknown, context: ExtensionContext) => Promise<void> | void>();
		const pi = {
			on: (event: string, handler: (event: unknown, context: ExtensionContext) => Promise<void> | void) =>
				handlers.set(event, handler),
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI;
		let nativeAborted = false;
		const context = {
			mode: "tui",
			cwd: directory,
			sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined, getBranch: () => [] },
			ui: {
				notify: vi.fn(),
				confirm: (_title: string, _message: string, options?: ExtensionUIDialogOptions) =>
					new Promise<boolean>((resolve) => {
						options?.signal?.addEventListener(
							"abort",
							() => {
								nativeAborted = true;
								resolve(false);
							},
							{ once: true },
						);
					}),
			},
			isIdle: () => true,
		} as unknown as ExtensionContext;
		const extension = createDotSession(pi, {
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: herdr,
			HERDR_PANE_ID: "w1:p1",
			GENTLE_DOT_SESSION_DIR: join(directory, "sessions"),
		});
		cleanups.push(() => extension.close());
		await handlers.get("session_start")?.({}, context);
		const filename = (await readdir(join(directory, "sessions"))).find((entry) => entry.endsWith(".json"));
		expect(filename).toBeDefined();
		const manifest = JSON.parse(
			await readFile(join(directory, "sessions", filename ?? "missing"), "utf8"),
		) as Manifest;
		const pending = context.ui.confirm("Push commits", "git push origin feature");
		const page = await localRequest(manifest.socketPath, "snapshot", {
			expectedSessionId: "s1",
			expectedInstanceId: manifest.instanceId,
		});
		expect(record(page.question) && page.question.answerable).toBe(true);
		const request = {
			expectedInstanceId: manifest.instanceId,
			expectedSessionId: "s1",
			questionId: record(page.question) ? page.question.id : "",
			confirmed: true,
		};
		await expect(
			localRequest(manifest.socketPath, "answer", { ...request, expectedSessionId: "wrong" }),
		).rejects.toMatchObject({ code: "SESSION_CHANGED" });
		await localRequest(manifest.socketPath, "answer", request);
		await expect(pending).resolves.toBe(true);
		expect(nativeAborted).toBe(true);
		await expect(localRequest(manifest.socketPath, "answer", request)).rejects.toMatchObject({
			code: "QUESTION_CHANGED",
		});
		const denied = context.ui.confirm("Merge", "PR 42", { timeout: 10 });
		await expect(denied).resolves.toBe(false);
	});
});

it("projects old inline images only for an explicit text-only history request", async () => {
	const h = harness();
	const bytes = "P".repeat(2_200_000);
	h.setMessages([
		{ id: "human", role: "user", unexpectedBinary: "PRIVATE-MESSAGE-EXTRA", content: [{ type: "text", text: "Antes" }, { type: "image", data: bytes, mimeType: "image/png" }, { type: "text", text: "Después" }] },
		{ id: "assistant", role: "assistant", content: "Resultado visible" },
		{ id: "unknown", role: "user", content: [{ type: "future_attachment", data: "SECRET-UNKNOWN-PAYLOAD" }] },
	]);
	const input = { action: "inspect", paneId: "w1:p1", sessionId: "s1" };
	const legacy = await h.orchestrator.dispatch(input, "human");
	expect(JSON.stringify(legacy)).toContain(bytes);
	const projected = await h.orchestrator.dispatch({ ...input, historyContent: "text-only-v1" }, "human");
	expect(projected).toMatchObject({ messages: [
		{ id: "human", role: "user", content: [{ type: "text", text: "Antes" }, { type: "text", text: "[Imagen adjunta no disponible en esta vista]" }, { type: "text", text: "Después" }] },
		{ id: "assistant", role: "assistant", content: [{ type: "text", text: "Resultado visible" }] },
		{ id: "unknown", role: "user", content: [{ type: "text", text: "[Contenido adjunto no disponible en esta vista]" }] },
	] });
	expect(JSON.stringify(projected)).not.toContain(bytes);
	expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(2 * 1024 * 1024);
	expect(JSON.stringify(projected)).not.toContain("SECRET-UNKNOWN-PAYLOAD");
	expect(JSON.stringify(projected)).not.toContain("PRIVATE-MESSAGE-EXTRA");
	await expect(h.orchestrator.dispatch({ ...input, historyContent: "unknown" }, "human")).rejects.toMatchObject({ code: "INVALID_HISTORY" });
	const socketCalls = h.calls.filter(call => call.method === "snapshot");
	expect(socketCalls.every(call => !('historyContent' in call.params))).toBe(true);
});

it("validates paging before contacting a session and refuses fake history on legacy adapters", async () => {
	const h = harness();
	for (const limit of [-1, 0, 101, 3.5, "50"]) {
		await expect(
			h.orchestrator.dispatch({ action: "inspect", paneId: "w1:p1", sessionId: "s1", limit }, "human"),
		).rejects.toMatchObject({ code: "INVALID_HISTORY" });
	}
	expect(h.calls.filter((call) => call.method === "snapshot")).toHaveLength(0);
	expect(
		await h.orchestrator.dispatch(
			{ action: "inspect", paneId: "w1:p1", sessionId: "s1", limit: 30 },
			"human",
		),
	).toMatchObject({ history: { supported: false, hasEarlier: false } });
	await expect(
		h.orchestrator.dispatch(
			{ action: "inspect", paneId: "w1:p1", sessionId: "s1", limit: 30, before: "old-entry" },
			"human",
		),
	).rejects.toMatchObject({ code: "HISTORY_UNAVAILABLE" });
	expect(h.calls.filter((call) => call.method === "snapshot").at(-1)?.params).toMatchObject({
		limit: 30,
		before: "old-entry",
	});
});

it("keeps GitHub publication for the human even with a valid inspected workflow request", async()=>{
 const h=harness(); h.setCapabilities({activityFence:1}); h.setQuestion();
 const request=await delegatedRequest(h);
 await expect(h.orchestrator.answerForWorkflow(request,()=>true)).rejects.toMatchObject({code:"HUMAN_REQUIRED"});
 expect(h.calls.filter(c=>c.method==="answer")).toEqual([]);
});
it("personal dialog answers notify the watch owner, unlike workflow-origin answers", async()=>{
 const onInteraction=vi.fn(); const h=harness({onInteraction}); h.setQuestion();
 await h.orchestrator.dispatch({action:"answer",paneId:"w1:p1",sessionId:"s1",requestId:"q1",approved:true},"human");
 expect(onInteraction).toHaveBeenCalledExactlyOnceWith({paneId:"w1:p1",sessionId:"s1"},"human");
});

it.each(["prompt", "approve"])("revokes workflow authority if the adapter restarts between coordinator verification and %s", async action => {
 const directory=await mkdtemp(join(tmpdir(),"dot-reconnect-"));
 cleanups.push(()=>rm(directory,{recursive:true,force:true}));
 const h=harness(); Object.assign(h.manifest,{instanceId:"before"});
 h.setCapabilities({questions:true,prompt:true,activityFence:1,enrollmentProtocol:1});
 const question=vi.fn();
 const workflows=new WorkflowContinuations({
  dataDir:directory,snapshot:()=>h.orchestrator.snapshot(),
  inspect:(paneId,sessionId)=>h.orchestrator.dispatch({action:"inspect",paneId,sessionId},"agent"),
  prompt:async(paneId,sessionId,text,authorize)=>{
   h.manifest.instanceId="after";
   return h.orchestrator.dispatch({action:"prompt",paneId,sessionId,text},"agent",authorize);
  },
  approve:async(request,authorize)=>{
   h.manifest.instanceId="after";
   return h.orchestrator.answerForWorkflow(request,authorize);
  },
  askContinuation:question,
 });
 cleanups.push(async()=>workflows.close());
 await workflows.dispatch({action:"start",objective:"Local project work",authorization:"Continue the local work",sessions:[{paneId:"w1:p1",sessionId:"s1"}]},"agent");
 const wake=(await workflows.poll(true)).wake!;
 if(action==="approve") h.setRawQuestion({id:"local-q",kind:"confirm",answerable:true,title:"Allow local read?",workflowPermission:{provider:"dot-session/v1",category:"workspace-tool",scope:"project-workspace",tool:"read"}});
 const scoped={workflowId:wake.workflowId,leaseId:wake.leaseId,paneId:"w1:p1",sessionId:"s1"};
 await workflows.dispatch({...scoped,action:"inspect"},"agent");
 await expect(workflows.dispatch({...scoped,action,operationId:"reconnected",text:"Continue",requestId:"local-q",answer:{confirmed:true},reason:"Local work"},"agent")).rejects.toMatchObject({status:409});
 expect(h.calls.filter(c=>c.method==="prompt"||c.method==="answer")).toEqual([]);
 expect(workflows.status().workflows[0]?.state).toBe("paused");
 expect(question).toHaveBeenCalledOnce();
});

describe("deterministic delegated discovery", () => {
	it("answers the exact raw request before attention, without a Dot turn or success notification", async () => {
		const directory = await mkdtemp(join(tmpdir(), "dot-fast-approval-"));
		cleanups.push(() => rm(directory, { recursive: true, force: true }));
		let workflows: WorkflowContinuations | undefined;
		const notices: unknown[] = [];
		const events: unknown[] = [];
		const h = harness({
			onApproval: (request) => workflows?.tryApprove(request) ?? Promise.resolve(false),
			onEvent: (event) => {
				events.push(event);
				const notice = sessionNotice(event);
				if (notice) notices.push(notice);
				workflows?.onEvent(event);
			},
		});
		h.setCapabilities({ questions: true, activityFence:1, enrollmentProtocol:1 });
		Object.assign(h.manifest, {instanceId:"adapter-a"});
		workflows = new WorkflowContinuations({
			dataDir: directory,
			snapshot: () => h.orchestrator.snapshot(),
			inspect: (paneId, sessionId) =>
				h.orchestrator.dispatch({ action: "inspect", paneId, sessionId }, "agent"),
			prompt: vi.fn(),
			approve: (request, authorize) => h.orchestrator.answerForWorkflow(request, authorize),
		});
		await workflows.dispatch(
			{
				action: "start",
				mode: "session",
				objective: "Delegate session permissions",
				authorization: "Aprueba todos los permisos de esta sesión",
				sessions: [{ paneId: "w1:p1", sessionId: "s1" }],
			},
			"agent",
		);
		h.setRawQuestion({
			id: "q1",
			kind: "confirm",
			answerable: true,
			workflowPermission: {provider:"dot-session/v1",category:"workspace-tool",scope:"project-workspace",tool:"bash"},
			title: "Allow running local tests?",
			message: "Run unit tests",
			fingerprint: "raw-field-not-in-ui-approval",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		const before = h.calls.filter((call) => call.method === "answer").length;
		const page = await h.orchestrator.snapshot();
		expect(h.calls.filter((call) => call.method === "answer")).toHaveLength(before + 1);
		expect(page.approvals).toEqual([]);
		expect(events).toEqual([expect.objectContaining({ type: "policy" })]);
		expect(notices).toEqual([]);
		expect(workflows.status().workflows[0]).toMatchObject({
			state: "waiting",
			automaticApprovals: 1,
			pending: 0,
		});
		expect((await workflows.poll(true)).wake).toBeUndefined();
	});
	it("preserves the actionable permission if the background hook fails", async () => {
		const h = harness({
			onApproval: async () => {
				throw new Error("permission storage unavailable");
			},
		});
		h.setQuestion();
		const page = await h.orchestrator.snapshot();
		expect(page.approvals).toHaveLength(1);
		expect(page.events).toEqual([expect.objectContaining({ type: "attention", requestId: "q1" })]);
		expect(h.calls.filter((call) => call.method === "answer")).toEqual([]);
	});
});

describe("independent session concurrency", () => {
	it("allows permission resolution while history inspection is waiting, even on the same session", async () => {
		let finish!: () => void;
		let reading = false;
		let h!: ReturnType<typeof harness>;
		h = harness({
			request: async (socket, method, params = {}) => {
				if (method === "snapshot" && params.limit === 50) {
					reading = true;
					await new Promise<void>((resolve) => {
						finish = resolve;
					});
				}
				return h.request(socket, method, params);
			},
		});
		h.setCapabilities({activityFence:1});
		h.setRawQuestion({id:"q1",kind:"confirm",answerable:true,title:"Allow running tests?",message:"Local unit tests",workflowPermission:{provider:"dot-session/v1",category:"workspace-tool",scope:"project-workspace",tool:"bash"},expiresAt:new Date(Date.now()+600_000).toISOString()});
		const raw = await h.request("/pi.sock", "snapshot");
		if (!("question" in raw) || !raw.question) throw new Error("Expected an active question in the fixture snapshot.");
		const question = raw.question as Record<string, unknown>;
		const inspecting = h.orchestrator.dispatch(
			{ action: "inspect", paneId: "w1:p1", sessionId: "s1" },
			"agent",
		);
		await vi.waitFor(() => expect(reading).toBe(true));
		const answer = await h.orchestrator.answerForWorkflow(
			{
				workflowId: "fixture",
				objective: "Fixture",
				authorizedInstruction: "Explicit fixture instruction",
				paneId: "w1:p1",
				sessionId: "s1",
				requestId: "q1",
				questionHash: workflowQuestionHash(question),
				answer: { confirmed: true },
				reason: "Fixture",
			},
			() => true,
		);
		expect(answer).toMatchObject({ accepted: true });
		finish();
		await inspecting;
	});
	it("serializes mutations within one pane but allows another pane to continue", async () => {
		let finish!: () => void;
		let sending = false;
		let h!: ReturnType<typeof harness>;
		h = harness({
			registry: async () => [
				h.manifest,
				{
					...h.manifest,
					sessionId: "s2",
					socketPath: "/pi2.sock",
					pid: 456,
					binding: { terminalId: "t2", herdrSocketPath: "/herdr.sock" },
				},
			],
			request: async (socket, method, params = {}) => {
				if (method === "pane.get" && params.pane_id === "w2:p1")
					return { pane: { pane_id: "w2:p1", terminal_id: "t2" } };
				if (method === "pane.process_info" && params.pane_id === "w2:p1")
					return { process_info: { foreground_processes: [{ pid: 456 }] } };
				if (method === "prompt" && socket === "/pi.sock") {
					sending = true;
					await new Promise<void>((resolve) => {
						finish = resolve;
					});
				}
				if (socket === "/pi2.sock") return method === "snapshot" ? {sessionId:"s2",capabilities:{activityFence:1},status:"idle",messages:[]} : { accepted: true, sessionId: "s2" };
				return h.request(socket, method, params);
			},
		});
		h.setCapabilities({activityFence:1});
		const sendingFirst = h.orchestrator.dispatch(
			{ action: "prompt", paneId: "w1:p1", sessionId: "s1", text: "first" },
			"agent",
		);
		await vi.waitFor(() => expect(sending).toBe(true));
		await expect(
			h.orchestrator.dispatch(
				{ action: "prompt", paneId: "w1:p1", sessionId: "s1", text: "duplicate" },
				"agent",
			),
		).rejects.toMatchObject({ code: "BUSY" });
		await expect(
			h.orchestrator.dispatch(
				{ action: "prompt", paneId: "w2:p1", sessionId: "s2", text: "independent" },
				"agent",
			),
		).resolves.toMatchObject({ accepted: true, sessionId: "s2" });
		finish();
		await sendingFirst;
	});
});
