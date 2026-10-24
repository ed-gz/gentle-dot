import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOrchestrationTools } from "../src/extensions/dot-orchestrator.ts";
import { createDotSession } from "../src/extensions/dot-session.ts";
import { OrcaDisplay, runOrcaCli } from "../src/orchestration/displays.ts";
import { localRequest } from "../src/orchestration/herdr.ts";
import { Orchestrator } from "../src/orchestration/index.ts";
import { type Manifest, readManifests } from "../src/orchestration/registry.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

async function portable(provider: "terminal" | "orca" = "terminal") {
	const dataDir = await mkdtemp(join(tmpdir(), "dot-portable-"));
	cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
	const registryDir = join(dataDir, "pi-sessions");
	const handlers = new Map<string, (event: unknown, context: ExtensionContext) => Promise<void> | void>();
	const sendUserMessage = vi.fn();
	const abort = vi.fn();
	const shutdown = vi.fn();
	const branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]> = [];
	const context = {
		mode: "tui",
		cwd: dataDir,
		isIdle: () => true,
		abort,
		shutdown,
		sessionManager: {
			getSessionId: () => "portable-session",
			getSessionFile: () => undefined,
			getSessionName: () => "Portable fixture",
			getBranch: () => branch,
		},
		ui: {
			notify: vi.fn(),
			confirm: (_title: string, _message: string, options?: ExtensionUIDialogOptions) =>
				new Promise<boolean>((resolve) =>
					options?.signal?.addEventListener("abort", () => resolve(false), { once: true }),
				),
		},
	} as unknown as ExtensionContext;
	const extension = createDotSession(
		{
			on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) =>
				handlers.set(name, handler),
			sendUserMessage,
		} as unknown as ExtensionAPI,
		{
			GENTLE_DOT_SESSION_DIR: registryDir,
			...(provider === "orca" ? { ORCA_PANE_KEY: "own-orca-pane" } : {}),
		},
	);
	cleanups.push(() => extension.close());
	await handlers.get("session_start")?.({}, context);
	const filename = (await readdir(registryDir)).find((file) => file.endsWith(".json"));
	expect(filename).toBeDefined();
	const manifestPath = join(registryDir, filename ?? "missing");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
	const orchestrator = new Orchestrator({
		dataDir,
		socketPath: join(dataDir, "missing-herdr.sock"),
		registryDirs: [],
		pollMs: 0,
		orcaCommand: false,
		terminalLauncher: false,
	});
	cleanups.push(() => orchestrator.close());
	return {
		dataDir,
		registryDir,
		context,
		handlers,
		manifest,
		manifestPath,
		orchestrator,
		sendUserMessage,
		abort,
		shutdown,
		branch,
	};
}

