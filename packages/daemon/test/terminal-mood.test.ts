import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { registerTerminalMoodTool } from "../src/extensions/dot-companion.ts";
import { privateKittyLauncher } from "../src/orchestration/displays.ts";
import { processIdentity } from "../src/orchestration/process-identity.ts";
import {
	kittyWindows,
	TerminalMoodController,
	type TerminalMoodHost,
	type TerminalMoodSource,
	terminalMoodInput,
} from "../src/terminal-mood.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT } from "./helpers.ts";

const directories: string[] = [],
	daemons: DotDaemon[] = [];
const installedLauncher = [
	"/usr/bin/systemd-run",
	"--user",
	"--scope",
	"--collect",
	"--quiet",
	"/usr/bin/kitty",
	"--",
];
afterEach(async () => {
	for (const daemon of daemons.splice(0)) await daemon.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory() {
	const path = mkdtempSync(join(tmpdir(), "dot-mood-test-"));
	directories.push(path);
	return path;
}
function fixture() {
	const target = {
		paneId: "pi:one",
		pid: 42,
		processIdentity: "boot:42",
		sessionId: "one",
		instanceId: "instance-one",
		peers: [{ paneId: "pi:one", pid: 42, processIdentity: "boot:42" }],
	};
	const source = { terminalTarget: vi.fn(async () => target) } satisfies TerminalMoodSource;
	const host = {
		tree: vi.fn((pid: number) => ({
			pids: [pid, 40, 39],
			names: ["pi", "sh", "kitty"],
			kittyPid: 39,
			windowId: 7,
			address: "unix:/private/control.sock",
		})),
		identity: vi.fn(async (pid: number) => `boot:${pid}`),
		socket: vi.fn((address: string) => address),
		run: vi.fn(async (_address: string, args: string[]) => {
			if (args[0] === "ls")
				return [
					{
						tabs: [
							{
								windows: [
									{ id: 7, pid: 40 },
									{ id: 8, pid: 88 },
								],
							},
						],
					},
				];
			const request = JSON.parse(args[4]!);
			return {
				ok: true,
				windowId: 7,
				verified: true,
				mood: request.mood === "inspect" || request.mood === "restore" ? null : request.mood,
				canRestore: !["inspect", "restore"].includes(request.mood),
			};
		}),
	} satisfies TerminalMoodHost;
	return { target, source, host, controller: new TerminalMoodController(source, host) };
}

it("accepts only bounded presets, a live pane identifier and explicit shared-window consent", () => {
	expect(terminalMoodInput({ paneId: "pi:one", mood: "hacker" })).toEqual({
		paneId: "pi:one",
		mood: "hacker",
		allowSharedWindow: false,
	});
	for (const input of [
		{ paneId: "", mood: "hacker" },
		{ paneId: "x", mood: "#ff0000" },
		{ paneId: "x", mood: "restore", socket: "/tmp/arbitrary" },
		{ paneId: "x", mood: "hacker", allowSharedWindow: "true" },
	])
		expect(() => terminalMoodInput(input)).toThrow();
	expect(
		kittyWindows([
			{
				tabs: [
					{
						windows: [
							{ id: -1, pid: 4 },
							{ id: "7 or all", pid: 4 },
							{ id: 3, pid: 4 },
						],
					},
				],
			},
		]),
	).toEqual([{ id: 3, pid: 4 }]);
});

it("targets only the validated exact window with a fixed no-UI bridge and verifies the result", async () => {
	const f = fixture();
	expect(await f.controller.apply({ paneId: "pi:one", mood: "hacker" }, () => true)).toMatchObject({
		available: true,
		scope: "window",
		windowId: 7,
		affectedPaneIds: ["pi:one"],
		mood: "hacker",
		verified: true,
		canRestore: true,
	});
	const args = f.host.run.mock.calls[1]![1];
	expect(args.slice(0, 3)).toEqual(["kitten", "--match", "id:7"]);
	expect(args[3]).toBe(fileURLToPath(new URL("../src/terminal-mood.py", import.meta.url)));
	expect(JSON.parse(args[4]!)).toMatchObject({
		mood: "hacker",
		childPid: 40,
		kittyPid: 39,
		kittyIdentity: "boot:39",
		processIdentity: "boot:42",
		pid: 42,
	});
	expect(args.join(" ")).not.toMatch(/send-text|set-colors|--all|--configured|--reset/);
	expect(f.source.terminalTarget).toHaveBeenCalledTimes(2);
});

it("reports unsupported existing terminals without attempting input or enabling control", async () => {
	const f = fixture();
	f.host.tree.mockReturnValue({
		pids: [42, 40, 39],
		names: ["pi", "herdr", "kitty"],
		kittyPid: 39,
		windowId: 7,
		address: "",
	});
	expect(await f.controller.read("pi:one", () => true)).toMatchObject({
		available: false,
		reason: expect.stringContaining("Nueva sesión"),
		affectedPaneIds: ["pi:one"],
	});
	expect(f.host.run).not.toHaveBeenCalled();
	await expect(f.controller.apply({ paneId: "pi:one", mood: "hacker" }, () => true)).rejects.toMatchObject({
		code: "MOOD_UNAVAILABLE",
	});
});

it("requires confirmation for shared windows and reports all known affected panes", async () => {
	const f = fixture();
	f.target.peers.push({ paneId: "pi:two", pid: 43, processIdentity: "boot:43" });
	expect(await f.controller.read("pi:one", () => true)).toMatchObject({
		sharedWindow: true,
		requiresSharedConfirmation: true,
		affectedPaneIds: ["pi:one", "pi:two"],
	});
	f.host.run.mockClear();
	await expect(f.controller.apply({ paneId: "pi:one", mood: "hacker" }, () => true)).rejects.toMatchObject({
		code: "SHARED_WINDOW",
		status: 409,
	});
	expect(f.host.run.mock.calls.every((call) => call[1][0] === "ls")).toBe(true);
	expect(
		await f.controller.apply({ paneId: "pi:one", mood: "sunset", allowSharedWindow: true }, () => true),
	).toMatchObject({ verified: true, sharedWindow: true, mood: "sunset" });
});

it("fails closed if the session identity changes or device access is revoked before application", async () => {
	const f = fixture();
	f.source.terminalTarget
		.mockResolvedValueOnce(f.target)
		.mockResolvedValueOnce({ ...f.target, instanceId: "replaced" });
	await expect(f.controller.apply({ paneId: "pi:one", mood: "afterlife" }, () => true)).rejects.toMatchObject(
		{ code: "SESSION_CHANGED" },
	);
	expect(f.host.run.mock.calls.every((call) => call[1][0] === "ls")).toBe(true);
	await expect(f.controller.read("pi:one", () => false)).rejects.toMatchObject({ status: 401 });
	const reused = fixture();
	reused.host.identity.mockResolvedValue("boot:reused");
	await expect(
		reused.controller.apply({ paneId: "pi:one", mood: "hacker" }, () => true),
	).rejects.toMatchObject({ code: "MOOD_UNAVAILABLE" });
	expect(reused.host.run).not.toHaveBeenCalled();
	const revoked = fixture();
	let access = true;
	revoked.source.terminalTarget.mockResolvedValueOnce(revoked.target).mockImplementationOnce(async () => {
		access = false;
		return revoked.target;
	});
	await expect(
		revoked.controller.apply({ paneId: "pi:one", mood: "hacker" }, () => access),
	).rejects.toMatchObject({ status: 401 });
	expect(revoked.host.run.mock.calls.every((call) => call[1][0] === "ls")).toBe(true);
});

it("rejects ambiguous or forged Kitty bindings before running a bridge", async () => {
	const ambiguous = fixture();
	ambiguous.host.run.mockResolvedValueOnce([
		{
			tabs: [
				{
					windows: [
						{ id: 7, pid: 40 },
						{ id: 8, pid: 40 },
					],
				},
			],
		},
	]);
	expect(await ambiguous.controller.read("pi:one", () => true)).toMatchObject({
		available: false,
		reason: expect.stringContaining("una sola ventana"),
	});
	expect(ambiguous.host.run.mock.calls.every((call) => call[1][0] === "ls")).toBe(true);
	const forged = fixture();
	forged.host.tree.mockReturnValue({
		pids: [42, 40, 39],
		names: ["pi", "sh", "unrelated"],
		kittyPid: 39,
		windowId: 7,
		address: "unix:/private/control.sock",
	});
	expect(await forged.controller.read("pi:one", () => true)).toMatchObject({ available: false });
	expect(forged.host.run).not.toHaveBeenCalled();
});

it("never reports success for an unverified or mismatched palette", async () => {
	const f = fixture();
	f.host.run
		.mockResolvedValueOnce([{ tabs: [{ windows: [{ id: 7, pid: 40 }] }] }])
		.mockResolvedValueOnce({ ok: true, verified: true, windowId: 7, mood: "sunset", canRestore: true });
	await expect(f.controller.apply({ paneId: "pi:one", mood: "hacker" }, () => true)).rejects.toMatchObject({
		code: "MOOD_UNCONFIRMED",
	});
});

it("prepares only new ordinary Kitty launches with a private per-instance Unix socket", () => {
	const a = privateKittyLauncher(["/usr/bin/kitty", "--"]),
		b = privateKittyLauncher(["/usr/bin/kitty", "--"]);
	directories.push(a.socketDir!, b.socketDir!);
	expect(a.socketDir).not.toBe(b.socketDir);
	expect(statSync(a.socketDir!).mode & 0o777).toBe(0o700);
	expect(a.launcher).toEqual([
		"/usr/bin/kitty",
		"--listen-on",
		`unix:${a.socketDir}/control.sock`,
		"-o",
		"allow_remote_control=socket-only",
		"--",
	]);
	for (const launcher of [
		["kitty", "--single-instance", "--"],
		["kitty", "-1", "--"],
		["custom-terminal", "--"],
	])
		expect(privateKittyLauncher(launcher)).toEqual({ launcher });
	const scoped = privateKittyLauncher(installedLauncher);
	directories.push(scoped.socketDir!);
	expect(scoped.launcher.slice(0, 6)).toEqual(installedLauncher.slice(0, 6));
	expect(scoped.launcher.slice(6)).toEqual([
		"--listen-on",
		`unix:${scoped.socketDir}/control.sock`,
		"-o",
		"allow_remote_control=socket-only",
		"--",
	]);
	const unsafe = ["/usr/bin/systemd-run", "--user", "--scope", "--no-block", "/usr/bin/kitty", "--"];
	expect(privateKittyLauncher(unsafe)).toEqual({ launcher: unsafe });
});

it("requires human authentication and does not let human tokens impersonate the companion", async () => {
	const dir = directory(),
		f = fixture();
	const daemon = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir: dir,
		workspace: join(dir, "work"),
		uiDir: dir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		authRuntime: async () => fakeAuthRuntime().runtime,
		terminalMood: f.controller,
	});
	daemons.push(daemon);
	const base = `http://127.0.0.1:${daemon.port}`,
		url = `${base}/api/mobile/terminal-mood?paneId=pi:one`;
	expect((await fetch(url)).status).toBe(401);
	const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
	expect(await (await fetch(url, { headers })).json()).toMatchObject({ available: true, scope: "window" });
	expect(
		(
			await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify({ paneId: "pi:one", mood: "shell command" }),
			})
		).status,
	).toBe(400);
	expect(
		await (
			await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify({ paneId: "pi:one", mood: "hacker" }),
			})
		).json(),
	).toMatchObject({ verified: true, mood: "hacker" });
	expect(
		(
			await fetch(`${base}/api/companion/agent`, {
				method: "POST",
				headers,
				body: JSON.stringify({ paneId: "pi:one", mood: "hacker" }),
			})
		).status,
	).toBe(401);
});

