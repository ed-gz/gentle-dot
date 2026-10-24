import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { once } from "node:events";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	createAgentSession, createEventBus, DefaultResourceLoader, type ExtensionAPI,
	type ExtensionUIContext, type ToolDefinition, initTheme, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { localRequest } from "../src/orchestration/herdr.ts";
import { SESSION_EXTENSION_PATH } from "../src/orchestration/index.ts";
import { tempDir } from "./helpers.ts";

const gentle = dirname(createRequire(import.meta.url).resolve("gentle-pi/package.json"));
const providerPath = join(gentle, "extensions/gentle-ai.ts");
// Resolve at runtime, as Pi does; do not make the daemon compiler compile a dependency's TS project.
const { createGentleAiExtension } = await import(providerPath);
const { NativeReviewConsentRequiredError } = await import(join(gentle, "lib/native-review-cli.ts"));
const { captureReviewSessionIdentity, hasReviewSessionPermission } = await import(join(gentle, "lib/review-session-standing-permission.ts"));
interface FixtureConsent {
	raw: Record<string, unknown>;
	targetIdentity: string;
	choices: Array<{ answer: string; label: string; effect: string }>;
}
const { decodeReviewConsentV3 } = await import(join(gentle, "lib/review-integration-v2.ts")) as {
	decodeReviewConsentV3(raw: Record<string, unknown>, agent: string): FixtureConsent;
};

