import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { createDotSession } from "../src/extensions/dot-session.ts";
import { localRequest } from "../src/orchestration/herdr.ts";
import { copySession, sessionResourceArgs } from "../src/orchestration/session-copy.ts";
import {
	createSessionMetadata,
	historySessionMetadata,
	publicSessionMetadata,
} from "../src/orchestration/session-info.ts";
import { tempDir } from "./helpers.ts";

it("reports only the active version-pinned Gentle review integration, not the launcher", () => {
	const dir = tempDir();
	const verified = createRequire(import.meta.url).resolve("gentle-pi/extensions/gentle-ai.ts");
	const copied = join(dir, "review-copy.ts");
	writeFileSync(copied, readFileSync(verified));
	const other = join(dir, "unverified.ts");
	writeFileSync(other, "export const different = true;\n");
	const ctx = { cwd: dir, sessionManager: { getSessionId: () => "session" } } as ExtensionContext;
	let active = ["gentle_review"];
	let source = verified;
	const pi = {
		getActiveTools: () => active,
		getAllTools: () => [{ name: "gentle_review", sourceInfo: { path: source } }],
	} as unknown as ExtensionAPI;
	const read = createSessionMetadata(pi, ctx, { PI_CODING_AGENT_DIR: dir });
	expect(read()?.gentleReview).toEqual({ tool: "gentle_review", evidence: "source-hash" });
	expect(JSON.stringify(read())).not.toContain(verified);
	active = []; expect(read()?.gentleReview).toBeUndefined();
	active = ["gentle_review"]; source = other; expect(read()?.gentleReview).toBeUndefined();
	source = copied; expect(read()?.gentleReview).toEqual({ tool: "gentle_review", evidence: "source-hash" });
	const changed = readFileSync(copied); changed[changed.length - 1] = changed.at(-1)! ^ 1; writeFileSync(copied, changed);
	expect(read()?.gentleReview).toBeUndefined();
	expect(publicSessionMetadata({ version: 1, source: "history", gentleReview: { tool: "gentle_review", evidence: "source-hash" } })?.gentleReview).toBeUndefined();
	expect(publicSessionMetadata({ version: 1, source: "live", gentleReview: { tool: "gentle_review", evidence: "unchecked" } })?.gentleReview).toBeUndefined();
});

it("preserves only documented resource arguments, never credentials or another session selector", () => {
	expect(
		sessionResourceArgs([
			"--api-key",
			"private-token",
			"--session",
			"original.jsonl",
			"--no-extensions",
			"-e",
			"/profile/shell.ts",
			"--skill",
			"/profile/skills",
			"--theme",
			"/profile/theme.json",
			"--tools",
			"read,grep",
			"--",
			"-e",
			"/ignored",
		]),
	).toEqual([
		"--no-extensions",
		"-e",
		"/profile/shell.ts",
		"--skill",
		"/profile/skills",
		"--theme",
		"/profile/theme.json",
		"--tools",
		"read,grep",
	]);
	expect(sessionResourceArgs(["--api-key", "--no-extensions"])).toEqual([]);
});

