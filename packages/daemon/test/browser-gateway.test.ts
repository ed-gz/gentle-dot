import { readFileSync } from "node:fs";
import { join } from "node:path";
import { duplexPair } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { MobileAccess } from "../src/mobile.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

let daemon: DotDaemon | undefined;
afterEach(async () => {
	await daemon?.close();
	daemon = undefined;
});

it("cancels the exact native installation when its mobile request disconnects and preserves the final result", async () => {
	const dataDir = tempDir();
	const [daemonEnd, appEnd] = duplexPair();
	const frames: { id: number; method: string; params: { requestId?: string } }[] = [];
	const reply = (id: number, result: unknown) =>
		appEnd.write(`${JSON.stringify({ kind: "response", id, result })}\n`);
	let buffer = "";
	appEnd.setEncoding("utf8");
	appEnd.on("data", (chunk: string) => {
		buffer += chunk;
		for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
			const frame = JSON.parse(buffer.slice(0, end));
			buffer = buffer.slice(end + 1);
			if (frame.kind !== "request") continue;
			frames.push(frame);
			if (frame.method === "privileged_cancel") reply(frame.id, { cancelled: false });
			else if (frame.method !== "privileged_operation") reply(frame.id, {});
		}
	});
	try {
		daemon = await startDaemon({
			port: 0,
			host: "127.0.0.1",
			dataDir,
			workspace: dataDir,
			uiDir: dataDir,
			agentCommand: process.execPath,
			agentArgs: [FAKE_AGENT],
			appChannel: daemonEnd,
		});
		const base = `http://127.0.0.1:${daemon.port}`;
		const headers = { Authorization: `Bearer ${daemon.token}`, "content-type": "application/json" };
		const controller = new AbortController();
		const installing = fetch(`${base}/browser`, {
			method: "POST",
			headers,
			signal: controller.signal,
			body: JSON.stringify({ action: "install_browser", reason: "Instalar desde el móvil" }),
		}).catch(() => undefined);
		const operation = await waitFor(() => frames.find((frame) => frame.method === "privileged_operation"));
		expect(await (await fetch(`${base}/browser`, { headers })).json()).toMatchObject({
			canRequestInstall: true,
			installation: { requestId: operation.params.requestId, status: "pending" },
		});
		controller.abort();
		await installing;
		const cancellation = await waitFor(() => frames.find((frame) => frame.method === "privileged_cancel"));
		expect(cancellation.params.requestId).toBe(operation.params.requestId);
		// The package manager had already started; disconnecting cannot undo its completed work.
		reply(operation.id, { requestId: operation.params.requestId, status: "succeeded" });
		await expect
			.poll(async () => (await (await fetch(`${base}/browser`, { headers })).json()).installation.status, {
				timeout: 5000,
			})
			.toBe("succeeded");
	} finally {
		await daemon?.close();
		daemon = undefined;
		appEnd.destroy();
	}
});

it("retains previously trusted mobile browser approval without a native app or a working model", async () => {
	const dataDir = tempDir();
	const devices = new MobileAccess(dataDir);
	const device = devices.redeem(devices.issue().code, "Previously trusted phone", true);
	const processFile = join(dataDir, "process.json");
	daemon = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: dataDir,
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentEnv: { ...process.env, FAKE_AGENT_PROCESS_FILE: processFile },
	});
	const base = `http://127.0.0.1:${daemon.port}`;
	const engine = JSON.parse(readFileSync(processFile, "utf8")).env.GENTLE_DOT_BROWSER_KEY;
	const client = { send: () => {} };
	const detach = daemon.bridge.attach(client);
	await daemon.bridge.handle(client, { type: "send", text: "fail" });
	await waitFor(() => daemon?.bridge.agentState === "idle");
	const request = (path: string, key: string, body?: object) =>
		fetch(base + path, {
			method: body ? "POST" : "GET",
			headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	const waiting = request("/api/browser/agent", engine, {
		action: "request_access",
		reason: "Revisar la página solicitada",
	});
	let pending: { id: string }[] = [];
	await waitFor(() => {
		void request("/api/mobile/approvals", device.token)
			.then((r) => r.json())
			.then((r) => {
				pending = r.approvals;
			});
		return pending.length > 0;
	});
	expect(pending[0]?.id).toMatch(/^browser-/);
	expect(
		(await request("/api/mobile/answer", daemon.token, { requestId: pending[0]?.id, approved: true })).status,
	).toBe(403);
	expect(
		(await request("/api/mobile/answer", device.token, { requestId: pending[0]?.id, approved: false }))
			.status,
	).toBe(200);
	expect((await waiting).status).toBe(403);
	detach();
});

it("keeps browser consent on the human channel, separate from the engine key", async () => {
	const dataDir = tempDir();
	const processFile = join(dataDir, "process.json");
	daemon = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: dataDir,
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentEnv: { ...process.env, FAKE_AGENT_PROCESS_FILE: processFile },
	});
	const base = `http://127.0.0.1:${daemon.port}`;
	const agentKey = JSON.parse(readFileSync(processFile, "utf8")).env.GENTLE_DOT_BROWSER_KEY;
	expect(typeof agentKey).toBe("string");
	const request = (path: string, key: string, body?: object, origin?: string) =>
		fetch(base + path, {
			method: body ? "POST" : "GET",
			headers: {
				Authorization: `Bearer ${key}`,
				"content-type": "application/json",
				...(origin ? { Origin: origin } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	expect((await request("/browser", "invalid")).status).toBe(401);
	expect((await request("/browser", agentKey)).status).toBe(401);
	expect((await request("/browser", daemon.token, undefined, "https://untrusted.example")).status).toBe(403);
	const status = await request("/browser", daemon.token);
	expect(status.status).toBe(200);
	expect(await status.json()).toMatchObject({ active: false, running: false });
	expect((await request("/api/browser/agent", daemon.token, { action: "status" })).status).toBe(401);
	expect((await request("/api/browser/agent", agentKey, { action: "start", minutes: 480 })).status).toBe(403);
	expect((await request("/api/browser/agent", agentKey, { action: "status" })).status).toBe(200);
	expect((await request("/browser", daemon.token, { action: "stop" })).status).toBe(200);
});
