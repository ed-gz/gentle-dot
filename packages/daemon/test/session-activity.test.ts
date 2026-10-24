import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	discoverAndLoadExtensions,
	type ExtensionToolContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { projectSessionWork, SessionActivity } from "../src/orchestration/activity.ts";
import { boundSessionWork, readLiveAgents } from "../src/orchestration/activity-files.ts";
import { tempDir } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const dir = () => {
	const path = tempDir();
	dirs.push(path);
	return path;
};
const entry = (id: string, message: object, parentId: string | null = null) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-10-11T00:00:00.000Z",
	message,
});
const result = (toolName: string, details: object, toolCallId = "call-1") => ({
	role: "toolResult",
	toolName,
	toolCallId,
	content: [{ type: "text", text: "PRIVATE_OUTPUT_DO_NOT_EXPORT" }],
	details,
});

it("projects actual Pi transcript tool calls/results without arguments, output, thinking or hidden custom data", () => {
	const work = projectSessionWork([
		entry("assistant", {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "PRIVATE_REASONING" },
				{
					type: "toolCall",
					id: "call-1",
					name: "bash",
					arguments: { command: "pnpm test", private: "PRIVATE_ARGUMENT" },
				},
			],
		}),
		entry("tool-entry", result("bash", { arbitrary: "PRIVATE_DETAIL" })),
		{
			type: "custom_message",
			customType: "untrusted-plugin",
			details: { gentleAgents: { taskId: "bad", agent: "not-real", status: "running" } },
		},
	]);
	expect(work.commands).toEqual([
		expect.objectContaining({
			id: "call-1",
			messageId: "tool-entry",
			tool: "bash",
			label: "pnpm test",
			status: "completed",
			source: "history",
		}),
	]);
	expect(work.agents).toEqual([]);
	expect(JSON.stringify(work)).not.toContain("PRIVATE_");
});

it("uses execution events for live status, keeps result entry identity, and resets on session replacement", () => {
	const activity = new SessionActivity();
	activity.start({ toolCallId: "run", toolName: "bash", args: { command: "git status --short" } }, 1000);
	expect(activity.snapshot([]).commands[0]).toMatchObject({
		status: "running",
		source: "live",
		startedAt: new Date(1000).toISOString(),
	});
	activity.end({ toolCallId: "run", toolName: "bash", result: { content: "SECRET" }, isError: true }, 2000);
	expect(activity.snapshot([entry("result-id", result("bash", {}, "run"))]).commands[0]).toMatchObject({
		status: "failed",
		messageId: "result-id",
		finishedAt: new Date(2000).toISOString(),
	});
	activity.start({ toolCallId: "interrupted", toolName: "read", args: {} });
	activity.settled();
	expect(activity.snapshot([]).commands.find((command) => command.id === "interrupted")?.status).toBe(
		"unknown",
	);
	activity.reset();
	expect(activity.snapshot([]).commands).toEqual([]);
});

it("redacts recognizable credentials and hides risky shell invocations while bounding every projection", () => {
	const activity = new SessionActivity();
	for (const [index, command] of [
		"curl https://api.invalid --header 'Authorization: Bearer secret'",
		"cat .env",
		"TOKEN=secret run",
		"printenv",
		"python -c 'x'\nmore",
	].entries())
		activity.start({ toolCallId: String(index), toolName: "bash", args: { command } });
	expect(activity.snapshot([]).commands.every((command) => command.label === "bash · comando privado")).toBe(
		true,
	);
	for (let i = 0; i < 40; i++)
		activity.start({
			toolCallId: `tool-${i}`,
			toolName: "bash",
			args: { command: `echo ${"a".repeat(100_000)}` },
		});
	const work = activity.snapshot([
		entry(
			"plan",
			result("todo", {
				gentleTodo: {
					tasks: Array.from({ length: 100 }, (_, i) => ({
						id: i + 1,
						title: `Task ${i}`,
						status: "pending",
						note: "authorization: Bearer private-token",
					})),
				},
			}),
		),
	]);
	expect(work.truncated).toBe(true);
	expect(work.commands).toHaveLength(20);
	expect(work.commands.every((command) => command.label.length <= 180)).toBe(true);
	expect(work.plan?.tasks).toHaveLength(50);
	expect(JSON.stringify(work)).not.toContain("private-token");
	expect(Buffer.byteLength(JSON.stringify(work))).toBeLessThan(40_000);
});