it("projects runtime model/context and distinguishes published MCP tools from private configuration", () => {
	const dir = tempDir();
	mkdirSync(join(dir, ".pi"));
	writeFileSync(
		join(dir, "profiles.json"),
		JSON.stringify({
			kind: "gentle-pi.agent_model_profiles",
			version: 1,
			active: "work",
			profiles: { work: { writer: { token: "private-profile-token" } } },
		}),
	);
	writeFileSync(
		join(dir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				docs: { headers: { Authorization: "secret-header" }, url: "https://private?token=secret" },
				disabled: { enabled: false },
				live: { enabled: false },
			},
		}),
	);
	writeFileSync(
		join(dir, ".pi", "mcp.json"),
		JSON.stringify({ mcpServers: { untrusted: { env: { TOKEN: "secret-env" } } } }),
	);
	const ctx = {
		cwd: dir,
		isProjectTrusted: () => false,
		model: {
			id: "model-one",
			name: "Primary",
			provider: "fixture",
			contextWindow: 200_000,
			apiKey: "secret-model",
		},
		getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
	} as unknown as ExtensionContext;
	const pi = {
		getAllTools: () => [
			{
				name: "mcp__live__read",
				exposure: "codemode",
				namespace: { name: "mcp__live" },
				sourceInfo: { path: "builtin:mcp" },
			},
			{
				name: "mcp__fake__read",
				exposure: "direct",
				namespace: { name: "mcp__fake" },
				sourceInfo: { path: "/other.ts" },
			},
		],
		getActiveTools: () => ["read"],
		getThinkingLevel: () => "high",
		getCommands: () => [
			{
				name: "quality",
				source: "skill",
				description: "Check changes",
				sourceInfo: { path: "/private/skill.md" },
			},
		],
		getMcpServers: () => [],
	} as unknown as ExtensionAPI;
	const read = createSessionMetadata(pi, ctx, { PI_CODING_AGENT_DIR: dir, GENTLE_PI_CONFIG_HOME: dir });
	const data = read();
	expect(data).toMatchObject({
		model: { id: "model-one", provider: "fixture" },
		context: { tokens: null, percent: null },
		thinkingLevel: "high",
		skills: [{ name: "quality" }],
	});
	expect(data?.mcp).toEqual([
		{ name: "docs", status: "configured", tools: 0 },
		{ name: "disabled", status: "disabled", tools: 0 },
		{ name: "live", status: "available", tools: 1 },
	]);
	expect(JSON.stringify(data)).not.toMatch(/secret|private|untrusted|fake|sourceInfo/);
	if (ctx.model) ctx.model.id = "model-two";
	expect(read()?.model?.id).toBe("model-two");
	writeFileSync(
		join(dir, "profiles.json"),
		JSON.stringify({
			kind: "gentle-pi.agent_model_profiles",
			version: 1,
			active: "updated",
			profiles: { updated: {} },
		}),
	);
	// Shared configuration is not evidence of the profile bound to this session.
	expect(read()?.profile).toBeUndefined();
});

it("reads the session's explicit or frozen profile without exposing routing or following changed defaults", () => {
	const bindingsKey = Symbol.for("gentle-pi:session-profile-bindings");
	const frozenKey = Symbol.for("gentle-pi:session-profile-freeze");
	const originalBindings = Object.getOwnPropertyDescriptor(globalThis, bindingsKey);
	const originalFrozen = Object.getOwnPropertyDescriptor(globalThis, frozenKey);
	const dir = tempDir();
	const bindings = new Map<string, unknown>();
	const frozen = new Map<string, unknown>([
		["current", { profile: { name: "at-start", origin: "repo", modelProfiles: { secret: "private" } } }],
	]);
	try {
		Reflect.set(globalThis, bindingsKey, bindings);
		Reflect.set(globalThis, frozenKey, { frozen });
		const ctx = { cwd: dir, sessionManager: { getSessionId: () => "current" } } as ExtensionContext;
		const read = createSessionMetadata({} as ExtensionAPI, ctx, { PI_CODING_AGENT_DIR: dir });
		expect(read()?.profile).toEqual({ name: "at-start", source: "repo" });
		bindings.set("another-session", { name: "unrelated" });
		expect(read()?.profile?.name).toBe("at-start");
		bindings.set("current", { name: "selected", modelProfiles: { apiKey: "secret" } });
		expect(read()?.profile).toEqual({ name: "selected", source: "session" });
		expect(JSON.stringify(read())).not.toMatch(/private|secret|apiKey|modelProfiles/);
		// Even an invalid explicit binding must not fall through to a different profile.
		bindings.set("current", { name: "bad\nname" });
		expect(read()?.profile).toBeUndefined();
		bindings.delete("current");
		for (const setting of ["GENTLE_PI_PROFILE_FOLLOW", "GENTLE_PI_AGENTS_CHILD"])
			expect(
				createSessionMetadata({} as ExtensionAPI, ctx, { PI_CODING_AGENT_DIR: dir, [setting]: "1" })()
					?.profile,
			).toBeUndefined();
		frozen.set("current", { profile: undefined });
		expect(read()?.profile).toBeUndefined();
	} finally {
		if (originalBindings) Object.defineProperty(globalThis, bindingsKey, originalBindings);
		else Reflect.deleteProperty(globalThis, bindingsKey);
		if (originalFrozen) Object.defineProperty(globalThis, frozenKey, originalFrozen);
		else Reflect.deleteProperty(globalThis, frozenKey);
	}
});