describe("portable verified Pi sessions", () => {
	it("rechecks phone authorization after a delayed provider capability lookup", async () => {
		const h = await portable("orca");
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = false;
		const orchestrator = new Orchestrator({
			dataDir: h.dataDir,
			registryDirs: [],
			socketPath: join(h.dataDir, "missing-herdr.sock"),
			pollMs: 0,
			orcaCommand: "fixture-orca",
			orcaRun: async () => {
				entered = true;
				await pending;
				return { terminals: [] };
			},
			terminalLauncher: false,
		});
		cleanups.push(() => orchestrator.close());
		let authorized = true;
		const result = orchestrator.dispatch(
			{ action: "inspect", paneId: `pi:${h.manifest.instanceId}`, sessionId: h.manifest.sessionId },
			"human",
			() => authorized,
		);
		try {
			await expect.poll(() => entered).toBe(true);
			authorized = false;
			release();
			await expect(result).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		} finally {
			release();
		}
	});

	it("closes only the bound session through its native shutdown after a human request", async () => {
		const h = await portable();
		const paneId = `pi:${h.manifest.instanceId}`;
		const input = { action: "close", paneId, sessionId: h.manifest.sessionId };
		await expect(h.orchestrator.dispatch(input, "agent")).rejects.toMatchObject({ code: "HUMAN_REQUIRED" });
		await expect(
			h.orchestrator.dispatch({ ...input, sessionId: "other-session" }, "human"),
		).rejects.toMatchObject({ code: "SESSION_CHANGED" });
		await expect(h.orchestrator.dispatch(input, "human", () => false)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(h.shutdown).not.toHaveBeenCalled();
		await h.orchestrator.snapshot();
		await h.orchestrator.dispatch(input, "human");
		await expect.poll(() => h.shutdown.mock.calls.length).toBe(1);
		await h.handlers.get("session_shutdown")?.({}, h.context);
		expect(
			(await h.orchestrator.snapshot()).events.find((event) => event.type === "disconnected"),
		).toMatchObject({ intentional: true, paneId, sessionId: h.manifest.sessionId });
	});

	it("duplicates into a newly launched terminal with the source profile and a fresh transcript identity", async () => {
		const h = await portable();
		const launch = vi.fn(async () => {});
		const orchestrator = new Orchestrator({
			dataDir: h.dataDir,
			registryDirs: [],
			socketPath: join(h.dataDir, "missing-herdr.sock"),
			pollMs: 0,
			orcaCommand: false,
			terminalLauncher: ["fixture-terminal"],
			launchTerminal: launch,
		});
		cleanups.push(() => orchestrator.close());
		const input = {
			action: "duplicate",
			paneId: `pi:${h.manifest.instanceId}`,
			sessionId: h.manifest.sessionId,
		};
		await expect(orchestrator.dispatch(input, "agent")).rejects.toMatchObject({ code: "HUMAN_REQUIRED" });
		await expect(
			orchestrator.dispatch({ ...input, sessionId: "other-session" }, "human"),
		).rejects.toMatchObject({ code: "SESSION_CHANGED" });
		expect(launch).not.toHaveBeenCalled();
		const created = (await orchestrator.dispatch(input, "human")) as {
			sessionId: string;
			sourceSessionId: string;
		};
		expect(created.sourceSessionId).toBe(h.manifest.sessionId);
		expect(created.sessionId).not.toBe(h.manifest.sessionId);
		expect(h.context.sessionManager.getSessionId()).toBe(h.manifest.sessionId);
		expect(h.shutdown).not.toHaveBeenCalled();
		expect(launch).toHaveBeenCalledOnce();
		const args = (launch.mock.calls as unknown[][])[0]?.[1] as string[];
		expect(args).toContain("--session");
		expect(args).not.toContain("--fork");
		expect(args[0]).toBe("env");
		const file = args[args.indexOf("--session") + 1] as string;
		expect(JSON.parse((await readFile(file, "utf8")).split("\n")[0] as string).id).toBe(created.sessionId);
	});

	it("does not advertise duplication without a launcher and never exports a new copy in that case", async () => {
		const h = await portable();
		const input = { paneId: `pi:${h.manifest.instanceId}`, sessionId: h.manifest.sessionId };
		const inspected = (await h.orchestrator.dispatch({ action: "inspect", ...input }, "human")) as {
			capabilities: { close: boolean; duplicate: boolean };
		};
		expect(inspected.capabilities).toMatchObject({ close: true, duplicate: false });
		await expect(h.orchestrator.dispatch({ action: "duplicate", ...input }, "human")).rejects.toMatchObject({
			code: "NO_TERMINAL",
		});
		expect((await readdir(h.registryDir)).includes("copies")).toBe(false);
	});
	it("returns event-backed activity and the persisted result id through the portable socket", async () => {
		const h = await portable();
		const session = (await h.orchestrator.snapshot()).sessions[0];
		const inspect = () =>
			h.orchestrator.dispatch(
				{ action: "inspect", paneId: session?.paneId, sessionId: session?.sessionId },
				"human",
			);
		await h.handlers.get("tool_execution_start")?.(
			{ toolCallId: "own-command", toolName: "bash", args: { command: "pnpm test" } },
			h.context,
		);
		expect(await inspect()).toMatchObject({
			work: { commands: [{ id: "own-command", label: "pnpm test", status: "running", source: "live" }] },
		});
		h.branch.push({
			type: "message",
			id: "own-result",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolName: "bash",
				toolCallId: "own-command",
				content: [{ type: "text", text: "Fixture passed" }],
				isError: false,
				timestamp: Date.now(),
			},
		});
		await h.handlers.get("tool_execution_end")?.(
			{
				toolCallId: "own-command",
				toolName: "bash",
				result: { content: [{ type: "text", text: "Fixture passed" }] },
				isError: false,
			},
			h.context,
		);
		expect(await inspect()).toMatchObject({
			work: {
				commands: [{ id: "own-command", messageId: "own-result", status: "completed", source: "live" }],
			},
		});
		h.branch.splice(0);
		await h.handlers.get("session_tree")?.({}, h.context);
		expect(await inspect()).toMatchObject({ work: { commands: [], agents: [] } });
	});

	it.each(["terminal", "orca"] as const)(
		"continues and aborts %s sessions while Herdr is unavailable",
		async (provider) => {
			const h = await portable(provider);
			const snapshot = await h.orchestrator.snapshot();
			expect(snapshot.available).toBe(true);
			expect(snapshot.providers.find((item) => item.id === "herdr")?.available).toBe(false);
			expect(snapshot.sessions).toHaveLength(1);
			const session = snapshot.sessions[0];
			expect(session).toMatchObject({
				provider,
				connected: true,
				managed: true,
				capabilities: { inspect: true, prompt: true, abort: true, approvals: true },
			});
			const identity = { paneId: session?.paneId, sessionId: session?.sessionId };
			await h.orchestrator.dispatch(
				{ action: "prompt", ...identity, text: "/this must remain literal" },
				"agent",
			);
			expect(h.sendUserMessage).toHaveBeenCalledWith("/this must remain literal", {
				deliverAs: "followUp",
				expandPromptTemplates: false,
			});
			const question = h.context.ui.confirm("Only fixture", "No tool or external mutation");
			await expect(
				h.orchestrator.dispatch({ action: "prompt", ...identity, text: "continue" }, "agent"),
			).rejects.toMatchObject({ code: "QUESTION_PENDING" });
			const blocked = await h.orchestrator.snapshot();
			expect(blocked.approvals[0]?.answerable).toBe(true);
			await h.orchestrator.dispatch({ action: "abort", ...identity }, "human");
			await expect(question).resolves.toBe(false);
			expect(h.abort).toHaveBeenCalledOnce();
		},
	);

	it("rejects stale process identities, insecure manifests and wrong instance IDs before control", async () => {
		const h = await portable();
		await expect(
			localRequest(h.manifest.socketPath, "prompt", {
				expectedSessionId: h.manifest.sessionId,
				expectedInstanceId: randomUUID(),
				text: "go",
			}),
		).rejects.toMatchObject({ code: "INSTANCE_CHANGED" });
		expect(h.sendUserMessage).not.toHaveBeenCalled();
		await writeFile(h.manifestPath, JSON.stringify({ ...h.manifest, processIdentity: "reused-pid" }));
		expect(await readManifests([h.registryDir], "/missing")).toEqual([]);
		await writeFile(h.manifestPath, JSON.stringify(h.manifest));
		await chmod(h.manifestPath, 0o644);
		expect(await readManifests([h.registryDir], "/missing")).toEqual([]);
		await chmod(h.manifestPath, 0o600);
		expect(await readManifests([h.registryDir], "/missing")).toHaveLength(1);
	});

	it("invalidates old instance IDs when Pi resumes the same session", async () => {
		const h = await portable();
		const old = (await h.orchestrator.snapshot()).sessions[0];
		await h.handlers.get("session_start")?.({}, h.context);
		const current = (await h.orchestrator.snapshot()).sessions[0];
		expect(current?.sessionId).toBe(old?.sessionId);
		expect(current?.paneId).not.toBe(old?.paneId);
		await expect(
			h.orchestrator.dispatch(
				{ action: "prompt", paneId: old?.paneId, sessionId: old?.sessionId, text: "stale" },
				"agent",
			),
		).rejects.toMatchObject({ code: "UNBOUND" });
		expect(h.sendUserMessage).not.toHaveBeenCalled();
	});
});

