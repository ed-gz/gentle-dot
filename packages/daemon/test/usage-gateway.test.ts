import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import type { SubscriptionUsage } from "../src/usage.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, tempDir } from "./helpers.ts";

const daemons: DotDaemon[] = [];
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const empty = (): Awaited<ReturnType<SubscriptionUsage["read"]>> => ({
	providers: [
		{ id: "codex", label: "Codex", status: "unavailable", checkedAt: new Date().toISOString(), windows: [] },
		{
			id: "claude",
			label: "Claude",
			status: "unavailable",
			checkedAt: new Date().toISOString(),
			windows: [],
		},
	],
});

async function setup(read = vi.fn(async () => empty()), vps = false) {
	const dir = tempDir();
	directories.push(dir);
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
		subscriptionUsage: { read },
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
	const api = (path: string, token?: string, body?: object, origin?: string) =>
		fetch(base + path, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				"Content-Type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...(origin ? { Origin: origin } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const pair = async () => {
		const { code } = await (await api("/api/mobile/code", daemon.token, {})).json();
		return (await api("/api/mobile/pair", undefined, { code, deviceName: "Usage phone" })).json();
	};
	return { daemon, api, pair, read };
}

it("reads only on authenticated demand, with CORS, no-store and no mutation endpoint", async () => {
	const { daemon, api, pair, read } = await setup();
	expect(read).not.toHaveBeenCalled();
	for (const token of [undefined, "wrong"]) expect((await api("/api/mobile/usage", token)).status).toBe(401);
	expect((await api("/api/mobile/usage", daemon.token, undefined, "https://evil.invalid")).status).toBe(403);
	expect((await api("/api/mobile/usage", daemon.token, {})).status).toBe(405);
	expect(read).not.toHaveBeenCalled();
	const phone = await pair();
	const response = await api("/api/mobile/usage", phone.token, undefined, "https://localhost");
	expect(response.status).toBe(200);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://localhost");
	expect((await response.json()).providers.map((provider: { id: string }) => provider.id)).toEqual([
		"codex",
		"claude",
	]);
	expect(read).toHaveBeenCalledOnce();
});

it("rechecks phone access if revoked while a provider query is pending", async () => {
	let finish: (value: ReturnType<typeof empty>) => void = () => {};
	const read = vi.fn(
		() =>
			new Promise<ReturnType<typeof empty>>((resolve) => {
				finish = resolve;
			}),
	);
	const { daemon, api, pair } = await setup(read);
	const phone = await pair();
	const pending = api("/api/mobile/usage", phone.token);
	await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
	expect((await api("/api/mobile/revoke", daemon.token, { deviceId: phone.deviceId })).status).toBe(200);
	finish(empty());
	expect((await pending).status).toBe(401);
});

it("never reads local credentials in VPS mode and sanitizes unexpected provider failures", async () => {
	const local = await setup(
		vi.fn(async () => {
			throw Error("Authorization: Bearer secret-must-not-escape");
		}),
	);
	const failed = await local.api("/api/mobile/usage", local.daemon.token);
	expect(failed.status).toBe(502);
	expect(await failed.text()).not.toContain("secret-must-not-escape");
	const server = await setup(undefined, true);
	expect((await server.api("/api/mobile/usage", server.daemon.token)).status).toBe(503);
	expect(server.read).not.toHaveBeenCalled();
});
