import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
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
import { tempDir } from "./helpers.ts";

function deferred() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// Each file is loaded separately by Pi/Jiti, exactly as the three production -e
// extensions. Only their HTTP boundary, poll interval and model stream are fixtures.
it("serializes all background sources across the real SDK deferred settlement boundary and isolated module caches", async () => {
	const dir = tempDir();
	const fixtureKey = Symbol.for("gentle-dot.background-turn.integration-fixture");
	const fixtureGlobal = globalThis as typeof globalThis & { [fixtureKey]?: unknown };
	const gate = deferred();
	const settling = deferred();
	const claimed = deferred();
	const observedWorkflow = deferred();
	const observedWatch = deferred();
	let firstSettlement = true;
	let reportsReady = false;
	let otherReady = false;
	let gateReleased = false;
	const consumed = new Set<string>();
	const claims: string[] = [];
	const duringGate: boolean[] = [];
	const calls: Record<string, unknown>[] = [];
	fixtureGlobal[fixtureKey] = {
		async settle() {
			if (!firstSettlement) return;
			firstSettlement = false;
			settling.resolve();
			await gate.promise;
		},
		async completions(take: boolean) {
			const ready = reportsReady && take && !consumed.has("completion");
			if (ready) {
				consumed.add("completion");
				claims.push("completion");
				claimed.resolve();
			}
			return {
				enabled: true,
				revision: 1,
				reports: ready
					? [
							{
								id: "report",
								paneId: "p",
								sessionId: "s",
								label: "A",
								at: "2026-10-13T00:00:00Z",
								outcome: "idle",
								lastAssistant: "Listo",
								truncated: false,
							},
						]
					: [],
			};
		},
		async workflows(take: boolean) {
			if (otherReady && !gateReleased) {
				duringGate.push(take);
				observedWorkflow.resolve();
			}
			const ready = otherReady && take && !consumed.has("workflow");
			if (ready) {
				consumed.add("workflow");
				claims.push("workflow");
			}
			return {
				workflows: [],
				pending: ready ? 1 : 0,
				...(ready
					? {
							wake: {
								workflowId: "work",
								leaseId: "workflow-lease",
								objective: "Inspecciona A",
								sessions: [{ paneId: "p", sessionId: "s" }],
								reasons: ["Terminó A"],
								runs: 1,
							},
						}
					: {}),
			};
		},
		async watch(take: boolean) {
			if (otherReady && !gateReleased) {
				duringGate.push(take);
				observedWatch.resolve();
			}
			const ready = otherReady && take && !consumed.has("watch");
			if (ready) {
				consumed.add("watch");
				claims.push("watch");
			}
			return {
				watches: [],
				pending: ready ? 1 : 0,
				pollAfterMs: 10,
				...(ready
					? {
							wake: {
								watchId: "watch",
								leaseId: "watch-lease",
								deliveryId: "mail-1",
								instruction: "Avisa de correos",
								authorizedInstruction: "Avisa de correos",
								events: [{ id: "mail-1", kind: "email", title: "Correo nuevo", at: "2026-10-13T00:00:00Z" }],
							},
						}
					: {}),
			};
		},
		async call(input: Record<string, unknown>) {
			calls.push(input);
			return { accepted: true };
		},
	};
	const fixtureSource = `const fixture = globalThis[Symbol.for("gentle-dot.background-turn.integration-fixture")];`;
	const gatePath = join(dir, "settlement-gate.ts");
	writeFileSync(
		gatePath,
		`${fixtureSource}\nexport default pi => pi.on("agent_settled", () => fixture.settle());\n`,
	);
	const paths = [gatePath];
	for (const [file, register, poll, takesCall] of [
		["dot-completions", "registerCompletionReports", "completions", false],
		["dot-workflows", "registerWorkflows", "workflows", true],
		["dot-watch", "registerWatchers", "watch", true],
	] as const) {
		const source = pathToFileURL(
			fileURLToPath(new URL(`../src/extensions/${file}.ts`, import.meta.url)),
		).href;
		const wrapper = join(dir, `${file}.ts`);
		writeFileSync(
			wrapper,
			`import { ${register} } from ${JSON.stringify(source)};\n${fixtureSource}\nexport default pi => ${register}(pi, fixture.${poll}, ${takesCall ? "fixture.call, " : ""}10);\n`,
		);
		paths.push(wrapper);
	}
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		noPromptTemplates: true,
		noThemes: true,
		additionalExtensionPaths: paths,
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let human: Promise<void> | undefined;
	try {
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions).toHaveLength(4);
		const model: Model<"openai-completions"> = {
			id: "background-fixture",
			name: "Background fixture",
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
			authPath: join(dir, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(dir, "models"),
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		await modelRuntime.setRuntimeApiKey("openai", "offline-fixture-key");
		const probe = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "Unexpected execution" }],
			details: {},
		}));
		({ session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			resourceLoader: loader,
			model,
			modelRuntime,
			settingsManager,
			sessionManager: SessionManager.inMemory(dir),
			tools: ["probe", "dot_workflows"],
			customTools: [
				{
					name: "probe",
					label: "Probe",
					description: "Blocked in notification turns",
					parameters: Type.Object({}),
					execute: probe,
				},
			],
		}));
		let current = "human";
		const modelCalls = new Map<string, number>();
		const customStarts: string[] = [];
		const errors: unknown[] = [];
		const failedTools: string[] = [];
		let settled = 0;
		session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "custom") {
				current = event.message.customType;
				customStarts.push(current);
			}
			if (event.type === "message_end" && event.message.role === "toolResult" && event.message.isError)
				failedTools.push(event.message.toolName);
			if (event.type === "agent_settled") settled++;
		});
		session.agent.streamFunction = () => {
			const stream = createAssistantMessageEventStream();
			const count = modelCalls.get(current) ?? 0;
			modelCalls.set(current, count + 1);
			const invoke = current !== "human" && count === 0;
			const workflow = current === "dot-workflow-continuation";
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
				stopReason: invoke ? "toolUse" : "stop",
				content: invoke
					? [
							{
								type: "toolCall",
								id: `probe-${current}`,
								name: workflow ? "dot_workflows" : "probe",
								arguments: workflow
									? { action: "inspect", workflowId: "work", paneId: "p", sessionId: "s" }
									: {},
							},
						]
					: [{ type: "text", text: "Respuesta del turno actual." }],
			};
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: invoke ? "toolUse" : "stop", message });
			return stream;
		};
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		human = session.prompt("Responde brevemente.");
		await settling.promise;
		expect(session.isIdle).toBe(true); // The SDK has not finished emitting agent_settled yet.
		reportsReady = true;
		await claimed.promise;
		otherReady = true;
		await Promise.all([observedWorkflow.promise, observedWatch.promise]);
		expect(duringGate).not.toContain(true);
		expect(claims).toEqual(["completion"]);
		expect(customStarts).toEqual([]); // sendMessage is deferred by the real SDK.
		gateReleased = true;
		gate.resolve();
		await human;
		await vi.waitFor(() => expect(settled).toBe(4), { timeout: 5000 });
		expect(customStarts).toHaveLength(3);
		expect(new Set(customStarts)).toEqual(
			new Set(["dot-agent-completion", "dot-workflow-continuation", "dot-watch-event"]),
		);
		expect(probe).not.toHaveBeenCalled();
		expect(failedTools).toEqual(["probe", "probe"]);
		expect(calls.filter((input) => input.action === "inspect")).toEqual([
			{ action: "inspect", workflowId: "work", paneId: "p", sessionId: "s", leaseId: "workflow-lease" },
		]);
		expect(calls.filter((input) => input.action === "acknowledge")).toContainEqual({
			action: "acknowledge",
			leaseId: "workflow-lease",
			outcome: "settled",
		});
		expect(calls.filter((input) => input.action === "acknowledge")).toContainEqual({
			action: "acknowledge",
			leaseId: "watch-lease",
			outcome: "settled",
		});
		expect(errors).toEqual([]);
	} finally {
		gateReleased = true;
		gate.resolve();
		if (session) {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await session.abort();
			await human?.catch(() => {});
			session.dispose();
		}
		delete fixtureGlobal[fixtureKey];
	}
}, 15_000);