describe("display provider boundaries", () => {
	it("uses the public Orca terminal contract without sending input to existing terminals", async () => {
		const run = vi.fn(async (_program: string, args: string[]) =>
			args[1] === "list"
				? {
						terminals: [
							{ handle: "term_own", title: "Fixture", worktreePath: "/fixture", executionHostId: "local" },
						],
					}
				: args[0] === "worktree"
					? { worktree: { id: "own-worktree", hostId: "local" } }
					: { terminal: { handle: "term_new" } },
		);
		const display = new OrcaDisplay("/orca", run);
		expect((await display.list()).panes[0]).toMatchObject({ pane_id: "orca:term_own", provider: "orca" });
		await display.create("/fixture", "$(literal)", "'pi' '-e' '/adapter'", () => true);
		expect(run.mock.calls[2]?.[1]).toEqual([
			"terminal",
			"create",
			"--worktree",
			"id:own-worktree",
			"--title",
			"$(literal)",
			"--command",
			"'pi' '-e' '/adapter'",
		]);
	});

	it("launches only a new configured terminal with argv and never writes into Herdr", async () => {
		const h = await portable();
		const launch = vi.fn(async () => {});
		const request = vi.fn(async () => {
			throw new Error("must not call Herdr");
		});
		const orchestrator = new Orchestrator({
			dataDir: h.dataDir,
			pollMs: 0,
			orcaCommand: false,
			terminalLauncher: ["/kitty", "--"],
			piCommand: "/path with spaces/pi",
			piArgs: ["--offline"],
			launchTerminal: launch,
			request,
		});
		cleanups.push(() => orchestrator.close());
		await orchestrator.dispatch({ action: "create", provider: "terminal", cwd: h.dataDir }, "human");
		expect(launch.mock.calls[0]).toEqual([
			["/kitty", "--"],
			["/path with spaces/pi", "--offline", "-e", expect.stringContaining("dot-session.ts")],
			h.dataDir,
			join(h.dataDir, "pi-sessions"),
			expect.any(Function),
		]);
		expect(request).not.toHaveBeenCalled();
	});

	it("pins Orca CLI to local and rejects revoked calls before starting a process", async () => {
		await expect(runOrcaCli("/must/not/execute", ["terminal", "create"], () => false)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		// A controlled executable reports argv and environment; no Orca instance is contacted.
		const directory = await mkdtemp(join(tmpdir(), "dot-cli-"));
		cleanups.push(() => rm(directory, { recursive: true, force: true }));
		const fixture = join(directory, "cli.mjs");
		await writeFile(
			fixture,
			"#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,result:{args:process.argv.slice(2),hasCaller:!!process.env.ORCA_PANE_KEY}}))\n",
			{ mode: 0o700 },
		);
		const result = await runOrcaCli(fixture, ["terminal", "list", "--limit", "100"]);
		expect(result.args).toEqual(["terminal", "list", "--limit", "100", "--json"]);
		expect(result.hasCaller).toBe(false);
	});

	it("exposes abort and providers to the model, without approval operations", async () => {
		let registered: Record<string, unknown> | undefined;
		const call = vi.fn(async () => ({ accepted: true }));
		registerOrchestrationTools(
			{
				registerTool: (tool: Record<string, unknown>) => {
					registered = tool;
				},
			} as unknown as ExtensionAPI,
			call,
		);
		const tool = registered as unknown as {
			name: string;
			execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
		};
		expect(tool.name).toBe("dot_sessions");
		await tool.execute("1", { action: "abort", paneId: "pi:own", sessionId: "own" });
		await expect(tool.execute("2", { action: "answer", approved: true })).rejects.toThrow(/persona/);
		expect(call).toHaveBeenCalledOnce();
	});
});