it("replays Gentle Todo, legacy rpiv, and Gentle Agents custom results as observations, not live status", () => {
	const work = projectSessionWork([
		entry("old-plan", result("todo", { tasks: [{ id: 1, subject: "Antigua", status: "pending" }] })),
		entry(
			"plan",
			result("todo", {
				gentleTodo: {
					tasks: [
						{ id: 7, title: "Revisar", status: "done" },
						{ id: 8, title: "Probar", status: "in_progress" },
					],
				},
			}),
		),
		entry(
			"agent-run",
			result("subagent_run", {
				gentleAgents: { taskId: "task-a", agent: "research", status: "running", cwd: "/PRIVATE_CWD" },
			}),
		),
		{
			type: "custom_message",
			customType: "gentle-agents.result",
			details: { gentleAgents: { taskId: "task-a", agent: "research", status: "completed" } },
		},
		{
			type: "custom",
			customType: "gentle-agents.stale-result",
			data: { taskId: "task-b", agent: "test", status: "failed" },
		},
	]);
	expect(work.plan).toMatchObject({ completed: 1, total: 2, source: "history" });
	expect(work.agents).toEqual([
		expect.objectContaining({ id: "task-a", status: "completed", source: "history" }),
		expect.objectContaining({ id: "task-b", status: "failed", source: "history" }),
	]);
	expect(JSON.stringify(work)).not.toContain("PRIVATE_CWD");
	expect(
		projectSessionWork([entry("clear", result("todo", { gentleTodo: { tasks: [] } }))]).plan?.total,
	).toBe(0);
});

it("loads real Gentle Todo through Pi and projects its actual saved result", async () => {
	const root = dir();
	const extension = fileURLToPath(
		new URL("../node_modules/gentle-pi/extensions/gentle-todo.ts", import.meta.url),
	);
	const loaded = await discoverAndLoadExtensions([extension], root, root);
	expect(loaded.errors).toEqual([]);
	const tool = loaded.extensions[0]?.tools.get("todo")?.definition;
	expect(tool).toBeDefined();
	const manager = SessionManager.inMemory(root);
	const context = { sessionManager: manager, hasUI: false } as unknown as ExtensionToolContext;
	const actual = await tool?.execute(
		"real-todo",
		{
			action: "write",
			tasks: [
				{ title: "Investigar", status: "done" },
				{ title: "Validar", status: "in_progress" },
			],
		},
		undefined,
		undefined,
		context,
	);
	if (!actual) throw new Error("Todo result missing");
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "real-todo",
		toolName: "todo",
		content: actual.content,
		details: actual.details as never,
		isError: false,
		timestamp: Date.now(),
	});
	const work = projectSessionWork(manager.getBranch());
	expect(work.plan).toMatchObject({
		total: 2,
		completed: 1,
		tasks: [
			expect.objectContaining({ title: "Investigar", status: "done" }),
			expect.objectContaining({ title: "Validar", status: "in_progress" }),
		],
	});
});

function transcriptFixture() {
	const root = dir();
	const sessionFile = join(root, "session.jsonl");
	const header = { type: "session", version: 3, id: "session-a", cwd: root };
	const plan = entry(
		"plan",
		result("todo", { gentleTodo: { tasks: [{ id: 1, title: "Active branch", status: "in_progress" }] } }),
	);
	const active = entry(
		"active-leaf",
		{ role: "assistant", content: [{ type: "text", text: "Selected branch" }] },
		"plan",
	);
	const other = entry(
		"other-leaf",
		result("todo", { gentleTodo: { tasks: [{ id: 2, title: "OTHER_BRANCH", status: "done" }] } }),
		"plan",
	);
	writeFileSync(
		sessionFile,
		`${[header, plan, active, other].map((item) => JSON.stringify(item)).join("\n")}\n`,
		{ mode: 0o600 },
	);
	const identity = { sessionId: "session-a", sessionFile, cwd: root };
	const page = { sessionId: "session-a", messages: [{ id: "active-leaf", role: "assistant", content: [] }] };
	return { root, identity, page, header, plan, active, other };
}

it("recovers legacy work from the verified active branch, not the final JSONL branch, and invalidates cached changes", () => {
	const h = transcriptFixture();
	const first = boundSessionWork(h.identity, h.page);
	expect(first.plan?.tasks[0]?.title).toBe("Active branch");
	expect(JSON.stringify(first)).not.toContain("OTHER_BRANCH");
	expect(boundSessionWork(h.identity, h.page).plan).toEqual(first.plan);
	const content = readFileSync(h.identity.sessionFile, "utf8").replace("Active branch", "Updated task");
	writeFileSync(h.identity.sessionFile, content);
	expect(boundSessionWork(h.identity, h.page).plan?.tasks[0]?.title).toBe("Updated task");
	expect(
		boundSessionWork(h.identity, { ...h.page, messages: [{ id: "other-leaf", role: "tool", content: [] }] })
			.plan?.tasks[0]?.title,
	).toBe("OTHER_BRANCH");
});