it("registers a strict tool that refuses unsupported arguments and unconfirmed outcomes", async () => {
	const registered = vi.fn(),
		apply = vi.fn(async () => ({ verified: true, mood: "hacker" }));
	registerTerminalMoodTool({ registerTool: registered } as unknown as ExtensionAPI, apply);
	const tool = registered.mock.calls[0]![0];
	expect(tool.name).toBe("set_terminal_mood");
	expect(tool.parameters.additionalProperties).toBe(false);
	expect(tool.description).toContain("SHARED_WINDOW");
	await expect(
		tool.execute("id", { paneId: "pi:one", mood: "hacker", command: "echo injected" }),
	).rejects.toThrow();
	expect(apply).not.toHaveBeenCalled();
	expect(await tool.execute("id", { paneId: "pi:one", mood: "hacker" })).toMatchObject({
		content: [{ type: "text", text: expect.stringContaining('"verified":true') }],
	});
	apply.mockResolvedValueOnce({ verified: false, mood: "hacker" });
	await expect(tool.execute("id", { paneId: "pi:one", mood: "hacker" })).rejects.toThrow("no confirmó");
});

// Explicit opt-in launches a separate hidden Kitty with --config NONE. It never
// addresses any existing user's socket, terminal window, config or Shell process.
it.skipIf(process.env.GENTLE_DOT_TEST_KITTY !== "1")(
	"isolated real Kitty preserves transparency, other windows and original override inheritance",
	async () => {
		const dir = directory();
		const prepared = privateKittyLauncher(installedLauncher);
		directories.push(prepared.socketDir!);
		const address = `unix:${join(prepared.socketDir!, "control.sock")}`;
		const session = join(dir, "session.conf");
		writeFileSync(
			session,
			"new_tab first\nlaunch /usr/bin/sleep 120\nnew_tab second\nlaunch /usr/bin/sleep 120\n",
		);
		const inspect = join(dir, "inspect.py");
		writeFileSync(
			inspect,
			`import json\nfrom kittens.tui.handler import result_handler\ndef main(args): pass\n@result_handler(no_ui=True)\ndef handle_result(args, data, wid, boss):\n w = boss.window_id_map[wid]\n return json.dumps({k: repr(v) for k,v in w.screen.color_profile.as_dict().items()})\n`,
		);
		const env = { ...process.env };
		for (const key of [
			"KITTY_PID",
			"KITTY_WINDOW_ID",
			"KITTY_LISTEN_ON",
			"KITTY_PUBLIC_KEY",
			"KITTY_RC_PASSWORD",
		])
			delete env[key];
		const child = spawn(
			prepared.launcher[0]!,
			[
				...prepared.launcher.slice(1, -1),
				"--config",
				"NONE",
				"--start-as",
				"hidden",
				"-o",
				"transparent_background_colors=#123456@0.3",
				"--session",
				session,
			],
			{ env, stdio: "ignore" },
		);
		const run = async (...args: string[]) =>
			JSON.parse(
				(
					await promisify(execFile)("kitty", ["@", "--to", address, "--use-password", "never", ...args], {
						timeout: 5000,
						env,
					})
				).stdout,
			);
		try {
			let windows: ReturnType<typeof kittyWindows> = [];
			await vi.waitFor(
				async () => {
					windows = kittyWindows(await run("ls"));
					expect(windows).toHaveLength(2);
				},
				{ timeout: 12_000, interval: 150 },
			);
			const first = windows[0]!,
				second = windows[1]!;
			const target = {
				paneId: "pi:isolated",
				pid: first.pid,
				processIdentity: (await processIdentity(first.pid))!,
				sessionId: "isolated",
				instanceId: "isolated-instance",
				peers: [],
			};
			const controller = new TerminalMoodController({ terminalTarget: async () => target });
			const capture = (id: number) => run("kitten", "--match", `id:${id}`, inspect);
			const original = await capture(first.id),
				untouched = await capture(second.id);
			const measured = await controller.geometry(target.paneId, target.sessionId, () => true);
			expect(measured.kittyPid).toBeGreaterThan(1);
			expect(measured.geometry).toMatchObject({
				columns: expect.any(Number),
				rows: expect.any(Number),
				left: expect.any(Number),
				top: expect.any(Number),
				viewportWidth: expect.any(Number),
				viewportHeight: expect.any(Number),
				cellWidth: expect.any(Number),
				cellHeight: expect.any(Number),
			});
			expect(Object.keys(measured.geometry as object).sort()).toEqual(
				[
					"active",
					"cellHeight",
					"cellWidth",
					"columns",
					"cursorVisible",
					"cursorX",
					"cursorY",
					"focused",
					"left",
					"rows",
					"top",
					"viewportHeight",
					"viewportWidth",
				].sort(),
			);
			expect(await capture(first.id)).toEqual(original);
			expect(await capture(second.id)).toEqual(untouched);
			expect(await controller.read(target.paneId, () => true)).toMatchObject({
				available: true,
				canRestore: false,
				mood: null,
			});
			for (const mood of ["hacker", "afterlife", "sunset"]) {
				expect(await controller.apply({ paneId: target.paneId, mood }, () => true)).toMatchObject({
					verified: true,
					mood,
					canRestore: true,
				});
				const changed = await capture(first.id);
				expect(changed.background).not.toBe(original.background);
				expect(changed.transparent_background_colors).toBe(original.transparent_background_colors);
				expect(await capture(second.id)).toEqual(untouched);
			}
			// A newly constructed daemon controller can still restore the saved window.
			const restarted = new TerminalMoodController({ terminalTarget: async () => target });
			expect(await restarted.apply({ paneId: target.paneId, mood: "restore" }, () => true)).toMatchObject({
				verified: true,
				mood: null,
				canRestore: false,
			});
			expect(await capture(first.id)).toEqual(original);
			expect(await capture(second.id)).toEqual(untouched);
			expect(readFileSync(session, "utf8")).toContain("sleep 120");
		} finally {
			child.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null) resolve();
				else child.once("exit", () => resolve());
			});
		}
	},
	30_000,
);

