import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { record } from "./herdr.ts";

export interface SessionMetadata {
	version: 1;
	/** Historical selectors are not a live runtime report. */
	source?: "live" | "history";
	model?: { id: string; name: string; provider: string; contextWindow?: number; source?: "live" };
	thinkingLevel?: string;
	context?: { tokens: number | null; contextWindow: number; percent: number | null; source?: "live" };
	tools?: { active: string[]; available: number };
	skills?: { name: string; description?: string }[];
	profile?: { name: string; source: "session" | "global" | "local" | "repo" };
	/** Available means exposed tools, not a verified live transport connection. */
	mcp?: { name: string; status: "configured" | "disabled" | "available"; tools: number }[];
}
const name = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 160 && /^[\w.:/@ -]+$/.test(value);
const positive = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;
const count = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function readOptional<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}
const label = (value: unknown, max = 200) =>
	typeof value === "string"
		? [...value.slice(0, max)]
				.map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char))
				.join("")
		: undefined;

/** Explicit public projection: never forwards config, headers, env, paths or provider credentials. */
export function publicSessionMetadata(value: unknown): SessionMetadata | undefined {
	if (!record(value) || value.version !== 1) return undefined;
	const result: SessionMetadata = { version: 1 };
	if (value.source === "live" || value.source === "history") result.source = value.source;
	const model = value.model;
	if (record(model) && name(model.id) && name(model.provider))
		result.model = {
			id: model.id,
			...(model.source === "live" ? { source: "live" } : {}),
			provider: model.provider,
			name: label(model.name) || model.id,
			...(positive(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
		};
	if (typeof value.thinkingLevel === "string" && thinkingLevels.includes(value.thinkingLevel))
		result.thinkingLevel = value.thinkingLevel;
	const context = value.context;
	if (record(context) && positive(context.contextWindow))
		result.context = {
			tokens: count(context.tokens) ? context.tokens : null,
			...(context.source === "live" ? { source: "live" } : {}),
			contextWindow: context.contextWindow,
			percent: count(context.percent) ? context.percent : null,
		};
	if (record(value.tools) && Array.isArray(value.tools.active) && count(value.tools.available))
		result.tools = {
			active: [...new Set(value.tools.active.filter(name))].slice(0, 512),
			available: value.tools.available,
		};
	if (Array.isArray(value.skills))
		result.skills = value.skills
			.filter(record)
			.filter((item) => name(item.name))
			.slice(0, 512)
			.map((item) => ({
				name: item.name as string,
				...(label(item.description) ? { description: label(item.description) } : {}),
			}));
	if (
		record(value.profile) &&
		name(value.profile.name) &&
		["session", "global", "local", "repo"].includes(String(value.profile.source))
	)
		result.profile = {
			name: value.profile.name,
			source: value.profile.source as NonNullable<SessionMetadata["profile"]>["source"],
		};
	if (Array.isArray(value.mcp))
		result.mcp = value.mcp
			.filter(record)
			.filter(
				(item) =>
					name(item.name) &&
					["configured", "disabled", "available"].includes(String(item.status)) &&
					count(item.tools),
			)
			.slice(0, 128)
			.map((item) => ({
				name: item.name as string,
				status: item.status as "configured" | "disabled" | "available",
				tools: item.tools as number,
			}));
	return result;
}

/** Selectors from an already verified active branch; never infer current tools or context limits. */
export function historySessionMetadata(entries: readonly unknown[]): SessionMetadata | undefined {
	let model: SessionMetadata["model"];
	let thinkingLevel: string | undefined;
	for (const entry of entries) {
		if (!record(entry)) continue;
		if (entry.type === "model_change")
			model =
				name(entry.modelId) && name(entry.provider)
					? { id: entry.modelId, name: entry.modelId, provider: entry.provider }
					: undefined;
		if (entry.type === "thinking_level_change")
			thinkingLevel =
				typeof entry.thinkingLevel === "string" && thinkingLevels.includes(entry.thinkingLevel)
					? entry.thinkingLevel
					: undefined;
	}
	return model || thinkingLevel
		? publicSessionMetadata({ version: 1, source: "history", model, thinkingLevel })
		: undefined;
}

/** Gentle Shell shares these public selectors across its separately loaded extension modules. */
function runtimeProfile(sessionId: string | undefined, env: NodeJS.ProcessEnv): SessionMetadata["profile"] {
	if (!sessionId) return;
	return readOptional(() => {
		const bindings: unknown = Reflect.get(globalThis, Symbol.for("gentle-pi:session-profile-bindings"));
		if (bindings instanceof Map && bindings.has(sessionId)) {
			const binding: unknown = bindings.get(sessionId);
			return record(binding) && name(binding.name) ? { name: binding.name, source: "session" } : undefined;
		}
		// Follow mode and child sessions resolve defaults at launch; any old frozen entry is irrelevant.
		if (env.GENTLE_PI_PROFILE_FOLLOW === "1" || env.GENTLE_PI_AGENTS_CHILD === "1") return;
		const registry: unknown = Reflect.get(globalThis, Symbol.for("gentle-pi:session-profile-freeze"));
		if (!record(registry) || !(registry.frozen instanceof Map)) return;
		const frozen: unknown = registry.frozen.get(sessionId);
		if (!record(frozen) || !record(frozen.profile)) return;
		const profile = frozen.profile;
		if (name(profile.name) && ["global", "local", "repo"].includes(String(profile.origin)))
			return {
				name: profile.name,
				source: profile.origin as "global" | "local" | "repo",
			};
	});
}

const configCache = new Map<string, { fingerprint: string; value: Record<string, unknown> | undefined }>();
function json(path: string): Record<string, unknown> | undefined {
	try {
		const stat = statSync(path);
		if (stat.size > 512 * 1024) return;
		const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
		const cached = configCache.get(path);
		if (cached?.fingerprint === fingerprint) return cached.value;
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		// Keep only public selectors in the cache, never server auth/env or profile bodies.
		const parsed = record(value)
			? {
					...(record(value.mcpServers)
						? {
								mcpServers: Object.fromEntries(
									Object.entries(value.mcpServers)
										.filter(([, server]) => record(server))
										.map(([key, server]) => [key, { enabled: (server as Record<string, unknown>).enabled }]),
								),
							}
						: {}),
				}
			: undefined;
		if (configCache.size >= 64) configCache.clear();
		configCache.set(path, { fingerprint, value: parsed });
		return parsed;
	} catch {
		return;
	}
}

export function sessionProfilePaths(env: NodeJS.ProcessEnv) {
	const expand = (path: string) =>
		resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
	return {
		agentDir: expand(env.PI_CODING_AGENT_DIR || env.GENTLE_PI_AGENT_HOME || getAgentDir()),
		configHome: expand(env.GENTLE_PI_CONFIG_HOME || join(homedir(), ".pi", "gentle-ai")),
	};
}

/** Runtime selectors only; a changed global default does not change an existing session's profile. */
export function createSessionMetadata(pi: ExtensionAPI, ctx: ExtensionContext, env: NodeJS.ProcessEnv) {
	const paths = sessionProfilePaths(env);
	return () => {
		// Optional runtime APIs can fail independently during reload or with an older SDK.
		const all = readOptional(() => pi.getAllTools?.()) ?? [];
		const active = readOptional(() => pi.getActiveTools?.());
		const commands = readOptional(() => pi.getCommands?.());
		const usage = readOptional(() => ctx.getContextUsage?.());
		const model = readOptional(() => ctx.model);
		const thinkingLevel =
			readOptional(() => pi.getThinkingLevel?.()) ?? readOptional(() => ctx.thinkingLevel);
		const profile = runtimeProfile(
			readOptional(() => ctx.sessionManager.getSessionId()),
			env,
		);

		const servers = new Map<
			string,
			{ name: string; status: "configured" | "disabled" | "available"; tools: number }
		>();
		for (const server of readOptional(() => pi.getMcpServers?.()) ?? [])
			if (name(server.name))
				servers.set(server.name, {
					name: server.name,
					status: server.config.enabled === false ? "disabled" : "configured",
					tools: 0,
				});
		const cwd = readOptional(() => ctx.cwd);
		const configs = [
			join(paths.agentDir, "mcp.json"),
			...(cwd && readOptional(() => ctx.isProjectTrusted?.()) ? [join(cwd, ".pi", "mcp.json")] : []),
		];
		for (const path of configs) {
			const config = json(path)?.mcpServers;
			if (record(config))
				for (const [key, entry] of Object.entries(config))
					if (name(key) && record(entry))
						servers.set(key, {
							name: key,
							status: entry.enabled === false ? "disabled" : "configured",
							tools: 0,
						});
		}
		for (const tool of all) {
			if (tool.sourceInfo?.path !== "builtin:mcp" || tool.exposure === "hidden") continue;
			const namespace = tool.namespace?.name;
			if (!namespace?.startsWith("mcp__")) continue;
			const key =
				[...servers.keys()].find((key) => `mcp__${key.replaceAll("-", "_")}` === namespace) ??
				namespace.slice(5);
			if (!name(key)) continue;
			const entry = servers.get(key) ?? { name: key, status: "available", tools: 0 };
			entry.status = "available";
			entry.tools++;
			servers.set(key, entry);
		}
		return publicSessionMetadata({
			version: 1,
			source: "live",
			...(model
				? {
						model: {
							id: model.id,
							name: model.name,
							provider: model.provider,
							contextWindow: model.contextWindow,
						},
					}
				: {}),
			thinkingLevel,
			...(usage
				? { context: { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } }
				: {}),
			...(active
				? { tools: { active, available: all.filter((tool) => tool.exposure !== "hidden").length } }
				: {}),
			...(commands
				? {
						skills: commands
							.filter((command) => command.source === "skill")
							.map((command) => ({ name: command.name, description: command.description })),
					}
				: {}),
			...(profile ? { profile } : {}),
			mcp: [...servers.values()],
		});
	};
}
