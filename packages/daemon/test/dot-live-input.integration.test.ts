import { rmSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type ImageContent,
	type Model,
	Type,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { LIVE_INPUT_STATUS, LIVE_INPUT_WAKE, registerLiveInput } from "../src/extensions/dot-live-input.ts";
import { WorkflowAuthorization, workflowSourceHash } from "../src/workflow-authorization.ts";
import { CAPTURE_JPEG } from "./fixtures/capture-image.ts";
import { tempDir } from "./helpers.ts";

function gate() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

type Plan = "hold" | "tool" | "answer";

async function fixture(options: {
	plans: Plan[];
	tool?: (signal?: AbortSignal) => Promise<void>;
	extension?: (pi: ExtensionAPI) => void;
	waitForIdle?: () => Promise<void>;
}) {
	const directory = tempDir();
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		steeringMode: "all",
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
		extensionFactories: [registerLiveInput, ...(options.extension ? [options.extension] : [])],
	});
	const model: Model<"openai-completions"> = {
		id: "live-input-fixture",
		name: "Live input fixture",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://fixture.invalid",
		input: ["text", "image"],
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
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		resourceLoader: loader,
		model,
		modelRuntime,
		settingsManager,
		sessionManager: SessionManager.inMemory(directory),
		tools: ["probe"],
		customTools: [
			{
				name: "probe",
				label: "Probe",
				description: "An offline command that must finish without interruption",
				parameters: Type.Object({}),
				execute: async (_id, _args, signal) => {
					await options.tool?.(signal);
					return { content: [{ type: "text", text: "finished" }], details: {} };
				},
			},
		],
	});
	const requests: { messages: unknown[]; signal?: AbortSignal }[] = [];
	const messages: unknown[] = [];
	const events: string[] = [];
	const errors: unknown[] = [];
	const finish = new Map<number, () => void>();
	const status = vi.fn<(key: string, value: string | undefined) => void>();
	session.agent.streamFunction = (_model, context, streamOptions) => {
		const index = requests.length;
		requests.push({ messages: structuredClone(context.messages), signal: streamOptions?.signal });
		const plan = options.plans[index] ?? "answer";
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
			stopReason: plan === "tool" ? "toolUse" : "stop",
			content:
				plan === "tool"
					? [{ type: "toolCall", id: `tool-${index}`, name: "probe", arguments: {} }]
					: [{ type: "text", text: `answer-${index}` }],
		};
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: { ...message, content: [] } });
		const done = () => stream.push({ type: "done", reason: plan === "tool" ? "toolUse" : "stop", message });
		finish.set(index, done);
		if (plan === "hold") {
			const abort = () =>
				stream.push({
					type: "error",
					reason: "aborted",
					error: { ...message, stopReason: "aborted", content: [] },
				});
			if (streamOptions?.signal?.aborted) abort();
			else streamOptions?.signal?.addEventListener("abort", abort, { once: true });
		} else done();
		return stream;
	};
	session.subscribe((event) => {
		events.push(event.type);
		if (event.type === "message_end") messages.push(event.message);
	});
	await session.bindExtensions({
		mode: "rpc",
		uiContext: { ...session.extensionRunner.getUIContext(), setStatus: status },
		commandContextActions: {
			waitForIdle: options.waitForIdle ?? (() => session.waitForIdle()),
			newSession: async () => ({ cancelled: true }),
			fork: async () => ({ cancelled: true }),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: async () => ({ cancelled: true }),
			reload: async () => {},
		},
		onError: (error) => errors.push(error),
	});
	return {
		session,
		requests,
		messages,
		events,
		errors,
		finish,
		status,
		interrupt: () => session.prompt("/dot-live-input interrupt", { source: "rpc" }),
		cancel: () => session.prompt("/dot-live-input cancel", { source: "rpc" }),
		async close() {
			await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
			await session.abort();
			session.dispose();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

const userTexts = (messages: unknown[]) =>
	messages
		.filter((message): message is { role: "user"; content: { type: string; text?: string }[] } =>
			Boolean(message && typeof message === "object" && "role" in message && message.role === "user"),
		)
		.map((message) =>
			message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join(""),
		);

it("interrupts only after the queued ACK, keeps burst order and image bytes, and inserts no human wake", async () => {
	const sdk = await fixture({ plans: ["hold", "answer"] });
	try {
		const authorization = new WorkflowAuthorization();
		const original = sdk.session.prompt("original", { source: "rpc" });
		await vi.waitFor(() => expect(sdk.requests).toHaveLength(1));
		const image: ImageContent = {
			type: "image",
			mimeType: "image/jpeg",
			data: CAPTURE_JPEG.toString("base64"),
		};
		for (const text of ["first", "second", "third"]) {
			authorization.record(text, text);
			const dispositions: string[] = [];
			await sdk.session.prompt(text, {
				source: "rpc",
				streamingBehavior: "steer",
				...(text === "second" ? { images: [image] } : {}),
				preflightResult: (value) => dispositions.push(value),
			});
			expect(dispositions).toEqual(["queued"]);
		}
		await Promise.all([sdk.interrupt(), sdk.interrupt(), sdk.interrupt()]);
		await original;
		await sdk.session.waitForIdle();
		expect(sdk.requests).toHaveLength(2);
		expect(sdk.requests[0]?.signal?.aborted).toBe(true);
		expect(userTexts(sdk.requests[1]?.messages ?? [])).toEqual(["original", "first", "second", "third"]);
		expect(userTexts(sdk.messages)).toEqual(["original", "first", "second", "third"]);
		for (const text of userTexts(sdk.requests[1]?.messages ?? []).slice(1))
			expect(authorization.resolve(workflowSourceHash(text))).toBe(text);
		expect(JSON.stringify(sdk.requests[1]?.messages)).toContain(image.data);
		expect(JSON.stringify(sdk.requests[1]?.messages)).not.toContain(LIVE_INPUT_WAKE);
		expect(sdk.messages.filter((value) => JSON.stringify(value).includes(LIVE_INPUT_WAKE))).toHaveLength(1);
		expect(sdk.status.mock.calls.filter(([, value]) => value === "interrupting")).toEqual([
			[LIVE_INPUT_STATUS, "interrupting"],
		]);
		expect(sdk.status).toHaveBeenLastCalledWith(LIVE_INPUT_STATUS, undefined);
		expect(sdk.errors).toEqual([]);
	} finally {
		await sdk.close();
	}
});

it("waits for every settlement handler and accepts a new native steer during the handoff", async () => {
	const settling = gate();
	const release = gate();
	let settlements = 0;
	const sdk = await fixture({
		plans: ["hold", "answer"],
		extension: (pi) => {
			pi.on("agent_settled", async () => {
				if (++settlements !== 1) return;
				settling.resolve();
				await release.promise;
			});
		},
	});
	try {
		const original = sdk.session.prompt("original", { source: "rpc" });
		await vi.waitFor(() => expect(sdk.requests).toHaveLength(1));
		await sdk.session.steer("first", undefined, { source: "rpc" });
		const handoff = sdk.interrupt();
		await settling.promise;
		await sdk.session.steer("second", undefined, { source: "rpc" });
		expect(sdk.requests).toHaveLength(1);
		release.resolve();
		await Promise.all([original, handoff]);
		await sdk.session.waitForIdle();
		expect(userTexts(sdk.requests[1]?.messages ?? [])).toEqual(["original", "first", "second"]);
		expect(sdk.events.indexOf("agent_settled")).toBeLessThan(sdk.events.lastIndexOf("agent_start"));
		expect(sdk.errors).toEqual([]);
	} finally {
		release.resolve();
		await sdk.close();
	}
});

it("cancel during a slow settlement prevents a wake and preserves the pending human message", async () => {
	const settling = gate();
	const release = gate();
	let settlements = 0;
	const sdk = await fixture({
		plans: ["hold", "answer"],
		extension: (pi) => {
			pi.on("agent_settled", async () => {
				if (++settlements !== 1) return;
				settling.resolve();
				await release.promise;
			});
		},
	});
	try {
		const original = sdk.session.prompt("original", { source: "rpc" });
		await vi.waitFor(() => expect(sdk.requests).toHaveLength(1));
		await sdk.session.steer("keep this message", undefined, { source: "rpc" });
		const handoff = sdk.interrupt();
		await settling.promise;
		const cancel = sdk.cancel();
		release.resolve();
		await Promise.all([original, handoff, cancel]);
		await sdk.session.abort();
		expect(sdk.requests).toHaveLength(1);
		expect(sdk.session.getSteeringMessages()).toEqual(["keep this message"]);
		expect(userTexts(sdk.messages)).toEqual(["original"]);
		expect(sdk.errors).toEqual([]);
	} finally {
		release.resolve();
		await sdk.close();
	}
});

it("never aborts a running tool, and its queued message is consumed at the normal tool checkpoint", async () => {
	const running = gate();
	const release = gate();
	let signal: AbortSignal | undefined;
	const sdk = await fixture({
		plans: ["tool", "answer"],
		tool: async (current) => {
			signal = current;
			running.resolve();
			await release.promise;
		},
	});
	try {
		const original = sdk.session.prompt("original", { source: "rpc" });
		await running.promise;
		await sdk.session.steer("new direction", undefined, { source: "rpc" });
		await sdk.interrupt();
		expect(signal?.aborted).toBe(false);
		expect(sdk.requests).toHaveLength(1);
		release.resolve();
		await original;
		expect(userTexts(sdk.requests[1]?.messages ?? [])).toEqual(["original", "new direction"]);
		expect(sdk.messages.some((value) => JSON.stringify(value).includes(LIVE_INPUT_WAKE))).toBe(false);
		expect(sdk.errors).toEqual([]);
	} finally {
		release.resolve();
		await sdk.close();
	}
});

it("never cancels a permission hook before the tool has started", async () => {
	const asking = gate();
	const release = gate();
	let executed = false;
	const sdk = await fixture({
		plans: ["tool", "answer"],
		tool: async () => {
			executed = true;
		},
		extension: (pi) => {
			pi.on("tool_call", async () => {
				asking.resolve();
				await release.promise;
			});
		},
	});
	try {
		const original = sdk.session.prompt("original", { source: "rpc" });
		await asking.promise;
		await sdk.session.steer("new direction", undefined, { source: "rpc" });
		await sdk.interrupt();
		expect(sdk.requests[0]?.signal?.aborted).toBe(false);
		expect(executed).toBe(false);
		expect(sdk.status.mock.calls.some(([, value]) => value === "interrupting")).toBe(false);
		release.resolve();
		await original;
		expect(executed).toBe(true);
		expect(userTexts(sdk.requests[1]?.messages ?? [])).toEqual(["original", "new direction"]);
		expect(sdk.errors).toEqual([]);
	} finally {
		release.resolve();
		await sdk.close();
	}
});

it("does not interrupt for an unqueued command, extension input, or a follow-up", async () => {
	const sdk = await fixture({ plans: ["hold", "answer", "answer"] });
	try {
		const original = sdk.session.prompt("original", { source: "rpc" });
		await vi.waitFor(() => expect(sdk.requests).toHaveLength(1));
		await sdk.interrupt();
		await sdk.session.steer("extension message", undefined, { source: "extension" });
		await sdk.session.followUp("later", undefined, { source: "rpc" });
		expect(sdk.requests[0]?.signal?.aborted).toBe(false);
		expect(sdk.status.mock.calls.some(([, value]) => value === "interrupting")).toBe(false);
		sdk.finish.get(0)?.();
		await original;
		expect(userTexts(sdk.messages)).toEqual(["original", "extension message", "later"]);
		expect(sdk.errors).toEqual([]);
	} finally {
		await sdk.close();
	}
});

it("clears handoff status on a failed idle barrier without dropping the queued message", async () => {
	const sdk = await fixture({
		plans: ["hold", "answer"],
		waitForIdle: async () => {
			throw new Error("fixture idle failure");
		},
	});
	try {
		const original = sdk.session.prompt("original", { source: "rpc" });
		await vi.waitFor(() => expect(sdk.requests).toHaveLength(1));
		await sdk.session.steer("keep this message", undefined, { source: "rpc" });
		await sdk.interrupt();
		await original;
		expect(sdk.requests).toHaveLength(1);
		expect(sdk.session.getSteeringMessages()).toEqual(["keep this message"]);
		expect(sdk.status).toHaveBeenLastCalledWith(LIVE_INPUT_STATUS, undefined);
		expect(sdk.errors).toEqual([expect.objectContaining({ error: "fixture idle failure" })]);
	} finally {
		await sdk.close();
	}
});