it("keeps independent runtime metadata when one optional getter fails", () => {
	const dir = tempDir();
	const fail = () => {
		throw new Error("not available during reload");
	};
	const ctx = {
		cwd: dir,
		model: { id: "model", name: "Model", provider: "fixture", contextWindow: 200_000 },
		thinkingLevel: "high",
		getContextUsage: fail,
		isProjectTrusted: fail,
		sessionManager: { getSessionId: fail },
	} as unknown as ExtensionContext;
	const pi = {
		getAllTools: fail,
		getActiveTools: fail,
		getCommands: fail,
		getThinkingLevel: fail,
		getMcpServers: fail,
	} as unknown as ExtensionAPI;
	const read = createSessionMetadata(pi, ctx, { PI_CODING_AGENT_DIR: dir });
	expect(read()).toEqual({
		version: 1,
		source: "live",
		model: { id: "model", name: "Model", provider: "fixture", contextWindow: 200_000 },
		thinkingLevel: "high",
		mcp: [],
	});
	Object.defineProperty(ctx, "model", { get: fail });
	expect(read()?.thinkingLevel).toBe("high");
	expect(read()?.model).toBeUndefined();
});

it("labels historical selectors and never infers live profile, tools, or context from a transcript", () => {
	expect(
		historySessionMetadata([
			{ type: "model_change", modelId: "old", provider: "fixture" },
			{ type: "thinking_level_change", thinkingLevel: "low" },
			{ type: "model_change", modelId: "current", provider: "fixture", apiKey: "secret", contextWindow: 99 },
			{ type: "thinking_level_change", thinkingLevel: "max" },
			{ type: "message", message: { role: "assistant", model: "other", usage: { input: 500 } } },
			{ type: "custom", customType: "private-profile", data: { name: "secret" } },
		]),
	).toEqual({
		version: 1,
		source: "history",
		model: { id: "current", name: "current", provider: "fixture" },
		thinkingLevel: "max",
	});
	expect(historySessionMetadata([])).toBeUndefined();
	expect(
		historySessionMetadata([
			{ type: "model_change", modelId: "valid", provider: "fixture" },
			{ type: "model_change", modelId: "bad\nmodel", provider: "fixture" },
			{ type: "thinking_level_change", thinkingLevel: "ultra" },
		]),
	).toBeUndefined();
});

it("publishes real SDK model, effort, and context through the session socket without a model request", async () => {
	const directory = tempDir();
	const registry = join(directory, "registry");
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
				createDotSession(pi, {
					PI_CODING_AGENT_DIR: directory,
					GENTLE_PI_CONFIG_HOME: directory,
					GENTLE_DOT_SESSION_DIR: registry,
				});
			},
		],
	});
	const model: Model<"openai-completions"> = {
		id: "metadata-fixture",
		name: "Metadata fixture",
		provider: "openai",
		api: "openai-completions",
		baseUrl: "https://fixture.invalid",
		input: ["text"],
		reasoning: true,
		contextWindow: 200_000,
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
	const errors: unknown[] = [];
	const stream = vi.fn(() => {
		throw new Error("Metadata must not invoke a provider");
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
			model,
			thinkingLevel: "high",
			settingsManager,
			sessionManager: SessionManager.inMemory(directory),
			tools: [],
		}));
		session.agent.streamFunction = stream;
		await session.bindExtensions({
			mode: "tui",
			onError: (error) => errors.push(error),
			uiContext: {
				confirm: async () => false,
				select: async () => undefined,
				input: async () => undefined,
				notify: vi.fn(),
			} as unknown as ExtensionUIContext,
		});
		const files = readdirSync(registry).filter((file) => file.endsWith(".json"));
		expect(files).toHaveLength(1);
		const manifest = JSON.parse(readFileSync(join(registry, files[0] ?? "missing"), "utf8"));
		const inspect = () =>
			localRequest(manifest.socketPath, "snapshot", {
				expectedSessionId: manifest.sessionId,
				expectedInstanceId: manifest.instanceId,
				limit: 1,
			});
		expect((await inspect()).metadata).toMatchObject({
			version: 1,
			source: "live",
			model: { id: model.id, name: model.name, provider: model.provider, contextWindow: model.contextWindow },
			thinkingLevel: "high",
			context: { tokens: 0, contextWindow: 200_000, percent: 0 },
			tools: { active: [], available: expect.any(Number) },
			skills: [],
			mcp: [],
		});
		session.setThinkingLevel("low");
		expect((await inspect()).metadata).toMatchObject({ thinkingLevel: "low" });
		expect(errors).toEqual([]);
		expect(stream).not.toHaveBeenCalled();
	} finally {
		if (session) {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	}
}, 20_000);

