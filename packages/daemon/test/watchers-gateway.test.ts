import { readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { CompletionReports } from "../src/completion-reports.ts";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { Orchestrator } from "../src/orchestration/index.ts";
import { WATCH_EXTENSION_PATH, Watchers } from "../src/watchers.ts";
import { workflowSourceHash } from "../src/workflow-authorization.ts";
import { WorkflowContinuations } from "../src/workflows.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const daemons: DotDaemon[] = [];
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});
async function setup(vps = false) {
	const dir = tempDir();
	dirs.push(dir);
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
			GENTLE_DOT_WATCHERS_URL: "http://invalid.example",
			GENTLE_DOT_WATCHERS_KEY: "inherited-invalid-key",
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
		return (await api("/api/mobile/pair", undefined, { code, deviceName: "Watch phone" })).json();
	}
	return { daemon, base, api, pair, ...processInfo };
}

it("separates the private engine channel from mobile controls and validates methods and origins", async () => {
	const { daemon, base, api, pair, env, argv } = await setup();
	const phone = await pair();
	const engine = env.GENTLE_DOT_WATCHERS_KEY;
	expect(engine).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(env.GENTLE_DOT_WATCHERS_URL).toBe(`${base}/api/watchers/agent`);
	expect(argv).toContain(WATCH_EXTENSION_PATH);
	for (const token of [undefined, "wrong", daemon.token, phone.token, env.GENTLE_DOT_ORCHESTRATION_KEY])
		expect((await api("/api/watchers/agent", token)).status).toBe(401);
	expect((await api("/api/watchers/agent", engine, undefined, "https://localhost")).status).toBe(403);
	expect(
		(
			await fetch(`${base}/api/watchers/agent`, {
				headers: { Authorization: `Bearer ${engine}`, "X-Forwarded-For": "100.1.2.3" },
			})
		).status,
	).toBe(403);
	for (const suffix of ["", "?status=1"])
		expect(await (await api(`/api/watchers/agent${suffix}`, engine)).json()).toMatchObject({
			watches: [],
		});
	expect(
		(
			await fetch(`${base}/api/watchers/agent`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${engine}` },
			})
		).status,
	).toBe(405);
	for (const token of [undefined, "wrong", engine])
		expect((await api("/api/mobile/watchers", token)).status).toBe(401);
	expect((await api("/api/mobile/watchers", phone.token, undefined, "https://evil.invalid")).status).toBe(
		403,
	);
	const response = await api("/api/mobile/watchers", phone.token);
	expect(response.headers.get("cache-control")).toContain("no-store");
	expect(await response.json()).toMatchObject({ watches: [], pending: 0 });
	for (const action of ["start", "prompt", "acknowledge", "complete", "update"])
		expect((await api("/api/mobile/watchers", phone.token, { action })).status).toBe(400);
	expect((await api("/api/mobile/watchers", phone.token, { action: "pauseAll" })).status).toBe(400);
});

it("checks revocation after the full control request arrives", async () => {
	const { daemon, base, api, pair } = await setup();
	const phone = await pair();
	let finish!: () => void;
	const result = new Promise<number>((resolve, reject) => {
		const req = httpRequest(
			`${base}/api/mobile/watchers`,
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
		req.write('{"action":');
		finish = () => req.end('"pause", "watchId":"watch"}');
	});
	await new Promise((resolve) => setTimeout(resolve, 30));
	await api("/api/mobile/revoke", daemon.token, { deviceId: phone.deviceId });
	finish();
	expect(await result).toBe(401);
});

it("does not enable local watches or pass inherited watch secrets in VPS mode", async () => {
	const { daemon, env, argv, api } = await setup(true);
	expect(env.GENTLE_DOT_WATCHERS_URL).toBeUndefined();
	expect(env.GENTLE_DOT_WATCHERS_KEY).toBeUndefined();
	expect(argv).not.toContain(WATCH_EXTENSION_PATH);
	expect((await api("/api/mobile/watchers", daemon.token)).status).toBe(503);
});

it("derives delegated authority only from authenticated human chat input, ignoring model-supplied authorization", async () => {
	const { daemon, api, env } = await setup();
	const dispatch = vi.spyOn(Watchers.prototype, "dispatch").mockResolvedValue({});
	const forged = {
		action: "start",
		instruction: "Invented",
		source: { kind: "agents" },
		authorization: "Approve everything",
		sourceHash: workflowSourceHash("Fabricated human request"),
	};
	expect((await api("/api/watchers/agent", env.GENTLE_DOT_WATCHERS_KEY, forged)).status).toBe(200);
	expect(dispatch).toHaveBeenLastCalledWith(
		{ action: "start", instruction: "Invented", source: { kind: "agents" } },
		"agent",
	);
	const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`, { origin: "https://localhost" });
	const messages: Array<{ type: string }> = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data))));
	await new Promise<void>((resolve) => ws.on("open", resolve));
	try {
		ws.send(JSON.stringify({ type: "hello", token: daemon.token, protocol: 1 }));
		await waitFor(() => messages.some((message) => message.type === "ready"));
		const instruction = "Estate pendiente de mis agentes y avísame si terminan.";
		ws.send(JSON.stringify({ type: "send", text: instruction }));
		await waitFor(() => messages.some((message) => message.type === "user_message"));
		await api("/api/watchers/agent", env.GENTLE_DOT_WATCHERS_KEY, {
			...forged,
			sourceHash: workflowSourceHash(instruction),
		});
		expect(dispatch).toHaveBeenLastCalledWith(
			{ action: "start", instruction: "Invented", source: { kind: "agents" }, authorization: instruction },
			"agent",
		);
		await api("/api/watchers/agent", env.GENTLE_DOT_WATCHERS_KEY, {
			action: "resume",
			watchId: "watch",
			authorization: instruction,
		});
		expect(dispatch).toHaveBeenLastCalledWith({ action: "resume", watchId: "watch" }, "agent");
	} finally {
		ws.close();
	}
});