async function harness(unverifiedSource = false) {
	// Unix socket paths are bounded: nesting the fixture under the checkout can exceed 103 bytes.
	const directory = tempDir();
	expect(spawnSync("git", ["init", "--quiet", "--initial-branch=main", directory]).status).toBe(0);
	const raw = JSON.parse(readFileSync(join(gentle, "tests/fixtures/devbinary/consent-v3.captured.json"), "utf8"));
	raw.agent = "pi";
	for (const choice of raw.choices) {
		choice.invocation = choice.invocation
			.replace(/--cwd .*? --target/, `--cwd ${directory} --target`)
			.replace(" --consent ", " --agent pi --consent ");
	}
	const consent = decodeReviewConsentV3(raw, "pi");
	const calls: Array<{ answer: string; consent: unknown }> = [];
	let fail = false;
	let answerGate: Promise<void> | undefined;
	let release = () => {};
	let now = Date.now();
	// A separate fake process supplies native answers. Never launch gentle-ai or use real authority.
	const fake = join(directory, "fake-native.mjs");
	writeFileSync(fake, `process.stdout.write(JSON.stringify(JSON.parse(process.argv[2])));`);
	const transport = <T>(body: T): T => {
		const result = spawnSync(process.execPath, [fake, JSON.stringify(body)], { encoding: "utf8" });
		expect({ code: result.status, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
		return JSON.parse(result.stdout);
	};
	const candidate = {
		token: "isolated-candidate", root: directory, contributorRoot: directory,
		baseTree: "a".repeat(40), candidateTree: "b".repeat(40), paths: ["app.ts"],
		verify: vi.fn(), cleanup: vi.fn(),
	};
	const native = {
		reviewMode: async () => transport({ operation: "status", scope: "clone", status: { global: "", cloneLocal: "", effective: "on", source: "default" } }),
		targetStatus: async () => transport({
			contract: "gentle-ai.review-integration/v2", applicability: "unrelated", action: "start", replayability: "not_replayable",
			targetIdentity: consent.targetIdentity,
			projection: { projection: "workspace", baseTree: candidate.baseTree, initialReviewTree: candidate.candidateTree, currentCandidateTree: candidate.candidateTree, paths: candidate.paths, intendedUntracked: [] },
			candidates: [], raw: { schema: "gentle-ai.review-integration.status/v5" },
		}),
		start: async () => { throw new NativeReviewConsentRequiredError(decodeReviewConsentV3(transport(raw), "pi")); },
		answerConsent: async (request: { answer: string; consent: unknown }) => {
			calls.push(request);
			await answerGate;
			if (fail) throw Object.assign(new Error("Fake native failure"), { mutationOutcome: "none" });
			return transport(request.answer === "declined"
				? { kind: "declined", raw: { action: "declined", consent: "declined_this_candidate" } }
				: { kind: "started", start: { lineageId: "fake-lineage", state: "approved", riskLevel: "high", selectedLenses: [], changedFiles: 1, changedLines: 2, correctionBudget: 0, action: "closed", lensesRequired: false, riskReasons: [] } });
		},
	};
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const registry = join(directory, "sessions");
	vi.stubEnv("GENTLE_DOT_SESSION_DIR", registry);
	vi.stubEnv("HERDR_ENV", "0");
	vi.stubEnv("ORCA_PANE_KEY", "");
	const eventBus = createEventBus();
	const loader = new DefaultResourceLoader({
		eventBus,
		cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
		additionalExtensionPaths: [SESSION_EXTENSION_PATH, providerPath],
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	const loaded = loader.getExtensions().extensions.find(extension => extension.resolvedPath === providerPath);
	expect(loaded).toBeDefined();
	// Use the actual exported provider factory with isolated dependencies. Preserve the loader's
	// actual installed source metadata, but do not bind its unrelated startup/install hooks.
	const definition = loaded!.tools.get("gentle_review")!;
	loaded!.handlers.clear();
	createGentleAiExtension({
		nativeReviewCli: native, processEnv: {}, now: () => now,
		candidateViews: { createOrReuse: () => candidate, cleanup: vi.fn() },
	})({
		on() {}, registerCommand() {}, events: { emit() {} },
		registerTool(tool: ToolDefinition) { if (tool.name === "gentle_review") definition.definition = tool; },
	} as unknown as ExtensionAPI);
	loaded!.tools.clear();
	loaded!.tools.set("gentle_review", definition);
	if (unverifiedSource) definition.sourceInfo = { ...definition.sourceInfo, path: SESSION_EXTENSION_PATH };
	const modelRuntime = await ModelRuntime.create({
		authPath: join(directory, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(directory, "models"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	await modelRuntime.setRuntimeApiKey("openai", "offline-fixture-key");
	const model = {
		id: "consent-fixture", name: "Consent fixture",
		api: "openai-completions" as const, provider: "openai", baseUrl: "https://fixture.invalid",
		input: ["text" as const], reasoning: false, contextWindow: 100_000, maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		resourceLoader: loader,
		modelRuntime,
		model,
		settingsManager,
		sessionManager: SessionManager.inMemory(directory),
		tools: ["gentle_review"],
	});
	initTheme("dark", false);
	let component: { getActionOptions(): string[]; handleInput(data: string): void; render(width: number): string[]; invalidate(): void } | undefined;
	let closed = 0;
	const custom: ExtensionUIContext["custom"] = factory => new Promise((done, reject) => {
		try {
			component = factory(
				{ terminal: { rows: 40 }, requestRender() {} } as Parameters<typeof factory>[0],
				{ fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as Parameters<typeof factory>[1],
				undefined as unknown as Parameters<typeof factory>[2],
				value => { closed++; done(value); },
			) as typeof component;
		} catch (error) { reject(error); }
	});
	const errors: unknown[] = [];
	const notifications: string[] = [];
	await session.bindExtensions({
		mode: "tui",
		onError: (error) => errors.push(error),
		uiContext: {
			custom,
			notify(message: string) {
				notifications.push(message);
			},
			setStatus() {},
		} as unknown as ExtensionUIContext,
	});
	const manifestFile = existsSync(registry)
		? readdirSync(registry).find((file) => file.endsWith(".json"))
		: undefined;
	if (!manifestFile)
		throw new Error(
			`Fixture session adapter did not publish its manifest: ${notifications.join("; ") || "no notification"}`,
		);
	const manifest = JSON.parse(readFileSync(join(registry, manifestFile), "utf8"));
	const call = (method: string, params = {}) => localRequest(manifest.socketPath, method, { expectedSessionId: manifest.sessionId, expectedInstanceId: manifest.instanceId, ...params });
	let count = 0;
	session.agent.streamFunction = () => {
		const tool = count++ === 0;
		const message = {
			role: "assistant" as const,
			api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: tool ? "toolUse" as const : "stop" as const,
			content: tool ? [{
				type: "toolCall" as const,
				id: "review-call", name: "gentle_review",
				arguments: { operation: "start", input: JSON.stringify({ mode: "ordinary" }) },
			}] : [{ type: "text" as const, text: "Fixture completed." }],
		};
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
		return stream;
	};
	const turn = session.prompt("Isolated native review fixture, no real authority.");
	let question: Record<string, unknown> = {};
	await vi.waitFor(async () => {
		question = (await call("snapshot")).question as Record<string, unknown>;
		expect(question, JSON.stringify({ errors })).toMatchObject(unverifiedSource
			? { kind: "custom", answerable: false }
			: { kind: "select", answerable: true });
	}, { timeout: 3000 });
	return {
		call, question, calls, consent, session, turn, errors, manifest, eventBus,
		get closed() { return closed; },
		get component() { return component!; },
		fail() { fail = true; }, expire() { now += 600_001; },
		hold() { answerGate = new Promise<void>(resolve => { release = resolve; }); },
		release() { release(); },
		async close() {
			release();
			component?.handleInput("\x1b");
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await session.abort();
			await turn;
			session.dispose();
			vi.unstubAllEnvs();
		},
	};
}

it.each(["granted", "declined"] as const)("real patched gentle_review + Dot runner delivers %s once with the exact provider envelope", async answer => {
	const h = await harness();
	try {
		expect(JSON.parse(String(h.question.message))).toEqual(h.consent.raw);
		expect(h.question.options).toEqual(h.consent.choices.map(choice => ({ id: choice.answer, label: `${choice.label}\nEffect: ${choice.effect}` })));
		expect(h.component.getActionOptions()).toHaveLength(3);
		expect(h.component.getActionOptions()[2]).toContain("Review and allow this session");
		expect(JSON.stringify(h.question)).not.toContain("consentBinding");
		expect(await h.call("answer", { questionId: h.question.id, optionId: answer, expectedHumanActivityAt: ((await h.call("snapshot")).companionActivity as {humanActivityAt?:string}).humanActivityAt ?? null })).toMatchObject({ accepted: true });
		await h.turn;
		expect(h.closed).toBe(1);
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]?.answer).toBe(answer);
		expect(h.calls[0]?.consent).toMatchObject({ raw: h.consent.raw });
		const identity = await captureReviewSessionIdentity(h.session.extensionRunner.createContext(), {});
		expect(identity).toBeDefined();
		expect(hasReviewSessionPermission(identity!)).toBe(false);
		await expect(h.call("answer", { questionId: h.question.id, optionId: answer })).rejects.toMatchObject({ code: "QUESTION_CHANGED" });
		expect(h.calls).toHaveLength(1);
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
// The first run loads the real 10k-line provider and an isolated Pi runtime;
// shared CI workers need the suite's normal 20s allowance for that cold start.
}, 20_000);

it("waits for actual native delivery and rejects a racing duplicate without a second native invocation", async () => {
	const h = await harness();
	try {
		h.hold();
		let acknowledged = false;
		const first = h.call("answer", { questionId: h.question.id, optionId: "granted" }).then(value => { acknowledged = true; return value; });
		await vi.waitFor(() => expect(h.calls).toHaveLength(1));
		expect(acknowledged).toBe(false);
		await expect(h.call("answer", { questionId: h.question.id, optionId: "declined" })).rejects.toMatchObject({ code: "QUESTION_CHANGED" });
		expect(h.calls).toHaveLength(1);
		h.release();
		await expect(first).resolves.toMatchObject({ accepted: true });
		await h.turn;
	} finally { await h.close(); }
}, 10_000);

it.each([
	["third host action", { optionId: "host-session" }, "INVALID_ANSWER"],
	["changed request", { questionId: "wrong", optionId: "granted" }, "QUESTION_CHANGED"],
	["changed session", { expectedSessionId: "wrong", optionId: "granted" }, "SESSION_CHANGED"],
	["changed process", { expectedInstanceId: "wrong", optionId: "granted" }, "INSTANCE_CHANGED"],
	["spoofed binding", { optionId: "granted", consentBinding: "forged" }, "INVALID_ANSWER"],
	["mixed answer", { optionId: "granted", approved: true }, "INVALID_ANSWER"],
])("rejects %s without touching native state", async (_name, response, code) => {
	const h = await harness();
	try {
		await expect(h.call("answer", { questionId: h.question.id, ...response })).rejects.toMatchObject({ code });
		expect(h.calls).toEqual([]);
		expect((await h.call("snapshot")).question).toMatchObject({ id: h.question.id });
		await expect(h.call("answer", { questionId: h.question.id, optionId: "granted" })).resolves.toMatchObject({ accepted: true });
		await h.turn;
		expect(h.calls.map(call => call.answer)).toEqual(["granted"]);
	} finally { await h.close(); }
}, 10_000);

it("remote cancel withdraws access without answering and leaves all three local actions usable", async () => {
	const h = await harness();
	try {
		await h.call("answer", { questionId: h.question.id, cancelled: true });
		expect(h.calls).toEqual([]);
		expect(h.closed).toBe(0);
		expect(h.component.getActionOptions()).toHaveLength(3);
		h.component.render(120);
		h.component.handleInput("\r");
		await h.turn;
		expect(h.calls.map(call => call.answer)).toEqual(["granted"]);
	} finally { await h.close(); }
}, 10_000);

it("expired live provider state rejects an otherwise current UI answer with no native invocation", async () => {
	const h = await harness();
	try {
		h.expire();
		await expect(h.call("answer", { questionId: h.question.id, optionId: "granted" })).rejects.toMatchObject({ code: "QUESTION_CHANGED" });
		expect(h.calls).toEqual([]);
	} finally { await h.close(); }
}, 10_000);

it("event-bus injection cannot substitute a provider capability or its response callback", async () => {
	const h = await harness();
	try {
		const spoofed = vi.fn(async () => true);
		h.eventBus.emit("gentle-pi:review-consent:request", {
			toolCallId: "review-call", sessionId: h.manifest.sessionId,
			consentBinding: "forged", consent: h.consent, respond: spoofed,
		});
		expect((await h.call("snapshot")).question).toMatchObject({ id: h.question.id });
		expect(spoofed).not.toHaveBeenCalled();
		expect(h.calls).toEqual([]);
		await h.call("answer", { questionId: h.question.id, optionId: "declined" });
		await h.turn;
		expect(spoofed).not.toHaveBeenCalled();
		expect(h.calls.map(call => call.answer)).toEqual(["declined"]);
	} finally { await h.close(); }
}, 10_000);

it("unverified tool source cannot create remote consent even when it invokes the real provider UI", async () => {
	const h = await harness(true);
	try {
		await expect(h.call("answer", { questionId: h.question.id, optionId: "granted" })).rejects.toMatchObject({ code: "QUESTION_CHANGED" });
		expect(h.calls).toEqual([]);
		expect(h.component.getActionOptions()).toHaveLength(3);
	} finally { await h.close(); }
}, 10_000);

it("abort never manufactures either provider answer", async () => {
	const h = await harness();
	try {
		await h.call("abort");
		expect(h.calls).toEqual([]);
	} finally { await h.close(); }
}, 10_000);

it("local dismissal withdraws remote consent without turning it into decline", async () => {
	const h = await harness();
	try {
		h.component.handleInput("\x1b");
		await h.turn;
		await expect(h.call("answer", { questionId: h.question.id, optionId: "granted" })).rejects.toMatchObject({ code: "QUESTION_CHANGED" });
		expect(h.calls).toEqual([]);
	} finally { await h.close(); }
}, 10_000);

it("a disconnected request socket never answers consent and the local UI remains usable", async () => {
	const h = await harness();
	try {
		const socket = createConnection(h.manifest.socketPath);
		await once(socket, "connect");
		socket.destroy();
		await once(socket, "close");
		expect(h.calls).toEqual([]);
		expect(h.closed).toBe(0);
		expect((await h.call("snapshot")).question).toMatchObject({ id: h.question.id });
	} finally { await h.close(); }
}, 10_000);

it("session replacement refuses the old consent without a native answer", async () => {
	const h = await harness();
	try {
		h.session.sessionManager.newSession();
		await expect(h.call("answer", { questionId: h.question.id, optionId: "granted" })).rejects.toMatchObject({ code: "SESSION_CHANGED" });
		expect(h.calls).toEqual([]);
	} finally { await h.close(); }
}, 10_000);

it("shutdown withdraws the capability without answering native consent", async () => {
	const h = await harness();
	try {
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await expect(h.call("answer", { questionId: h.question.id, optionId: "granted" })).rejects.toBeDefined();
		expect(h.calls).toEqual([]);
	} finally { await h.close(); }
}, 10_000);

it("host-session permission can still be chosen locally but is never minted by a remote answer", async () => {
	const h = await harness();
	try {
		const context = h.session.extensionRunner.createContext();
		const identity = await captureReviewSessionIdentity(context, {});
		expect(identity).toBeDefined();
		expect(hasReviewSessionPermission(identity!)).toBe(false);
		await h.call("answer", { questionId: h.question.id, cancelled: true });
		h.component.render(120);
		h.component.handleInput("\x1b[B");
		h.component.render(120);
		h.component.handleInput("\x1b[B");
		h.component.render(120);
		h.component.handleInput("\r");
		await h.turn;
		expect(h.calls.map(call => call.answer)).toEqual(["granted"]);
		expect(hasReviewSessionPermission(identity!)).toBe(true);
	} finally { await h.close(); }
}, 10_000);

it("reports provider failure instead of acknowledging a click as accepted", async () => {
	const h = await harness();
	try {
		h.fail();
		await expect(h.call("answer", { questionId: h.question.id, optionId: "granted" })).rejects.toMatchObject({ code: "QUESTION_CHANGED" });
		await h.turn;
		expect(h.calls).toHaveLength(1);
		await expect(h.call("answer", { questionId: h.question.id, optionId: "granted" })).rejects.toMatchObject({ code: "QUESTION_CHANGED" });
		expect(h.calls).toHaveLength(1);
	} finally { await h.close(); }
}, 10_000);