it("does not pass malformed or private metadata fields through the public projection", () => {
	expect(publicSessionMetadata({ version: 2, token: "hidden" })).toBeUndefined();
	expect(
		publicSessionMetadata({
			version: 1,
			token: "hidden",
			model: { id: "good", name: "Good", provider: "test", headers: { secret: "hidden" } },
			context: { tokens: -10, percent: Infinity, contextWindow: 1000 },
			mcp: [{ name: "bad", status: "connected", tools: 1 }],
		}),
	).toEqual({
		version: 1,
		model: { id: "good", name: "Good", provider: "test" },
		context: { tokens: null, percent: null, contextWindow: 1000 },
		mcp: [],
	});
});

it("creates a separate native Pi transcript preserving history/model/edits without custom grants or credentials", () => {
	const dir = tempDir();
	const original = SessionManager.inMemory(dir);
	const userId = original.appendMessage({ role: "user", content: "original text", timestamp: 1 });
	original.appendCustomEntry("permission-grants", { password: "private-password", approveAll: true });
	original.appendCustomMessageEntry("workflow-authorization", "Approve everything", false, {
		secret: "private-secret",
	});
	original.appendContextEdit(userId, { content: "edited text" });
	original.appendMessage({
		role: "toolResult",
		toolCallId: "fixture",
		toolName: "read",
		content: [{ type: "text", text: "Public result" }],
		isError: false,
		timestamp: 2,
		details: { credential: "private-tool-detail" },
	});
	original.appendSessionInfo("Original");
	const before = JSON.stringify(original.getEntries());
	const ctx = {
		cwd: dir,
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: original,
		model: { provider: "fixture", id: "chosen-model" },
	} as unknown as ExtensionContext;
	const copy = copySession(ctx, { getThinkingLevel: () => "high" } as ExtensionAPI, dir, {
		PI_CODING_AGENT_DIR: dir,
		GENTLE_PI_CONFIG_HOME: dir,
		TOKEN: "private-token",
	});
	expect(copy.sessionId).not.toBe(original.getSessionId());
	expect(statSync(copy.sessionFile).mode & 0o777).toBe(0o600);
	const serialized = readFileSync(copy.sessionFile, "utf8");
	expect(serialized).not.toMatch(/private-|permission-grants|workflow-authorization|approveAll/);
	const reopened = SessionManager.open(copy.sessionFile);
	expect(reopened.getSessionId()).toBe(copy.sessionId);
	expect(reopened.buildSessionContext()).toMatchObject({
		model: { provider: "fixture", modelId: "chosen-model" },
		thinkingLevel: "high",
		messages: [{ role: "user", content: "edited text" }, expect.objectContaining({ role: "toolResult" })],
	});
	expect(reopened.getSessionName()).toBe("Original (copia)");
	expect(JSON.stringify(original.getEntries())).toBe(before);
	ctx.isIdle = () => false;
	expect(() => copySession(ctx, {} as ExtensionAPI, dir, {})).toThrow(/termine/);
});