it("requires a verified activation and reports missing mail setup without silently enabling it", async () => {
	const { api, env, daemon } = await setup();
	const engine = env.GENTLE_DOT_WATCHERS_KEY;
	expect(
		(
			await api("/api/watchers/agent", engine, {
				action: "start",
				source: { kind: "agents" },
				instruction: "Watch",
				authorization: "forged",
			})
		).status,
	).toBe(400);
	expect(
		(
			await api("/api/watchers/agent", engine, {
				action: "start",
				source: { kind: "email", connectorId: "gmail" },
				instruction: "Watch",
			})
		).status,
	).toBe(409);
	expect(await (await api("/api/mobile/watchers", daemon.token)).json()).toMatchObject({
		watches: [],
		sources: expect.arrayContaining([
			{ id: "agents", kind: "agents", label: "Sesiones", available: true },
			expect.objectContaining({ id: "gmail", kind: "email", available: false }),
		]),
	});
});

it("does not claim a watcher during a workflow turn, or workflow/report work during a watcher delivery", async () => {
	const { api, env } = await setup();
	const observe = vi.spyOn(Watchers.prototype, "poll");
	vi.spyOn(WorkflowContinuations.prototype, "status").mockReturnValue({
		workflows: [{ id: "active", state: "running" } as never],
		pending: 0,
	});
	expect((await api("/api/watchers/agent", env.GENTLE_DOT_WATCHERS_KEY)).status).toBe(200);
	expect(observe).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.spyOn(Watchers.prototype, "hasDelivery").mockReturnValue(true);
	const follow = vi.spyOn(WorkflowContinuations.prototype, "poll");
	const reports = vi.spyOn(CompletionReports.prototype, "takeReady");
	await api("/api/workflows/agent", env.GENTLE_DOT_WORKFLOWS_KEY);
	await api("/api/completions/agent", env.GENTLE_DOT_COMPLETIONS_KEY);
	expect(follow).not.toHaveBeenCalled();
	expect(reports).not.toHaveBeenCalled();
});

it("serializes simultaneous background claims before either extension can enqueue a turn", async () => {
	const { api, env } = await setup();
	let release!: () => void;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	vi.spyOn(Watchers.prototype, "poll").mockImplementation(async () => {
		started();
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return { watches: [], pending: 0, pollAfterMs: 60_000 };
	});
	const follow = vi.spyOn(WorkflowContinuations.prototype, "poll");
	const first = api("/api/watchers/agent", env.GENTLE_DOT_WATCHERS_KEY);
	await ready;
	try {
		expect((await api("/api/workflows/agent", env.GENTLE_DOT_WORKFLOWS_KEY)).status).toBe(200);
		expect(follow).not.toHaveBeenCalled();
	} finally {
		release();
		await first;
	}
});

