import { rmSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type ToolCall,
	Type,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import {
	registerWatchers,
	WATCH_MESSAGE_TYPE,
	type WatchCall,
	type WatchPoll,
} from "../src/extensions/dot-watch.ts";
import { Watchers } from "../src/watchers.ts";
import { WorkflowAuthorization } from "../src/workflow-authorization.ts";
import { tempDir } from "./helpers.ts";

it("uses actual Pi lifecycle for durable notices, keeps tools blocked and survives four stopped reports", async () => {
	const directory = tempDir();
	const original = "Estate pendiente de mis agentes y avísame cuando terminen.";
	const ledger = new WorkflowAuthorization();
	ledger.record(original, original);
	const worker = {
		paneId: "pane-a",
		sessionId: "session-a",
		label: "Agent A",
		state: "working",
		connected: true,
		assistantMessageId: "old",
	};
	const second = {
		...worker,
		paneId: "pane-b",
		sessionId: "session-b",
		label: "Agent B",
		assistantMessageId: "old-b",
	};
	const workers = [worker, second];
	const inspect = vi.fn(async (paneId: string, sessionId: string) => {
		const selected = workers.find(
			(candidate) => candidate.paneId === paneId && candidate.sessionId === sessionId,
		);
		return {
			sessionId,
			status: selected?.state ?? "unknown",
			question: null,
			messages: [
				{
					id: selected?.assistantMessageId,
					role: "assistant",
					content: [{ type: "text", text: `${selected?.label}: finalizó la validación.` }],
				},
			],
		};
	});
	const coordinator = new Watchers({
		dataDir: directory,
		snapshot: async () => ({ sessions: workers }),
		debounceMs: 40,
		inspect,
	});
	let ackAttempts = 0;
	const call = vi.fn<WatchCall>(async (input, signal) => {
		if (input.action === "acknowledge" && ++ackAttempts === 1) throw new Error("Lost ACK response");
		return coordinator.dispatch(
			{
				...input,
				...(["start", "resume"].includes(String(input.action))
					? { authorization: ledger.resolve(input.sourceHash) }
					: {}),
			},
			"agent",
			() => !signal?.aborted,
		);
	});
	const poll = vi.fn<WatchPoll>((take, signal) => coordinator.poll(take, () => !signal.aborted));
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const loader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [
			(pi) => {
				registerWatchers(pi, poll, call, 20);
			},
		],
	});
	const model: Model<"openai-completions"> = {
		id: "watch-fixture",
		name: "Watch fixture",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://fixture.invalid",
		input: ["text"],
		reasoning: false,
		contextWindow: 100_000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const modelRuntime = await ModelRuntime.create({
		authPath: join(directory, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(directory, "models"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	await modelRuntime.setRuntimeApiKey("openai", "offline-fixture-key");
	const probe = vi.fn(async () => ({
		content: [{ type: "text" as const, text: "This must not execute" }],
		details: {},
	}));
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	const messages: unknown[] = [];
	const errors: unknown[] = [];
	let step = 0;
	let stopReport = false;
	try {
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		({ session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			resourceLoader: loader,
			model,
			modelRuntime,
			settingsManager,
			sessionManager: SessionManager.inMemory(directory),
			tools: ["dot_watch", "probe"],
			customTools: [
				{
					name: "probe",
					label: "Probe",
					description: "A tool that an event report may not run",
					parameters: Type.Object({}),
					execute: probe,
				},
			],
		}));
		session.agent.streamFunction = (_model, _context, options) => {
			const current = step++;
			let tool: Pick<ToolCall, "name" | "arguments"> | undefined;
			if (current === 0)
				tool = {
					name: "dot_watch",
					arguments: {
						action: "start",
						instruction: "Avisar cuando terminen los agentes",
						source: { kind: "agents" },
					},
				};
			if (current === 2) tool = { name: "probe", arguments: {} };
			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: tool ? "toolUse" : "stop",
				content: tool
					? [{ type: "toolCall", id: `call-${current}`, ...tool }]
					: [
							{
								type: "text",
								text:
									current === 1
										? "Quedo pendiente de tus agentes."
										: "Los agentes A y B terminaron sus respuestas; ambos informan que validaron el resultado.",
							},
						],
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			if (stopReport) {
				const abort = () =>
					stream.push({
						type: "error",
						reason: "aborted",
						error: { ...message, stopReason: "aborted", content: [] },
					});
				if (options?.signal?.aborted) abort();
				else options?.signal?.addEventListener("abort", abort, { once: true });
				return stream;
			}
			stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
			return stream;
		};
		session.subscribe((event) => {
			if (event.type === "message_end") messages.push(event.message);
		});
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		await session.prompt(original);
		expect(coordinator.status().watches).toHaveLength(1);
		await vi.waitFor(() => expect(poll.mock.calls.length).toBeGreaterThan(3), {
			timeout: 2000,
			interval: 20,
		});
		expect(step).toBe(2);
		expect(inspect).not.toHaveBeenCalled();
		worker.state = "idle";
		worker.assistantMessageId = "result-new";
		const event = {
			id: "event-completed",
			at: new Date().toISOString(),
			type: "completed",
			paneId: worker.paneId,
			sessionId: worker.sessionId,
			assistantMessageId: worker.assistantMessageId,
			message: "Agent finished",
		};
		coordinator.onEvent(event);
		second.state = "idle";
		second.assistantMessageId = "result-b";
		coordinator.onEvent({
			...event,
			id: "event-completed-b",
			paneId: second.paneId,
			sessionId: second.sessionId,
			assistantMessageId: second.assistantMessageId,
		});
		await vi.waitFor(
			() => {
				expect(step, JSON.stringify({ messages, errors })).toBe(4);
				expect(coordinator.status().pending).toBe(0);
				expect(ackAttempts).toBe(2);
			},
			{ timeout: 5000, interval: 20 },
		);
		coordinator.onEvent({ ...event, id: "same-completion-again" });
		const callsBefore = poll.mock.calls.length;
		await vi.waitFor(() => expect(poll.mock.calls.length).toBeGreaterThan(callsBefore + 2), {
			timeout: 2000,
			interval: 20,
		});
		expect(step).toBe(4);
		expect(inspect).toHaveBeenCalledTimes(2);
		expect(probe).not.toHaveBeenCalled();
		expect(errors).toEqual([]);
		expect(messages).toContainEqual(
			expect.objectContaining({ role: "toolResult", toolName: "probe", isError: true }),
		);
		expect(
			messages.filter(
				(item) => typeof item === "object" && item !== null && "role" in item && item.role === "user",
			),
		).toHaveLength(1);
		const notification = messages.find(
			(item) =>
				typeof item === "object" &&
				item !== null &&
				"customType" in item &&
				item.customType === WATCH_MESSAGE_TYPE,
		);
		expect(notification).toMatchObject({
			display: false,
			content: expect.stringContaining("Agent A: finalizó la validación."),
		});
		expect(notification).toMatchObject({
			content: expect.stringContaining("Agent B: finalizó la validación."),
		});
		expect(
			messages.filter(
				(item) =>
					typeof item === "object" &&
					item !== null &&
					"customType" in item &&
					item.customType === WATCH_MESSAGE_TYPE,
			),
		).toHaveLength(1);
		for (let index = 0; index < 5; index++) {
			stopReport = index < 4;
			worker.assistantMessageId = `result-after-stop-${index}`;
			coordinator.onEvent({
				...event,
				id: `completion-after-stop-${index}`,
				at: new Date().toISOString(),
				assistantMessageId: worker.assistantMessageId,
			});
			await vi.waitFor(() => expect(step).toBe(5 + index), { timeout: 2000, interval: 20 });
			if (stopReport) await session.abort();
			await vi.waitFor(
				() => {
					expect(coordinator.status()).toMatchObject({ pending: 0, watches: [{ state: "active" }] });
					expect(coordinator.status().watches[0]?.lastError).toBeUndefined();
				},
				{ timeout: 2000, interval: 20 },
			);
		}
		expect(
			call.mock.calls.filter(([input]) => input.action === "acknowledge" && input.outcome === "interrupted"),
		).toHaveLength(4);
		expect(call.mock.calls.some(([input]) => ["pause", "delete"].includes(String(input.action)))).toBe(false);
		expect(errors).toEqual([]);
	} finally {
		if (session) {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		coordinator.close();
		rmSync(directory, { recursive: true, force: true });
	}
}, 15_000);
