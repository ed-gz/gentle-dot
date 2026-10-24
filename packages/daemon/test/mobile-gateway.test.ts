import { mkdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { Orchestrator } from "../src/orchestration/index.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});
async function setup() {
	const dir = tempDir();
	const ui = join(dir, "ui");
	mkdirSync(ui);
	writeFileSync(join(ui, "index.html"), "test");
	const daemon = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir: dir,
		workspace: dir,
		uiDir: ui,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
	});
	daemons.push(daemon);
	const api = (path: string, key?: string, body?: object, origin?: string) =>
		fetch(`http://127.0.0.1:${daemon.port}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				"Content-Type": "application/json",
				...(key ? { Authorization: `Bearer ${key}` } : {}),
				...(origin ? { Origin: origin } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return { daemon, api };
}
it("requires the owner key to create QR codes and rejects untrusted origins", async () => {
	const { daemon, api } = await setup();
	expect((await api("/api/mobile/code", undefined, {})).status).toBe(401);
	expect((await api("/api/mobile/code", daemon.token, {}, "https://evil.invalid")).status).toBe(403);
	expect((await api("/orchestration")).status).toBe(401);
	expect((await api("/orchestration/companion")).status).toBe(401);
	expect((await api("/orchestration/companion/focus", undefined, { paneId: "p1", sessionId: "s1" })).status).toBe(401);
	expect((await api("/orchestration/companion", daemon.token, undefined, "https://evil.invalid")).status).toBe(403);
	const context = await api("/orchestration/companion", daemon.token);
	expect(context.status).toBe(200);
	expect(await context.json()).toMatchObject({ version: 1, focusScope: "herdr", capabilities: { geometry: false } });
	expect((await api("/api/orchestration/agent", daemon.token, { action: "snapshot" })).status).toBe(401);
});
it("pairs the native app, authenticates chat and revokes an active device immediately", async () => {
	const { daemon, api } = await setup();
	const { code } = await (await api("/api/mobile/code", daemon.token, {})).json();
	const response = await api(
		"/api/mobile/pair",
		undefined,
		{ code, deviceName: "Android" },
		"https://localhost",
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://localhost");
	const device = await response.json();
	expect((await api("/api/mobile/code", device.token, {})).status).toBe(403);
	const repeated = await api("/api/mobile/pair", undefined, { code, deviceName: "Repeat" });
	expect(repeated.status).toBe(410);
	expect((await repeated.json()).code).toBe("PAIRING_CODE_INVALID");
	const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`, { origin: "https://localhost" });
	const messages: { type: string }[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data))));
	const closed = new Promise<number>((resolve) => ws.on("close", resolve));
	await new Promise<void>((resolve) => ws.on("open", resolve));
	ws.send(JSON.stringify({ type: "hello", token: device.token, protocol: 1 }));
	await waitFor(() => messages.some((m) => m.type === "ready"));
	const owner = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
	const ownerMessages: { type: string; message?: string }[] = [];
	owner.on("message", (data) => ownerMessages.push(JSON.parse(String(data))));
	try {
		await new Promise<void>((resolve) => owner.on("open", resolve));
		owner.send(JSON.stringify({ type: "hello", token: daemon.token, protocol: 1 }));
		await waitFor(() => ownerMessages.some((m) => m.type === "ready"));
		expect((await api("/api/mobile/revoke", daemon.token, { deviceId: device.deviceId })).status).toBe(200);
		daemon.bridge.notifySession({ type: "toast", level: "info", message: "After revocation" });
		await waitFor(() => ownerMessages.some((m) => m.message === "After revocation"));
		expect(await closed).toBe(4401);
		expect(JSON.stringify(messages)).not.toContain("After revocation");
		expect((await api("/orchestration", device.token)).status).toBe(401);
	} finally {
		owner.close();
		ws.close();
	}
});
it("rejects malformed and excessive pairing bodies", async () => {
	const { api } = await setup();
	expect((await api("/api/mobile/pair", undefined, { code: [], deviceName: "Phone" })).status).toBe(400);
	expect(
		(await api("/api/mobile/pair", undefined, { code: "x".repeat(70000), deviceName: "Phone" })).status,
	).toBe(400);
});