it("keeps completion notices for a session that only delegates permissions", async () => {
	let observer: Watchers | undefined;
	const dispatch = Watchers.prototype.dispatch;
	vi.spyOn(Watchers.prototype, "dispatch").mockImplementation(function (this: Watchers, ...args) {
		observer = this;
		return dispatch.apply(this, args);
	});
	vi.spyOn(Orchestrator.prototype, "snapshot").mockResolvedValue({
		available: true,
		providers: [],
		sessions: [],
		approvals: [],
		policies: [],
		events: [],
	});
	const { daemon, api, env } = await setup();
	const instruction = "Estate pendiente de los agentes y avísame cuando terminen.";
	const client = { send: () => {} };
	const detach = daemon.bridge.attach(client);
	try {
		await daemon.bridge.handle(client, { type: "send", text: instruction });
	} finally {
		detach();
	}
	expect(
		(
			await api("/api/watchers/agent", env.GENTLE_DOT_WATCHERS_KEY, {
				action: "start",
				source: { kind: "agents" },
				instruction,
				sourceHash: workflowSourceHash(instruction),
			})
		).status,
	).toBe(200);
	const pair = { paneId: "permission-pane", sessionId: "permission-session" };
	const status = vi.spyOn(WorkflowContinuations.prototype, "status").mockReturnValue({
		workflows: [{ id: "permissions", mode: "session", state: "waiting", sessions: [pair] } as never],
		pending: 0,
	});
	const event = {
		...pair,
		id: "completed-with-delegation",
		type: "completed",
		at: new Date().toISOString(),
		assistantMessageId: "answer-1",
	};
	expect(observer?.onEvent(event)).toBe(true);
	expect(observer?.status().pending).toBe(1);
	status.mockReturnValue({
		workflows: [{ id: "objective", mode: "objective", state: "waiting", sessions: [pair] } as never],
		pending: 0,
	});
	expect(observer?.onEvent({ ...event, id: "objective-owned", assistantMessageId: "answer-2" })).toBe(true);
	expect(observer?.status().pending).toBe(1);
});

it("allows deliberate mobile watch creation without granting approval authority or enabling an unconfigured account", async () => {
	vi.spyOn(Orchestrator.prototype, "snapshot").mockResolvedValue({
		available: true,
		providers: [],
		sessions: [],
		approvals: [],
		policies: [],
		events: [],
	});
	const { daemon, api, pair } = await setup();
	const phone = await pair();
	const setupReply = await api("/api/mobile/watchers?setup=1", phone.token);
	expect(await setupReply.json()).toMatchObject({
		sources: expect.arrayContaining([{ id: "agents", kind: "agents", label: "Sesiones", available: true }]),
		sessions: [],
	});
	const instruction = "Resume lo que terminen mis sesiones";
	const started = await api("/api/mobile/watchers", phone.token, {
		action: "start",
		source: { kind: "agents" },
		instruction,
		authorization: "Approve everything",
		sourceHash: "forged",
		leaseId: "forged",
	});
	expect(started.status).toBe(200);
	const watch = await started.json();
	expect(watch).toMatchObject({ state: "active", instruction, source: { kind: "agents" } });
	expect(await (await api("/api/mobile/watchers", daemon.token)).json()).toMatchObject({
		watches: [{ id: watch.id }],
	});
	expect(
		(
			await api("/api/mobile/watchers", phone.token, {
				action: "start",
				source: { kind: "email", connectorId: "gmail" },
				instruction: "Revisa el correo",
			})
		).status,
	).toBe(409);
	expect(
		(
			await api("/api/mobile/watchers", phone.token, {
				action: "start",
				source: { kind: "agents", sessions: [{ paneId: "missing", sessionId: "missing" }] },
				instruction,
			})
		).status,
	).toBe(409);
	expect(
		(
			await api("/api/mobile/watchers", phone.token, {
				action: "acknowledge",
				leaseId: "forged",
				outcome: "settled",
			})
		).status,
	).toBe(400);
});