it("inspects an exact Herdr client window when Pi belongs to the separate server", async () => {
	const dir = directory(),
		socket = join(dir, "herdr.sock");
	writeFileSync(socket, "", { mode: 0o600 });
	const target = {
		paneId: "w1:p1",
		pid: 42,
		processIdentity: "boot:42",
		sessionId: "one",
		instanceId: "one",
		herdrSocketPath: socket,
		peers: [],
	};
	const run = vi.fn(async (_address: string, args: string[]) =>
		args[0] === "ls"
			? [{ tabs: [{ windows: [{ id: 7, pid: 55 }] }] }]
			: { ok: true, verified: true, windowId: 7, geometry: { columns: 100 } },
	);
	const controller = new TerminalMoodController(
		{ terminalTarget: async () => target },
		{
			identity: async (pid) => `boot:${pid}`,
			tree: (pid) => ({
				pids: pid === 55 ? [55, 39] : [42, 1],
				names: pid === 55 ? ["herdr", "kitty"] : ["pi", "server"],
				kittyPid: pid === 55 ? 39 : undefined,
				windowId: 7,
				address: "unix:/private/control.sock",
			}),
			socket: (address) => address,
			run,
		},
	);
	const route = {
		clientPid: 55,
		processIdentity: "boot:55",
		kittyWindowId: 7,
		herdrSocketPath: socket,
		columns: 100,
		rows: 30,
		observedAt: new Date().toISOString(),
		innerRect: { x: 0, y: 0, width: 100, height: 30 },
		paneId: "w1:p1",
	};
	expect(await controller.geometry("w1:p1", "one", () => true, route)).toMatchObject({
		kittyPid: 39,
		geometry: { columns: 100 },
	});
	const command = run.mock.calls.find(([, args]) => args[0] === "kitten")?.[1];
	expect(JSON.parse(command?.[4] ?? "{}")).toMatchObject({
		pid: 55,
		processIdentity: "boot:55",
		mood: "geometry",
		windowId: 7,
	});
	await expect(controller.geometry("w1:p1", "other-session", () => true, route)).rejects.toThrow(
		"sesión cambió",
	);
	await expect(
		controller.geometry("w1:p1", "one", () => true, { ...route, processIdentity: "boot:old" }),
	).rejects.toThrow("cliente Herdr cambió");
});