it("refuses mismatched sessions, directories and symlinks even after a valid cached read", () => {
	const h = transcriptFixture();
	boundSessionWork(h.identity, h.page);
	expect(boundSessionWork({ ...h.identity, sessionId: "wrong" }, h.page).plan).toBeUndefined();
	expect(boundSessionWork({ ...h.identity, cwd: dir() }, h.page).plan).toBeUndefined();
	const linked = join(h.root, "linked.jsonl");
	symlinkSync(h.identity.sessionFile, linked);
	expect(boundSessionWork({ ...h.identity, sessionFile: linked }, h.page).plan).toBeUndefined();
	const copy = readFileSync(h.identity.sessionFile);
	rmSync(h.identity.sessionFile);
	const target = join(h.root, "target.jsonl");
	writeFileSync(target, copy);
	symlinkSync(target, h.identity.sessionFile);
	expect(boundSessionWork(h.identity, h.page).plan).toBeUndefined();
});

it("reads a bounded tail of a large legacy transcript and never incorporates a sibling branch", () => {
	const h = transcriptFixture();
	const large = entry("old-large", {
		role: "assistant",
		content: [{ type: "text", text: "x".repeat(10 * 1024 * 1024) }],
	});
	const plan = { ...h.plan, parentId: "old-large" };
	const agent = entry(
		"tail-agent",
		result("subagent_run", { gentleAgents: { taskId: "tail-task", agent: "review", status: "running" } }),
		"plan",
	);
	const active = { ...h.active, parentId: "tail-agent" };
	writeFileSync(
		h.identity.sessionFile,
		`${[h.header, large, plan, agent, active, h.other].map((item) => JSON.stringify(item)).join("\n")}\n`,
	);
	const work = boundSessionWork(h.identity, h.page);
	expect(work.truncated).toBe(true);
	expect(work.plan?.tasks[0]?.title).toBe("Active branch");
	expect(work.agents).toEqual([
		expect.objectContaining({ id: "tail-task", agent: "review", status: "running", source: "history" }),
	]);
	expect(JSON.stringify(work)).not.toContain("OTHER_BRANCH");
	expect(boundSessionWork(h.identity, h.page).plan).toEqual(work.plan);
});

function presenceFixture() {
	const root = dir();
	const presence = join(root, "gentle-agents", "presence");
	mkdirSync(presence, { recursive: true, mode: 0o700 });
	const sessionHash = createHash("sha256").update("session-a").digest("hex");
	const incarnation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const body = {
		schema: 1,
		sessionHash,
		incarnation,
		generation: 1,
		activity: {
			tasks: [
				{
					summary: {
						id: "task-1",
						agent: "research",
						label: "Revisando",
						status: "running",
						lastActivityAt: 1000,
					},
					thread: { items: [{ kind: "thinking", text: "PRIVATE_THINKING" }] },
				},
			],
		},
	};
	const bytes = JSON.stringify(body);
	const digest = createHash("sha256").update(bytes).digest("hex");
	const header = {
		schema: 1,
		sessionHash,
		incarnation,
		generation: 1,
		heartbeat: 1000,
		digest,
		unavailable: null,
	};
	const base = join(presence, `${sessionHash}.${incarnation}`);
	writeFileSync(`${base}.header.json`, JSON.stringify(header), { mode: 0o600 });
	writeFileSync(`${base}.activity.json`, bytes, { mode: 0o600 });
	return { root, base, header };
}
it("uses only fresh, single-incarnation, digest-bound presence for live subagents and omits child reasoning", () => {
	const h = presenceFixture();
	const live = readLiveAgents(h.root, "session-a", 2000);
	const work = new SessionActivity().snapshot([], live, 2000);
	expect(work.agents[0]).toMatchObject({ id: "task-1", status: "running", source: "live" });
	expect(JSON.stringify(work)).not.toContain("PRIVATE_THINKING");
	expect(readLiveAgents(h.root, "different-session", 2000)).toEqual([]);
	expect(readLiveAgents(h.root, "session-a", 20_000)).toEqual([]);
	writeFileSync(`${h.base}.activity.json`, "{}", { mode: 0o600 });
	expect(readLiveAgents(h.root, "session-a", 2000)).toEqual([]);
});

it("finds active subagents after completed history without spending the live card limit on settled tasks", () => {
	const h = presenceFixture();
	const body = JSON.parse(readFileSync(`${h.base}.activity.json`, "utf8"));
	body.activity.tasks = [
		...Array.from({ length: 30 }, (_, id) => ({
			summary: { id: `completed-${id}`, agent: "reviewer", status: "completed" },
		})),
		{ summary: { id: "active", agent: "researcher", status: "running" } },
		{ summary: { id: "queued", agent: "writer", status: "queued" } },
	];
	const bytes = JSON.stringify(body);
	writeFileSync(`${h.base}.activity.json`, bytes);
	writeFileSync(
		`${h.base}.header.json`,
		JSON.stringify({ ...h.header, digest: createHash("sha256").update(bytes).digest("hex") }),
	);
	expect(readLiveAgents(h.root, "session-a", 2000)).toEqual([
		{ id: "active", agent: "researcher", status: "running" },
		{ id: "queued", agent: "writer", status: "queued" },
	]);
});
