import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	initTheme,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { localRequest } from "../src/orchestration/herdr.ts";
import { SESSION_EXTENSION_PATH } from "../src/orchestration/index.ts";
import { tempDir } from "./helpers.ts";

it("loads the real Pi adapter and resolves its shared native UI context through authenticated local requests", async () => {
	const directory = tempDir();
	const registry = join(directory, "sessions");
	const globalWrapper = join(directory, "global.ts");
	writeFileSync(
		globalWrapper,
		`import dotSession from ${JSON.stringify(SESSION_EXTENSION_PATH)}; export default dotSession;`,
	);
	vi.stubEnv("GENTLE_DOT_SESSION_DIR", registry);
	vi.stubEnv("HERDR_ENV", "0");
	vi.stubEnv("ORCA_PANE_KEY", "");
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
		additionalExtensionPaths: [SESSION_EXTENSION_PATH, globalWrapper],
	});
	const modelRuntime = await ModelRuntime.create({
		authPath: join(directory, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(directory, "models"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		({ session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			resourceLoader: loader,
			modelRuntime,
			settingsManager,
			sessionManager: SessionManager.inMemory(directory),
			tools: [],
		}));
		initTheme("dark", false);
		let editorClosed = 0;
		let editorComponent: { handleInput(data: string): void } | undefined;
		const originalEditor = vi.fn(async () => undefined);
		const custom: ExtensionUIContext["custom"] = (factory) =>
			new Promise((resolve) => {
				const component = factory(
					{ requestRender: vi.fn() } as unknown as Parameters<typeof factory>[0],
					{} as Parameters<typeof factory>[1],
					{ matches: () => false } as unknown as Parameters<typeof factory>[2],
					(value) => {
						editorClosed++;
						resolve(value);
					},
				);
				editorComponent = component as { handleInput(data: string): void };
			});
		let aborted = 0;
		const native = <T>(opts: ExtensionUIDialogOptions | undefined, cancelled: T) =>
			new Promise<T>((resolve) => {
				opts?.signal?.addEventListener(
					"abort",
					() => {
						aborted++;
						resolve(cancelled);
					},
					{ once: true },
				);
			});
		const errors: unknown[] = [];
		const shutdown = vi.fn();
		await session.bindExtensions({
			mode: "tui",
			shutdownHandler: shutdown,
			onError: (error) => errors.push(error),
			uiContext: {
				editor: originalEditor,
				custom,
				confirm: (_title: string, _message: string, opts?: ExtensionUIDialogOptions) => native(opts, false),
				select: (_title: string, _options: string[], opts?: ExtensionUIDialogOptions) =>
					native<string | undefined>(opts, undefined),
				input: (_title: string, _placeholder?: string, opts?: ExtensionUIDialogOptions) =>
					native<string | undefined>(opts, undefined),
				notify: vi.fn(),
			} as unknown as ExtensionUIContext,
		});
		const manifests = readdirSync(registry).filter((name) => name.endsWith(".json"));
		expect(manifests).toHaveLength(1); // A global wrapper and -e share one adapter for Pi's UI.
		const manifestFile = manifests[0];
		const manifest = JSON.parse(readFileSync(join(registry, manifestFile ?? "missing"), "utf8"));
		const call = (method: string, params = {}) =>
			localRequest(manifest.socketPath, method, {
				expectedSessionId: manifest.sessionId,
				expectedInstanceId: manifest.instanceId,
				...params,
			});
		const runner = session.extensionRunner;
		// Tool and lifecycle contexts share Pi's actual wrapped UI object.
		const ui = runner.createToolContext("actual-tool", undefined).ui;
		expect(ui).toBe(runner.createContext().ui);
		const confirm = ui.confirm("Push", "git push origin feature");
		const reviewedSnapshot = await call("snapshot");
		let question = reviewedSnapshot.question as Record<string, unknown>;
		expect(question).toMatchObject({ kind: "confirm", answerable: true, message: "git push origin feature" });
		expect(reviewedSnapshot.questionRevision).toMatch(/^[a-f0-9]{64}$/);
		await expect(call("answer", { questionId: question.id, confirmed: true, expectedQuestionRevision: "0".repeat(64) })).rejects.toMatchObject({ code: "QUESTION_CHANGED" });
		expect((await call("snapshot")).question).toMatchObject({ id: question.id });
		await call("answer", { questionId: question.id, confirmed: true, expectedQuestionRevision: reviewedSnapshot.questionRevision });
		await expect(confirm).resolves.toBe(true);
		const select = ui.select("Pick", ["Inspect only", "Make changes"]);
		question = (await call("snapshot")).question as Record<string, unknown>;
		await expect(call("answer", { questionId: question.id, optionId: "wrong" })).rejects.toMatchObject({
			code: "INVALID_ANSWER",
		});
		expect((await call("snapshot")).question).toMatchObject({ id: question.id });
		await call("answer", { questionId: question.id, optionId: "0" });
		await expect(select).resolves.toBe("Inspect only");
		const input = ui.input("Branch", "feature/name");
		question = (await call("snapshot")).question as Record<string, unknown>;
		await call("answer", { questionId: question.id, text: "feature/mobile" });
		await expect(input).resolves.toBe("feature/mobile");
		const editor = ui.editor("Plan", "  original\nplan  ");
		question = (await call("snapshot")).question as Record<string, unknown>;
		expect(question).toMatchObject({ kind: "editor", message: "  original\nplan  ", answerable: true });
		await expect(
			call("answer", { questionId: question.id, text: "ok", approved: true }),
		).rejects.toMatchObject({ code: "INVALID_ANSWER" });
		expect(editorClosed).toBe(0);
		await call("answer", { questionId: question.id, text: "  edited\nplan  " });
		await expect(editor).resolves.toBe("  edited\nplan  ");
		expect(editorClosed).toBe(1);
		expect(originalEditor).not.toHaveBeenCalled();
		const nativeEditor = ui.editor("Native", "prefill");
		question = (await call("snapshot")).question as Record<string, unknown>;
		editorComponent?.handleInput("\x1b");
		await expect(nativeEditor).resolves.toBeUndefined();
		await expect(call("answer", { questionId: question.id, text: "late" })).rejects.toMatchObject({
			code: "QUESTION_CHANGED",
		});
		expect((await call("snapshot")).question).toBeNull();
		const unsupported = ui.custom<string | undefined>((_tui, _theme, _keys, done) => ({
			render: () => ["Arbitrary terminal UI"],
			invalidate: () => {},
			handleInput: () => done(undefined),
		}));
		question = (await call("snapshot")).question as Record<string, unknown>;
		expect(question).toMatchObject({ kind: "custom", answerable: false });
		await expect(call("answer", { questionId: question.id, approved: true })).rejects.toMatchObject({
			code: "QUESTION_CHANGED",
		});
		expect((await call("snapshot")).question).toMatchObject({ id: question.id });
		editorComponent?.handleInput("cancel locally");
		await expect(unsupported).resolves.toBeUndefined();
		expect(aborted).toBe(3);
		expect(errors).toEqual([]);
		const originalId = session.sessionManager.getSessionId();
		session.sessionManager.appendMessage({
			role: "user",
			content: "Keep this conversation",
			timestamp: Date.now(),
		});
		session.sessionManager.appendCustomEntry("private-approval", { grant: true });
		const exported = (await call("duplicate")).copy as { sessionFile: string; sessionId: string };
		const copied = SessionManager.open(exported.sessionFile);
		expect(copied.getSessionId()).toBe(exported.sessionId);
		expect(copied.getSessionId()).not.toBe(originalId);
		expect(copied.buildSessionContext().messages).toEqual(
			expect.arrayContaining([expect.objectContaining({ role: "user", content: "Keep this conversation" })]),
		);
		expect(copied.getEntries().some((entry) => entry.type === "custom")).toBe(false);
		expect(session.sessionManager.getSessionId()).toBe(originalId);
		await expect(call("close", { expectedSessionId: "stale-session" })).rejects.toMatchObject({
			code: "SESSION_CHANGED",
		});
		expect(shutdown).not.toHaveBeenCalled();
		expect(await call("close")).toMatchObject({ accepted: true, sessionId: originalId, closing: true });
		await expect.poll(() => shutdown.mock.calls.length).toBe(1);
	} finally {
		if (session) {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		vi.unstubAllEnvs();
	}
}, 20_000);

it.each([
	{
		tool: "ask_user_question",
		kind: "questionnaire",
		args: {
			questions: [
				{
					question: "¿Qué validamos?",
					header: "Validación",
					options: [
						{ label: "Pruebas", description: "Ejecutar pruebas", preview: "Suite exacta" },
						{ label: "Build", description: "Compilar" },
					],
				},
				{
					question: "¿Qué entornos?",
					header: "Entornos",
					multiSelect: true,
					options: [
						{ label: "Local", description: "Equipo local" },
						{ label: "Staging", description: "Servidor de pruebas" },
					],
				},
			],
		},
		answer: {
			answers: [
				{ questionId: "0", optionIndices: [0] },
				{ questionId: "1", optionIndices: [1, 0] },
			],
		},
		details: {
			answers: [
				{
					questionIndex: 0,
					question: "¿Qué validamos?",
					kind: "option",
					answer: "Pruebas",
					preview: "Suite exacta",
				},
				{
					questionIndex: 1,
					question: "¿Qué entornos?",
					kind: "multi",
					answer: null,
					selected: ["Local", "Staging"],
				},
			],
		},
	},
	{
		tool: "ask_user_choice",
		kind: "select",
		args: {
			question: "¿Autorizar la acción?",
			options: [
				{ label: "No", description: "Cancelar", value: "decline-original-token" },
				{ label: "Sí", description: "Sólo esta acción", value: "allow-original-token" },
			],
		},
		answer: { optionId: "1" },
		details: { selection: { value: "allow-original-token", label: "Sí", index: 2 } },
	},
	{
		tool: "ask_user_choice",
		kind: "questionnaire",
		args: {
			question: "¿Qué rama?",
			allowCustomResponse: true,
			options: [
				{ label: "Uno", description: "Opción uno", value: "one" },
				{ label: "Dos", description: "Opción dos", value: "two" },
			],
		},
		answer: { answers: [{ questionId: "0", text: "feature/mobile" }] },
		details: { customResponse: "feature/mobile" },
	},
])(
	"resolves actual Gentle Pi 4.0.0 $tool $kind through its original custom callback",
	async (sample) => {
		const directory = tempDir();
		const registry = join(directory, "sessions");
		vi.stubEnv("GENTLE_DOT_SESSION_DIR", registry);
		vi.stubEnv("HERDR_ENV", "0");
		vi.stubEnv("ORCA_PANE_KEY", "");
		const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
		const { createRequire } = await import("node:module");
		const { dirname } = await import("node:path");
		const gentle = dirname(createRequire(import.meta.url).resolve("gentle-pi/package.json"));
		expect(JSON.parse(readFileSync(join(gentle, "package.json"), "utf8")).version).toBe("4.0.0");
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
			additionalExtensionPaths: [
				SESSION_EXTENSION_PATH,
				join(gentle, "extensions", `${sample.tool.replaceAll("_", "-")}.ts`),
			],
		});
		const modelRuntime = await ModelRuntime.create({
			authPath: join(directory, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(directory, "models"),
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		await modelRuntime.setRuntimeApiKey("openai", "offline-fixture-key");
		const model = {
			id: "forms-fixture",
			name: "Forms fixture",
			api: "openai-completions" as const,
			provider: "openai",
			baseUrl: "https://fixture.invalid",
			input: ["text" as const],
			reasoning: false,
			contextWindow: 100_000,
			maxTokens: 1000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			await loader.reload();
			expect(loader.getExtensions().errors).toEqual([]);
			({ session } = await createAgentSession({
				cwd: directory,
				agentDir: directory,
				resourceLoader: loader,
				modelRuntime,
				model,
				settingsManager,
				sessionManager: SessionManager.inMemory(directory),
				tools: [sample.tool],
			}));
			let count = 0;
			session.agent.streamFunction = () => {
				const tool = count++ === 0;
				const message = {
					role: "assistant" as const,
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: tool ? ("toolUse" as const) : ("stop" as const),
					content: tool
						? [
								{
									type: "toolCall" as const,
									id: "native-form",
									name: sample.tool,
									arguments: JSON.parse(JSON.stringify(sample.args)),
								},
							]
						: [{ type: "text" as const, text: "Respuesta recibida." }],
				};
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
				return stream;
			};
			let completed = 0;
			const custom: ExtensionUIContext["custom"] = (factory) =>
				new Promise((resolve, reject) => {
					const theme = {
						fg: (_color: string, text: string) => text,
						bg: (_color: string, text: string) => text,
						bold: (text: string) => text,
					};
					Promise.resolve(
						factory(
							{ requestRender() {} } as Parameters<typeof factory>[0],
							theme as Parameters<typeof factory>[1],
							{} as Parameters<typeof factory>[2],
							(value) => {
								completed++;
								resolve(value);
							},
						),
					).catch(reject);
				});
			const errors: unknown[] = [];
			const results: unknown[] = [];
			session.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "toolResult") results.push(event.message);
			});
			await session.bindExtensions({
				mode: "tui",
				onError: (error) => errors.push(error),
				uiContext: { custom, notify: vi.fn() } as unknown as ExtensionUIContext,
			});
			const manifestFile = readdirSync(registry).find((name) => name.endsWith(".json"));
			const manifest = JSON.parse(readFileSync(join(registry, manifestFile ?? "missing"), "utf8"));
			const call = (method: string, params = {}) =>
				localRequest(manifest.socketPath, method, {
					expectedSessionId: manifest.sessionId,
					expectedInstanceId: manifest.instanceId,
					...params,
				});
			const turn = session.prompt("Necesito resolver esta decisión concreta.");
			let question: Record<string, unknown> = {};
			await vi.waitFor(
				async () => {
					question = (await call("snapshot")).question as Record<string, unknown>;
					expect(question, JSON.stringify({ results, errors })).toMatchObject({
						kind: sample.kind,
						answerable: true,
					});
				},
				{ timeout: 5000 },
			);
			expect(JSON.stringify(question)).not.toContain("allow-original-token");
			await call("answer", { questionId: question.id, ...sample.answer });
			await turn;
			expect(completed).toBe(1);
			expect(results).toContainEqual(
				expect.objectContaining({
					toolName: sample.tool,
					isError: false,
					details: expect.objectContaining(sample.details),
				}),
			);
			expect((await call("snapshot")).question).toBeNull();
			await expect(call("answer", { questionId: question.id, ...sample.answer })).rejects.toMatchObject({
				code: "QUESTION_CHANGED",
			});
			expect(errors).toEqual([]);
		} finally {
			if (session) {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
			vi.unstubAllEnvs();
			const { rmSync } = await import("node:fs");
			rmSync(directory, { recursive: true, force: true });
		}
	},
	25_000,
);
