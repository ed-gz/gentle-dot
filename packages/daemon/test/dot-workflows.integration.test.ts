import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { WORKFLOW_MESSAGE_TYPE } from "../src/extensions/dot-workflows.ts";
import { Orchestrator, SESSION_EXTENSION_PATH } from "../src/orchestration/index.ts";
import { WorkflowAuthorization, workflowSourceHash } from "../src/workflow-authorization.ts";
import { WORKFLOWS_EXTENSION_PATH, WorkflowContinuations, type WorkflowOptions } from "../src/workflows.ts";
import { tempDir } from "./helpers.ts";

it.each([false, true])(
	"uses real Pi lifecycle to continue two agents across restart and cancellation (cancel first continuation=%s)",
	async (cancelFirstContinuation) => {
		const directory = tempDir();
		let now = Date.now();
		const workers = ["a", "b"].map((id) => ({
			paneId: `pane-${id}`,
			sessionId: `session-${id}`,
			label: `Agent ${id}`,
			connected: true,
			state: "working",
			assistantMessageId: `old-${id}`,
			capabilities: { inspect: true, prompt: true, activityFence:1 },
		}));
		const inspect = vi.fn(async (paneId: string, sessionId: string) => {
			const target = workers.find((worker) => worker.paneId === paneId && worker.sessionId === sessionId);
			return {
				sessionId,
				status: target?.state === "working" ? "working" : "idle",
				messages: [
					{
						id: target?.assistantMessageId,
						role: "assistant",
						content: [
							{
								type: "text",
								text: "Resultado de fixture. El agente B debe validar A conforme al objetivo original.",
							},
						],
					},
				],
			};
		});
		const prompt = vi.fn(
			async (paneId: string, sessionId: string, _text: string, authorize: () => boolean) => {
				if (!authorize()) throw new Error("Unauthorized");
				const target = workers.find((worker) => worker.paneId === paneId && worker.sessionId === sessionId);
				if (target) target.state = "working";
				return { accepted: true, sessionId };
			},
		);
		const options: WorkflowOptions = {
			dataDir: directory,
			now: () => now,
			snapshot: async () => ({ sessions: workers }),
			inspect,
			prompt,
		};
		const coordinator = new WorkflowContinuations(options);
		const original = "Da seguimiento al flujo autorizado de A y B hasta que B valide el resultado.";
		const ledger = new WorkflowAuthorization();
		ledger.record(original, original);
		let loseFirstAcknowledgment = !cancelFirstContinuation;
		const acknowledgments: Array<{ leaseId: string; outcome: string }> = [];
		const authorization: string[] = [];
		const server = createServer(async (req, res) => {
			try {
				authorization.push(req.headers.authorization ?? "");
				let result: unknown;
				if (req.method === "POST") {
					let body = "";
					for await (const chunk of req) body += String(chunk);
					const input = JSON.parse(body);
					if (input.action === "acknowledge" && loseFirstAcknowledgment) {
						loseFirstAcknowledgment = false;
						res.destroy();
						return;
					}
					delete input.authorization;
					if (["start", "update", "resume"].includes(input.action)) input.authorization = ledger.resolve(input.sourceHash);
					result = await coordinator.dispatch(input, "agent");
					if (input.action === "acknowledge")
						acknowledgments.push({ leaseId: input.leaseId, outcome: input.outcome });
				} else result = await coordinator.poll(!req.url?.includes("status=1"));
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(result));
			} catch (error) {
				res.writeHead(409, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: String(error) }));
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No fixture port");
		vi.stubEnv("GENTLE_DOT_WORKFLOWS_URL", `http://127.0.0.1:${address.port}/workflows`);
		vi.stubEnv("GENTLE_DOT_WORKFLOWS_KEY", "offline-fixture-key");
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
			additionalExtensionPaths: [WORKFLOWS_EXTENSION_PATH],
		});
		const model: Model<"openai-completions"> = {
			id: "workflow-fixture",
			name: "Workflow fixture",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://fixture.invalid",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: false,
			contextWindow: 100_000,
			maxTokens: 1000,
		};
		const modelRuntime = await ModelRuntime.create({
			authPath: join(directory, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(directory, "models"),
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		const manager = SessionManager.inMemory(directory);
		await modelRuntime.setRuntimeApiKey("openai", "offline-fixture-key");
		const probe = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "Unexpected execution" }],
			details: {},
		}));
		const messages: unknown[] = [];
		const errors: unknown[] = [];
		let stage = 0;
		let waitingForAbort = false;
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		async function engine() {
			await loader.reload();
			expect(loader.getExtensions().errors).toEqual([]);
			const created = await createAgentSession({
				cwd: directory,
				agentDir: directory,
				resourceLoader: loader,
				model,
				modelRuntime,
				settingsManager,
				sessionManager: manager,
				tools: ["probe", "dot_workflows"],
				customTools: [
					{
						name: "probe",
						label: "Probe",
						description: "Not authorized for continuation",
						parameters: Type.Object({}),
						execute: probe,
					},
				],
			});
			const own = created.session;
			own.agent.streamFunction = (_model, _context, streamOptions) => {
				const step = stage++;
				const suspend = cancelFirstContinuation && step === 2 && !waitingForAbort;
				if (suspend) stage--;
				const workflowId = coordinator.status().workflows[0]?.id ?? "not-registered-yet";
				const target = (index: number) => ({
					workflowId,
					paneId: workers[index]?.paneId ?? "missing-pane",
					sessionId: workers[index]?.sessionId ?? "missing-session",
				});
				let tool: Pick<ToolCall, "name" | "arguments"> | undefined;
				if (step === 0)
					tool = {
						name: "dot_workflows",
						arguments: {
							action: "start",
							objective:
								"A prepara el resultado y B lo valida. Continúa la validación y termina cuando esté lista.",
							sessions: workers.map(({ paneId, sessionId }) => ({ paneId, sessionId })),
							maxRuns: 8,
						},
					};
				if (step === 2 && !suspend) tool = { name: "probe", arguments: {} };
				if (step === 3) tool = { name: "dot_workflows", arguments: { action: "inspect", ...target(0) } };
				if (step === 4 || step === 7)
					tool = { name: "dot_workflows", arguments: { action: "inspect", ...target(1) } };
				if (step === 5)
					tool = {
						name: "dot_workflows",
						arguments: {
							action: "prompt",
							...target(1),
							text: "Valida el resultado preparado por A conforme al objetivo autorizado.",
						},
					};
				if (step === 8) tool = { name: "dot_workflows", arguments: { action: "complete", workflowId } };
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
						? [{ type: "toolCall", id: `call-${step}`, ...tool }]
						: [
								{
									type: "text",
									text:
										step === 1
											? "Registré el seguimiento."
											: step === 6
												? "B está validando el trabajo de A."
												: "Flujo completado: B validó el resultado de A.",
								},
							],
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "start", partial: message });
				if (suspend) {
					const signal = streamOptions?.signal;
					if (!signal) throw new Error("Pi did not pass its provider cancellation signal");
					const abort = () =>
						stream.push({
							type: "error",
							reason: "aborted",
							error: {
								...message,
								content: [],
								stopReason: "aborted",
								errorMessage: "Cancelled by the fixture user",
							},
						});
					if (signal.aborted) abort();
					else signal.addEventListener("abort", abort, { once: true });
					waitingForAbort = true;
					return stream;
				}
				stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
				return stream;
			};
			own.subscribe((event) => {
				if (event.type === "message_end") messages.push(event.message);
			});
			await own.bindExtensions({ onError: (error) => errors.push(error) });
			return own;
		}
		const finish = (index: number, id: string) => {
			const worker = workers[index];
			if (!worker) throw new Error("No worker");
			worker.state = "idle";
			worker.assistantMessageId = id;
			coordinator.onEvent({
				id,
				type: "completed",
				at: new Date().toISOString(),
				paneId: worker.paneId,
				sessionId: worker.sessionId,
				assistantMessageId: id,
			});
		};
		try {
			session = await engine();
			await session.prompt(original);
			expect(coordinator.status().workflows, JSON.stringify({ stage, messages, errors })).toHaveLength(1);
			finish(0, "result-a");
			finish(1, "result-b-initial");
			if (cancelFirstContinuation) {
				await vi.waitFor(() => expect(waitingForAbort).toBe(true), { timeout: 6000 });
				expect(coordinator.status().workflows[0]?.state).toBe("running");
				await session.abort();
				await vi.waitFor(() => {
					expect(acknowledgments).toEqual([{ leaseId: expect.any(String), outcome: "interrupted" }]);
					expect(coordinator.status().workflows[0]?.state).toBe("waiting");
				});
				expect(messages).toContainEqual(
					expect.objectContaining({ role: "assistant", stopReason: "aborted" }),
				);
				expect(prompt).not.toHaveBeenCalled();
				// Advance only the coordinator clock; real Pi scheduling and cancellation remain intact.
				now += 15_001;
			}
			await vi.waitFor(
				() => {
					expect(prompt).toHaveBeenCalledOnce();
					expect(loseFirstAcknowledgment).toBe(false);
					// The tool invocation happens before Pi consumes its result and settles the reply.
					expect(stage).toBe(7);
					expect(session?.isIdle).toBe(true);
				},
				{ timeout: 10_000 },
			);
			expect(probe).not.toHaveBeenCalled();
			finish(1, "result-b-final");
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			session = undefined;
			// The daemon remains alive: the new engine must revoke/recover its predecessor's unacknowledged lease.
			session = await engine();
			await vi.waitFor(() => expect(coordinator.status().workflows[0]?.state).toBe("completed"), {
				timeout: 5000,
			});
			await vi.waitFor(() => expect(stage).toBe(10));
			expect(prompt).toHaveBeenCalledOnce();
			expect(inspect).toHaveBeenCalledTimes(3);
			expect(errors).toEqual([]);
			expect(authorization).toContain("Bearer offline-fixture-key");
			expect(
				messages.filter(
					(item) => typeof item === "object" && item !== null && "role" in item && item.role === "user",
				),
			).toHaveLength(1);
			expect(messages).toContainEqual(
				expect.objectContaining({ role: "custom", customType: WORKFLOW_MESSAGE_TYPE, display: false }),
			);
			expect(messages).toContainEqual(
				expect.objectContaining({ role: "toolResult", toolName: "probe", isError: true }),
			);
		} finally {
			if (session) {
				await session.abort();
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
			coordinator.close();
			vi.unstubAllEnvs();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(directory, { recursive: true, force: true });
		}
	},
	20_000,
);