it("rechecks a revoked device after receiving a delayed request body", async () => {
	const { daemon, api } = await setup();
	const { code } = await (await api("/api/mobile/code", daemon.token, {})).json();
	const device = await (await api("/api/mobile/pair", undefined, { code, deviceName: "Phone" })).json();
	let complete!: () => void;
	const result = new Promise<number>((resolve, reject) => {
		const req = httpRequest(
			`http://127.0.0.1:${daemon.port}/orchestration`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${device.token}`, "Content-Type": "application/json" },
			},
			(res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			},
		);
		req.on("error", reject);
		req.write('{"action":');
		complete = () => req.end('"snapshot"}');
	});
	await new Promise((resolve) => setTimeout(resolve, 50));
	await api("/api/mobile/revoke", daemon.token, { deviceId: device.deviceId });
	complete();
	expect(await result).toBe(401);
});

it("does not send a pending session snapshot after its phone was revoked", async () => {
	const { daemon, api } = await setup();
	const { code } = await (await api("/api/mobile/code", daemon.token, {})).json();
	const device = await (await api("/api/mobile/pair", undefined, { code, deviceName: "Phone" })).json();
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered = false;
	const snapshot = vi.spyOn(Orchestrator.prototype, "snapshot").mockImplementation(async () => {
		entered = true;
		await pending;
		return { sessions: [{ title: "private pending session" }] } as unknown as Awaited<
			ReturnType<Orchestrator["snapshot"]>
		>;
	});
	try {
		const result = api("/orchestration", device.token);
		await waitFor(() => entered);
		expect((await api("/api/mobile/revoke", daemon.token, { deviceId: device.deviceId })).status).toBe(200);
		release();
		const response = await result;
		expect(response.status).toBe(401);
		expect(await response.text()).not.toContain("private pending session");
	} finally {
		release();
		snapshot.mockRestore();
	}
});

it("self-disconnect closes that phone's sockets without revoking other devices or the owner", async () => {
	const { daemon, api } = await setup();
	async function pair(name: string) {
		const { code } = await (await api("/api/mobile/code", daemon.token, {})).json();
		return (await api("/api/mobile/pair", undefined, { code, deviceName: name })).json();
	}
	const phone = await pair("Phone");
	const other = await pair("Other phone");
	const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`, { origin: "https://localhost" });
	const messages: { type: string }[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data))));
	const closed = new Promise<number>((resolve) => ws.on("close", resolve));
	await new Promise<void>((resolve) => ws.on("open", resolve));
	ws.send(JSON.stringify({ type: "hello", token: phone.token, protocol: 1 }));
	await waitFor(() => messages.some((m) => m.type === "ready"));
	expect((await api("/api/mobile/disconnect", daemon.token, {})).status).toBe(401);
	// Even a supplied victim id cannot change which identity is revoked.
	expect(
		(await api("/api/mobile/disconnect", phone.token, { deviceId: other.deviceId }, "https://localhost"))
			.status,
	).toBe(200);
	expect(await closed).toBe(4401);
	expect((await api("/orchestration", phone.token)).status).toBe(401);
	expect((await api("/orchestration", other.token)).status).toBe(200);
	expect((await api("/api/mobile/disconnect", phone.token, {})).status).toBe(401);
	const devices = await (await api("/api/mobile/devices", daemon.token)).json();
	expect(devices.devices.map((device: { id: string }) => device.id)).toEqual([other.deviceId]);
});

it("rejects self-disconnection from an untrusted origin and rechecks authorization after the body", async () => {
	const { daemon, api } = await setup();
	const { code } = await (await api("/api/mobile/code", daemon.token, {})).json();
	const phone = await (await api("/api/mobile/pair", undefined, { code, deviceName: "Phone" })).json();
	expect((await api("/api/mobile/disconnect", phone.token, {}, "https://evil.invalid")).status).toBe(403);
	let complete!: () => void;
	const result = new Promise<number>((resolve, reject) => {
		const req = httpRequest(
			`http://127.0.0.1:${daemon.port}/api/mobile/disconnect`,
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
		req.write("{");
		complete = () => req.end("}");
	});
	await new Promise((resolve) => setTimeout(resolve, 50));
	await api("/api/mobile/revoke", daemon.token, { deviceId: phone.deviceId });
	complete();
	expect(await result).toBe(401);
});
