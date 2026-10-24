import { readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { COMPLETIONS_EXTENSION_PATH, CompletionReports } from "../src/completion-reports.ts";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { Orchestrator } from "../src/orchestration/index.ts";
import { SHARE_FILE_EXTENSION_PATH } from "../src/shared-files.ts";
import { WorkflowContinuations } from "../src/workflows.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, tempDir } from "./helpers.ts";

const daemons: DotDaemon[] = [];
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});
async function setup(existing?: string, vps = false) {
	const dir = existing ?? tempDir();
	if (!existing) dirs.push(dir);
	const processFile = join(dir, "process.json");
	const auth = fakeAuthRuntime();
	const daemon = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir: dir,
		workspace: join(dir, "workspace"),
		uiDir: dir,
		agentHome: join(dir, "agent"),
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		authRuntime: async () => auth.runtime,
		agentEnv: {
			...process.env,
			FAKE_AGENT_PROCESS_FILE: processFile,
			GENTLE_DOT_COMPLETIONS_KEY: "inherited-invalid-key",
			GENTLE_DOT_COMPLETIONS_URL: "http://invalid.example",
			GENTLE_DOT_FILES_KEY: "inherited-invalid-files",
			GENTLE_DOT_FILES_URL: "http://invalid.example",
		},
		...(vps
			? {
					vps: {
						engine: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
						access: <T>(fn: () => T) => fn(),
						handOver: () => {},
					},
				}
			: {}),
	});
	daemons.push(daemon);
	const base = `http://127.0.0.1:${daemon.port}`;
	const processInfo = JSON.parse(readFileSync(processFile, "utf8")) as {
		env: Record<string, string>;
		argv: string[];
	};
	const api = (path: string, key?: string, body?: object, origin?: string) =>
		fetch(base + path, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				"Content-Type": "application/json",
				...(key ? { Authorization: `Bearer ${key}` } : {}),
				...(origin ? { Origin: origin } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	async function pair() {
		const { code } = await (await api("/api/mobile/code", daemon.token, {})).json();
		return (await api("/api/mobile/pair", undefined, { code, deviceName: "Phone" })).json();
	}
	return { daemon, dir, base, api, pair, ...processInfo };
}

it("keeps report preferences human-only, validates booleans, and persists explicit opt-in", async () => {
	const first = await setup();
	const phone = await first.pair();
	expect(await (await first.api("/api/mobile/completions", phone.token)).json()).toMatchObject({
		enabled: false,
		pending: 0,
	});
	for (const key of [
		undefined,
		"wrong",
		first.env.GENTLE_DOT_ORCHESTRATION_KEY,
		first.env.GENTLE_DOT_COMPLETIONS_KEY,
	]) {
		expect((await first.api("/api/mobile/completions", key)).status).toBe(401);
		expect((await first.api("/api/mobile/completions", key, { enabled: true })).status).toBe(401);
	}
	for (const enabled of ["true", 1, null, {}, []])
		expect((await first.api("/api/mobile/completions", phone.token, { enabled })).status).toBe(400);
	expect(
		(await first.api("/api/mobile/completions", phone.token, { enabled: true }, "https://evil.invalid"))
			.status,
	).toBe(403);
	expect(
		await (
			await first.api("/api/mobile/completions", phone.token, { enabled: true }, "https://localhost")
		).json(),
	).toMatchObject({ enabled: true });
	await first.daemon.close();
	daemons.splice(daemons.indexOf(first.daemon), 1);
	const second = await setup(first.dir);
	expect(await (await second.api("/api/mobile/completions", second.daemon.token)).json()).toMatchObject({
		enabled: true,
	});
	expect(
		await (await second.api("/api/mobile/completions", phone.token, { enabled: false })).json(),
	).toMatchObject({ enabled: false });
});

it("isolates engine reports from owner/mobile credentials and rejects forwarded/browser requests", async () => {
	const { daemon, env, argv, base, api, pair } = await setup();
	const phone = await pair();
	const key = env.GENTLE_DOT_COMPLETIONS_KEY;
	expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(env.GENTLE_DOT_COMPLETIONS_URL).toBe(`${base}/api/completions/agent`);
	expect(argv).toContain(COMPLETIONS_EXTENSION_PATH);
	expect(argv).toContain(SHARE_FILE_EXTENSION_PATH);
	for (const invalid of [
		undefined,
		"wrong",
		daemon.token,
		phone.token,
		env.GENTLE_DOT_ORCHESTRATION_KEY,
		env.GENTLE_DOT_FILES_KEY,
	])
		expect((await api("/api/completions/agent", invalid)).status).toBe(401);
	expect((await api("/api/completions/agent", key, undefined, "https://localhost")).status).toBe(403);
	expect(
		(
			await fetch(`${base}/api/completions/agent`, {
				headers: { Authorization: `Bearer ${key}`, Forwarded: "for=100.1.2.3" },
			})
		).status,
	).toBe(403);
	expect((await api("/api/completions/agent", key, {})).status).toBe(405);
	for (const suffix of ["", "?status=1"])
		expect(await (await api(`/api/completions/agent${suffix}`, key)).json()).toMatchObject({
			enabled: false,
			reports: [],
		});
});

it("rechecks a revoked phone after reading its delayed preference request", async () => {
	const { daemon, base, api, pair } = await setup();
	const phone = await pair();
	let finish!: () => void;
	const result = new Promise<number>((resolve, reject) => {
		const req = httpRequest(
			`${base}/api/mobile/completions`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${phone.token}`, "Content-Type": "application/json" },
			},
			(res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			},
		);
		req.on("error", reject);
		req.write('{"enabled":');
		finish = () => req.end("true}");
	});
	await new Promise((resolve) => setTimeout(resolve, 30));
	await api("/api/mobile/revoke", daemon.token, { deviceId: phone.deviceId });
	finish();
	expect(await result).toBe(401);
	expect(await (await api("/api/mobile/completions", daemon.token)).json()).toMatchObject({ enabled: false });
});

it("does not load local file/report extensions or inherited channels in VPS mode", async () => {
	const { daemon, env, argv, api } = await setup(undefined, true);
	for (const name of [
		"GENTLE_DOT_FILES_URL",
		"GENTLE_DOT_FILES_KEY",
		"GENTLE_DOT_COMPLETIONS_URL",
		"GENTLE_DOT_COMPLETIONS_KEY",
	])
		expect(env[name]).toBeUndefined();
	expect(argv).not.toContain(COMPLETIONS_EXTENSION_PATH);
	expect(argv).not.toContain(SHARE_FILE_EXTENSION_PATH);
	expect((await api("/api/mobile/completions", daemon.token)).status).toBe(503);
	expect((await api(`/api/files/${"x".repeat(43)}/meta`, daemon.token)).status).toBe(503);
});

it("does not reserve background turns while a completion report is still being inspected", async () => {
	const { api, env } = await setup();
	const pair = { paneId: "report-pane", sessionId: "report-session" };
	vi.spyOn(Orchestrator.prototype, "snapshot").mockResolvedValue({
		available: true,
		providers: [],
		approvals: [],
		policies: [],
		events: [],
		sessions: [
			{
				...pair,
				provider: "terminal",
				terminalId: "terminal",
				workspaceId: "workspace",
				label: "Report fixture",
				state: "idle",
				connected: true,
				managed: true,
				capabilities: { inspect: true, prompt: true, abort: true, approvals: true },
			},
		],
	});
	let finish!: () => void;
	let entered!: () => void;
	const reading = new Promise<void>((resolve) => {
		entered = resolve;
	});
	vi.spyOn(Orchestrator.prototype, "dispatch").mockImplementation(async () => {
		entered();
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
		return { sessionId: pair.sessionId, status: "idle", messages: [] };
	});
	const original = CompletionReports.prototype.takeReady;
	let seeded = false;
	vi.spyOn(CompletionReports.prototype, "takeReady").mockImplementation(function (this: CompletionReports) {
		if (!seeded) {
			seeded = true;
			this.configure(true);
			this.onEvent({ ...pair, id: "report-event", type: "completed", at: new Date().toISOString() });
		}
		return original.call(this);
	});
	const follow = vi
		.spyOn(WorkflowContinuations.prototype, "poll")
		.mockResolvedValue({ workflows: [], pending: 0 });
	const reportRequest = api("/api/completions/agent", env.GENTLE_DOT_COMPLETIONS_KEY);
	await reading;
	try {
		expect(await (await reportRequest).json()).toMatchObject({ enabled: true, reports: [] });
		expect((await api("/api/workflows/agent", env.GENTLE_DOT_WORKFLOWS_KEY)).status).toBe(200);
		expect(follow).toHaveBeenCalledOnce();
	} finally {
		finish();
	}
});