it.each([
	{ mode: "objective", immediate: false },
	{ mode: "session", immediate: false },
	{ mode: "session", immediate: true },
] as const)(
	"answers the exact native confirmation through real Pi (mode=$mode, already pending=$immediate)",
	async ({ mode, immediate }) => {
		const directory = tempDir();
		const registry = join(directory, "sessions");
		const original =
			mode === "session"
				? "Autoriza las confirmaciones de esta sesión para guardar validaciones locales hasta que te diga que pares."
				: "Valida el resultado del agente, autoriza su confirmación para guardar la validación local y termina cuando esté verificado.";
		const ledger = new WorkflowAuthorization();
		ledger.record(original, original);
		vi.stubEnv("GENTLE_DOT_SESSION_DIR", registry);
		vi.stubEnv("HERDR_ENV", "0");
		vi.stubEnv("ORCA_PANE_KEY", "");
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const model: Model<"openai-completions"> = {
			id: "permission-fixture",
			name: "Permission fixture",
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
		const loader = (path: string) =>
			new DefaultResourceLoader({
				cwd: directory,
				agentDir: directory,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noContextFiles: true,
				noPromptTemplates: true,
				noThemes: true,
				additionalExtensionPaths: [path],
			});
		const stream = (id: string, text: string, tool?: Pick<ToolCall, "name" | "arguments">) => {
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
				content: tool ? [{ type: "toolCall", id, ...tool }] : [{ type: "text", text }],
			};
			const result = createAssistantMessageEventStream();
			result.push({ type: "start", partial: message });
			result.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
			return result;
		};
		let worker: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		let dot: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		let coordinator: WorkflowContinuations | undefined;
		const events: Array<{ type: string; requestId?: string }> = [];
		const orchestrator = new Orchestrator({
			dataDir: directory,
			registryDirs: [registry],
			socketPath: join(directory, "absent-herdr.sock"),
			orcaCommand: false,
			terminalLauncher: false,
			pollMs: 0,
			onEvent: (event) => {
				events.push(event);
				coordinator?.onEvent(event);
			},
		});
		const seenRequests: Array<Record<string, unknown>> = [];
		const server = createServer(async (req, res) => {
			try {
				if (req.headers.authorization !== "Bearer offline-fixture-key")
					throw new Error("Missing fixture authentication");
				if (!coordinator) throw new Error("Coordinator not started");
				let result: unknown;
				if (req.method === "POST") {
					let body = "";
					for await (const chunk of req) body += String(chunk);
					const input = JSON.parse(body);
					seenRequests.push(input);
					const authorization = ["start", "update", "resume", "claim"].includes(input.action)
						? ledger.resolve(input.sourceHash)
						: undefined;
					const claimId = input.action === "claim" && authorization ? input.sourceHash : undefined;
					result = await coordinator.dispatch({ ...input, authorization, claimId }, "agent");
				} else result = await coordinator.poll(!req.url?.includes("status=1"));
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(result));
			} catch (error) {
				res.writeHead(409, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: String(error) }));
			}
		});
		const errors: unknown[] = [];
		const native = vi.fn(
			(_title: string, _message: string, opts?: ExtensionUIDialogOptions) =>
				new Promise<boolean>((resolve) =>
					opts?.signal?.addEventListener("abort", () => resolve(false), { once: true }),
				),
		);
		const executed = vi.fn();
		const messages: unknown[] = [];
		let step = 0;
		try {
			const workerLoader = loader(SESSION_EXTENSION_PATH);
			await workerLoader.reload();
			expect(workerLoader.getExtensions().errors).toEqual([]);
			({ session: worker } = await createAgentSession({
				cwd: directory,
				agentDir: directory,
				resourceLoader: workerLoader,
				model,
				modelRuntime,
				settingsManager,
				sessionManager: SessionManager.inMemory(directory),
				tools: ["save_validation"],
				customTools: [
					{
						name: "save_validation",
						label: "Guardar validación",
						description: "Writes the fixture validation after a native confirmation",
						parameters: Type.Object({}),
						execute: async (_id, _params, _signal, _onUpdate, ctx) => {
							const accepted = await ctx.ui.confirm(
								"Guardar validación local",
								"Crear verified.txt en la carpeta de este objetivo.",
							);
							if (!accepted) throw new Error("Original native confirmation was not accepted");
							writeFileSync(join(directory, "verified.txt"), "validated\n");
							executed();
							return { content: [{ type: "text", text: "Validación guardada." }], details: { accepted } };
						},
					},
				],
			}));
			let workerStep = 0;
			worker.agent.streamFunction = () =>
				workerStep++ === 0
					? stream("save-validation", "", { name: "save_validation", arguments: {} })
					: stream("validation-complete", "Validación local completa y comprobada.");
			await worker.bindExtensions({
				mode: "tui",
				onError: (error) => errors.push(error),
				uiContext: { confirm: native, notify: vi.fn() } as unknown as ExtensionUIContext,
			});
			const target = (await orchestrator.snapshot()).sessions[0];
			if (!target?.sessionId) throw new Error("Real Pi adapter did not publish its session");
			const pair = { paneId: target.paneId, sessionId: target.sessionId };
			let inspectedQuestion: { id?: string } | undefined;
			const inspect = vi.fn(async (paneId: string, sessionId: string) => {
				const page = (await orchestrator.dispatch({ action: "inspect", paneId, sessionId }, "agent")) as {
					question?: { id?: string };
				};
				inspectedQuestion = page.question;
				return page;
			});
			const approve = vi.fn<NonNullable<WorkflowOptions["approve"]>>((request, authorize) =>
				orchestrator.answerForWorkflow(request, authorize),
			);
			coordinator = new WorkflowContinuations({
				dataDir: directory,
				snapshot: () => orchestrator.snapshot(),
				inspect,
				approve,
				prompt: (paneId, sessionId, text, authorize) =>
					orchestrator.dispatch({ action: "prompt", paneId, sessionId, text }, "agent", authorize),
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("No fixture port");
			vi.stubEnv("GENTLE_DOT_WORKFLOWS_URL", `http://127.0.0.1:${address.port}/workflows`);
			vi.stubEnv("GENTLE_DOT_WORKFLOWS_KEY", "offline-fixture-key");
			const dotLoader = loader(WORKFLOWS_EXTENSION_PATH);
			await dotLoader.reload();
			expect(dotLoader.getExtensions().errors).toEqual([]);
			({ session: dot } = await createAgentSession({
				cwd: directory,
				agentDir: directory,
				resourceLoader: dotLoader,
				model,
				modelRuntime,
				settingsManager,
				sessionManager: SessionManager.inMemory(directory),
				tools: ["dot_workflows"],
			}));
			dot.agent.streamFunction = () => {
				const current = step++;
				const workflowId = coordinator?.status().workflows[0]?.id ?? "not-created";
				let action: ToolCall["arguments"] | undefined;
				if (current === 0)
					action = {
						action: "start",
						objective:
							mode === "session"
								? "Resolver las solicitudes de validación local de esta sesión."
								: "Completar y verificar la validación local del agente.",
						mode,
						sessions: [pair],
					};
				if (!immediate && (current === 2 || (mode === "objective" && current === 5)))
					action = { action: "inspect", workflowId, ...pair };
				if (current === (immediate ? 1 : 3))
					action = {
						action: "approve",
						workflowId,
						// Foreground approval must work with the exact session and lease injected by the extension.
						...(immediate ? {} : pair),
						requestId: inspectedQuestion?.id ?? "missing-request",
						answer: { confirmed: true },
						reason:
							"El encargo humano incluye guardar esta validación local; la solicitud corresponde al mismo objetivo.",
					};
				if (mode === "objective" && current === 6) action = { action: "complete", workflowId };
				return stream(
					`dot-${current}`,
					current === 1
						? "Seguimiento registrado."
						: current === 4
							? "La validación está en curso."
							: "Objetivo verificado y completado.",
					action ? { name: "dot_workflows", arguments: action } : undefined,
				);
			};
			dot.subscribe((event) => {
				if (event.type === "message_end") messages.push(event.message);
			});
			await dot.bindExtensions({ onError: (error) => errors.push(error) });
			const requestValidation = async () => {
				// The worker asks through the real native dialog and the local session bridge.
				await orchestrator.dispatch(
					{
						action: "prompt",
						...pair,
						text: "Valida el resultado y guarda la validación local tras su confirmación.",
					},
					"agent",
				);
				await vi.waitFor(
					async () => {
						const snapshot = await orchestrator.snapshot();
						expect(snapshot.approvals).toHaveLength(1);
						expect(snapshot.approvals[0]).toMatchObject({ kind: "confirm", answerable: true, ...pair });
					},
					{ timeout: 3000, interval: 50 },
				);
				expect(executed).not.toHaveBeenCalled();
			};
			if (immediate) await requestValidation();
			await dot.prompt(original);
			expect(coordinator.status().workflows).toHaveLength(1);
			expect(seenRequests.find((entry) => entry.action === "start")?.sourceHash).toBe(
				workflowSourceHash(original),
			);
			if (immediate) {
				// Already resolved when the original human turn returns: no idle poll or hidden second turn.
				expect(executed, JSON.stringify({ step, messages, errors })).toHaveBeenCalledOnce();
				expect(
					seenRequests
						.filter((entry) => ["start", "claim", "inspect", "approve"].includes(String(entry.action)))
						.map((entry) => entry.action),
				).toEqual(["start", "claim", "inspect", "approve"]);
				expect(seenRequests.find((entry) => entry.action === "claim")?.sourceHash).toBe(
					workflowSourceHash(original),
				);
				expect(messages).not.toContainEqual(
					expect.objectContaining({ role: "custom", customType: WORKFLOW_MESSAGE_TYPE }),
				);
			} else await requestValidation();
			await vi.waitFor(
				async () => {
					await orchestrator.snapshot();
					expect(coordinator?.status().workflows[0]?.state, JSON.stringify({ step, messages, errors })).toBe(
						mode === "session" ? "waiting" : "completed",
					);
					expect(step).toBe(immediate ? 3 : mode === "session" ? 5 : 8);
					expect(executed).toHaveBeenCalledOnce();
				},
				{ timeout: 20_000, interval: 100 },
			);
			expect(native).toHaveBeenCalledOnce();
			expect(executed).toHaveBeenCalledOnce();
			expect(readFileSync(join(directory, "verified.txt"), "utf8")).toBe("validated\n");
			expect(approve).toHaveBeenCalledOnce();
			expect(approve.mock.calls[0]?.[0]).toMatchObject({
				authorizedInstruction: original,
				...pair,
				answer: { confirmed: true },
			});
			expect(inspect).toHaveBeenCalledTimes(mode === "session" ? 1 : 2);
			expect(events).toContainEqual(
				expect.objectContaining({ type: "attention", requestId: expect.any(String) }),
			);
			expect(events).toContainEqual(expect.objectContaining({ type: "completed" }));
			expect(
				messages.filter(
					(item) => typeof item === "object" && item !== null && "role" in item && item.role === "user",
				),
			).toHaveLength(1);
			expect(messages).not.toContainEqual(expect.objectContaining({ role: "toolResult", isError: true }));
			expect(errors).toEqual([]);
		} finally {
			for (const session of [dot, worker])
				if (session) {
					await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
					session.dispose();
				}
			coordinator?.close();
			orchestrator.close();
			vi.unstubAllEnvs();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(directory, { recursive: true, force: true });
		}
	},
	30_000,
);
