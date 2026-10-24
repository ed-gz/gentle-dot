import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { join } from "node:path";
import { discoverAndLoadExtensions, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "@gentle-dot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { ComputerCaptureStore } from "../src/computer-capture.ts";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { SHARE_FILE_EXTENSION_PATH, SharedFileStore } from "../src/shared-files.ts";
import { SharedFilesGateway } from "../src/shared-files-http.ts";
import { CAPTURE_JPEG } from "./fixtures/capture-image.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const daemons: DotDaemon[] = [];
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function setup(existing?: string) {
	const dir = existing ?? tempDir();
	if (!existing) dirs.push(dir);
	const processFile = join(dir, "process.json");
	const daemon = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir: dir,
		workspace: dir,
		uiDir: dir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentEnv: { ...process.env, FAKE_AGENT_PROCESS_FILE: processFile },
	});
	daemons.push(daemon);
	const base = `http://127.0.0.1:${daemon.port}`;
	const env = JSON.parse(readFileSync(processFile, "utf8")).env as Record<string, string>;
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
		return (
			await api("/api/mobile/pair", undefined, { code, deviceName: "Test phone" }, "https://localhost")
		).json();
	}
	return { daemon, dir, base, env, api, pair };
}

it("only publishes through the isolated engine key, with loopback and browser-origin defenses", async () => {
	const { daemon, dir, env, api, base, pair } = await setup();
	const file = join(dir, "report.pdf");
	writeFileSync(file, "%PDF-1.7\nHello");
	const phone = await pair();
	expect(env.GENTLE_DOT_FILES_URL).toBe(`${base}/api/files/agent`);
	const key = env.GENTLE_DOT_FILES_KEY;
	expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
	for (const invalid of [
		undefined,
		"wrong",
		daemon.token,
		phone.token,
		env.GENTLE_DOT_ORCHESTRATION_KEY,
		env.GENTLE_DOT_BROWSER_KEY,
	])
		expect((await api("/api/files/agent", invalid, { path: file })).status).toBe(401);
	expect((await api("/api/files/agent", key, { path: file }, "https://localhost")).status).toBe(403);
	expect((await api("/api/files/agent", key, { path: file }, "https://evil.invalid")).status).toBe(403);
	expect(
		(
			await fetch(`${base}/api/files/agent`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
					"X-Forwarded-For": "100.1.2.3",
				},
				body: JSON.stringify({ path: file }),
			})
		).status,
	).toBe(403);
	expect((await api("/api/files/agent", key)).status).toBe(405);
	expect((await api("/api/files/agent", key, { path: file })).status).toBe(200);
});

it("downloads private snapshots with current owner/phone auth, preserves them across restart, and revokes devices", async () => {
	const first = await setup();
	const path = join(first.dir, "Résumé [final].pdf");
	const bytes = Buffer.from("%PDF-1.7\nPrivate test report");
	writeFileSync(path, bytes);
	const publication = await (
		await first.api("/api/files/agent", first.env.GENTLE_DOT_FILES_KEY, { path })
	).json();
	const endpoint = `/api/files/${publication.id}`;
	const phone = await first.pair();
	for (const key of [undefined, "bad", first.env.GENTLE_DOT_FILES_KEY])
		expect((await first.api(`${endpoint}/content`, key)).status).toBe(401);
	expect((await first.api(`${endpoint}/content?token=${first.daemon.token}`)).status).toBe(401);
	expect((await first.api(`${endpoint}/meta`, phone.token, undefined, "https://evil.invalid")).status).toBe(
		403,
	);
	const response = await first.api(`${endpoint}/content`, phone.token, undefined, "https://localhost");
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toBe("application/pdf");
	expect(response.headers.get("Content-Disposition")).toContain(
		"filename*=UTF-8''R%C3%A9sum%C3%A9%20%5Bfinal%5D.pdf",
	);
	expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://localhost");
	expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
	rmSync(path);
	await first.daemon.close();
	daemons.splice(daemons.indexOf(first.daemon), 1);
	const second = await setup(first.dir);
	expect(second.env.GENTLE_DOT_FILES_KEY).not.toBe(first.env.GENTLE_DOT_FILES_KEY);
	expect((await second.api("/api/files/agent", first.env.GENTLE_DOT_FILES_KEY, { path })).status).toBe(401);
	expect(await (await second.api(`${endpoint}/meta`, phone.token)).json()).toEqual({
		id: publication.id,
		name: publication.name,
		size: bytes.length,
		mime: "application/pdf",
		image: false,
	});
	expect(
		Buffer.from(await (await second.api(`${endpoint}/content`, second.daemon.token)).arrayBuffer()),
	).toEqual(bytes);
	expect((await second.api(`${endpoint}/content`, phone.token, {})).status).toBe(405);
	expect((await second.api(`/api/files/${"x".repeat(43)}/meta`, phone.token)).status).toBe(404);
	await second.api("/api/mobile/revoke", second.daemon.token, { deviceId: phone.deviceId });
	for (const suffix of ["meta", "content"])
		expect((await second.api(`${endpoint}/${suffix}`, phone.token)).status).toBe(401);
});

it("loads dot_share_file through real Pi, invokes its HTTP flow, and returns usable chat markdown", async () => {
	const { dir, env, pair, api } = await setup();
	const path = join(dir, "delivered.txt");
	writeFileSync(path, "Listo: el resultado solicitado.");
	vi.stubEnv("GENTLE_DOT_FILES_URL", env.GENTLE_DOT_FILES_URL);
	vi.stubEnv("GENTLE_DOT_FILES_KEY", env.GENTLE_DOT_FILES_KEY);
	// Real SDK loader/registration, isolated discovery dirs; no model or user Pi configuration.
	const loaded = await discoverAndLoadExtensions([SHARE_FILE_EXTENSION_PATH], dir, dir);
	expect(loaded.errors).toEqual([]);
	const tool = loaded.extensions[0]?.tools.get("dot_share_file")?.definition;
	expect(tool).toBeDefined();
	const result = await tool?.execute(
		"fixture",
		{ path, title: "Resultado" },
		undefined,
		undefined,
		{} as ExtensionToolContext,
	);
	const content = result?.content[0];
	if (content?.type !== "text") throw new Error("Expected tool metadata");
	const publication = JSON.parse(content.text);
	expect(publication.markdown).toBe(`[Resultado](/api/files/${publication.id}/content)`);
	const phone = await pair();
	expect(await (await api(`/api/files/${publication.id}/content`, phone.token)).text()).toBe(
		"Listo: el resultado solicitado.",
	);
	await expect(
		tool?.execute("denied", { path: join(dir, ".env") }, undefined, undefined, {} as ExtensionToolContext),
	).rejects.toThrow(/credenciales/);
});

async function gatewayServer(gateway: SharedFilesGateway) {
	const server = createServer((req, res) => {
		void gateway.handle(req, res);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No port");
	return `http://127.0.0.1:${address.port}`;
}
it("disables both file endpoints without a local store, including VPS mode", async () => {
	const base = await gatewayServer(
		new SharedFilesGateway({
			acceptsHuman: (key) => key === "owner",
			acceptsAgent: (key) => key === "agent",
			origins: () => new Set(),
		}),
	);
	for (const [path, key, method] of [
		[`/api/files/${"x".repeat(43)}/meta`, "owner", "GET"],
		["/api/files/agent", "agent", "POST"],
	]) {
		expect((await fetch(base + path, { method, headers: { Authorization: `Bearer ${key}` } })).status).toBe(
			503,
		);
	}
});

it("rechecks an engine's authorization after a delayed request body", async () => {
	const dir = tempDir();
	dirs.push(dir);
	const source = join(dir, "result.txt");
	writeFileSync(source, "a test result");
	const store = new SharedFileStore(dir);
	let permitted = true;
	const base = await gatewayServer(
		new SharedFilesGateway({
			store,
			acceptsHuman: () => false,
			acceptsAgent: () => permitted,
			origins: () => new Set(),
		}),
	);
	let finish!: () => void;
	const status = new Promise<number>((resolve, reject) => {
		const req = httpRequest(
			`${base}/api/files/agent`,
			{ method: "POST", headers: { Authorization: "Bearer agent", "Content-Type": "application/json" } },
			(res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			},
		);
		req.on("error", reject);
		req.write('{"path":');
		finish = () => req.end(`${JSON.stringify(source)}}`);
	});
	await new Promise((resolve) => setTimeout(resolve, 30));
	permitted = false;
	finish();
	expect(await status).toBe(401);
	expect(() => store.meta("x".repeat(43))).toThrow();
});

it("stops an in-flight download when its device is revoked", async () => {
	const dir = tempDir();
	dirs.push(dir);
	const path = join(dir, "large.bin");
	writeFileSync(path, Buffer.alloc(8 * 1024 * 1024, 65));
	const store = new SharedFileStore(dir);
	const file = store.publish({ path });
	let allowed = true;
	const base = await gatewayServer(
		new SharedFilesGateway({
			store,
			acceptsHuman: () => allowed,
			acceptsAgent: () => false,
			origins: () => new Set(),
		}),
	);
	const result = await new Promise<{ complete: boolean; bytes: number }>((resolve, reject) => {
		const req = httpRequest(
			`${base}/api/files/${file.id}/content`,
			{ headers: { Authorization: "Bearer phone" } },
			(res) => {
				let received = 0;
				res.on("data", (chunk) => {
					received += chunk.length;
					allowed = false;
				});
				res.on("error", () => {});
				res.on("close", () => resolve({ complete: res.complete, bytes: received }));
			},
		);
		req.on("error", reject);
		req.end();
	});
	expect(result.complete).toBe(false);
	expect(result.bytes).toBeGreaterThan(0);
	expect(result.bytes).toBeLessThan(file.size);
});

it("shares the actual native capture through the real SDK without accepting image bytes or paths", async () => {
	const dir = tempDir();
	dirs.push(dir);
	const store = new SharedFileStore(dir);
	const captures = new ComputerCaptureStore();
	const base = await gatewayServer(
		new SharedFilesGateway({
			store,
			shareComputerCapture: () => store.publishCapture(captures.latest(), "computer"),
			acceptsAgent: (key) => key === "engine",
			acceptsHuman: (key) => key === "phone",
			origins: () => new Set(),
		}),
	);
	vi.stubEnv("GENTLE_DOT_FILES_URL", `${base}/api/files/agent`);
	vi.stubEnv("GENTLE_DOT_FILES_KEY", "engine");
	const loaded = await discoverAndLoadExtensions([SHARE_FILE_EXTENSION_PATH], dir, dir);
	expect(loaded.errors).toEqual([]);
	const tool = loaded.extensions[0]?.tools.get("dot_share_screenshot")?.definition;
	if (!tool) throw new Error("Screenshot tool was not registered");
	const share = () => tool.execute("share", {}, undefined, undefined, {} as ExtensionToolContext);
	await expect(share()).rejects.toThrow(/captura/i);
	captures.observe({ type: "agent_start" });
	captures.observe({
		type: "tool_execution_start",
		toolName: "mcp__computer__screenshot",
		toolCallId: "actual",
	});
	captures.observe({
		type: "tool_execution_end",
		toolName: "mcp__computer__screenshot",
		toolCallId: "actual",
		isError: false,
		result: { content: [{ type: "image", mimeType: "image/jpeg", data: CAPTURE_JPEG.toString("base64") }] },
	});
	for (const extra of [
		{ path: "/private/file" },
		{ data: CAPTURE_JPEG.toString("base64") },
		{ url: "https://elsewhere.invalid" },
	]) {
		const response = await fetch(`${base}/api/files/agent`, {
			method: "POST",
			headers: { Authorization: "Bearer engine", "Content-Type": "application/json" },
			body: JSON.stringify({ action: "share_computer_screenshot", ...extra }),
		});
		expect(response.status).toBe(400);
	}
	const result = await share();
	const text = result.content[0];
	if (text?.type !== "text") throw new Error("Expected publication metadata");
	const file = JSON.parse(text.text);
	expect(file).toMatchObject({
		name: "captura-equipo.jpg",
		mime: "image/jpeg",
		image: true,
		size: CAPTURE_JPEG.length,
	});
	expect(file.markdown).toBe(`![Captura del equipo](/api/files/${file.id}/content)`);
	const download = await fetch(`${base}/api/files/${file.id}/content`, {
		headers: { Authorization: "Bearer phone" },
	});
	expect(Buffer.from(await download.arrayBuffer())).toEqual(CAPTURE_JPEG);
	expect((await fetch(`${base}/api/files/${file.id}/content`)).status).toBe(401);
	expect(
		(
			await fetch(`${base}/api/files/agent`, {
				method: "POST",
				headers: { Authorization: "Bearer phone", "Content-Type": "application/json" },
				body: JSON.stringify({ action: "share_computer_screenshot" }),
			})
		).status,
	).toBe(401);
	captures.observe({ type: "agent_settled" });
	await expect(share()).rejects.toThrow(/captura/i);
});

it("delivers a published screenshot live and after reconnect even when the model omits its link", async () => {
	const { daemon, base, api, env, pair } = await setup();
	const phone = await pair();
	const connect = async () => {
		const ws = new WebSocket(`${base.replace("http:", "ws:")}/ws`);
		const received: ServerMessage[] = [];
		ws.on("message", (raw) => received.push(JSON.parse(String(raw))));
		await new Promise((resolve) => ws.once("open", resolve));
		ws.send(JSON.stringify({ type: "hello", token: phone.token, protocol: 1 }));
		await waitFor(() => received.find((event) => event.type === "ready"));
		return { ws, received };
	};
	const first = await connect();
	first.ws.send(JSON.stringify({ type: "send", text: "share-screenshot" }));
	const done = await waitFor(() =>
		first.received.find(
			(event): event is Extract<ServerMessage, { type: "message_done" }> =>
				event.type === "message_done" && event.text.includes("/api/files/"),
		),
	);
	expect(done.text).toMatch(
		/^Acá tenés la captura\.\n\n!\[Captura del equipo\]\(\/api\/files\/[A-Za-z0-9_-]{43}\/content\)$/,
	);
	const path = /\((\/api\/files\/[^)]+)\)/.exec(done.text)?.[1];
	if (!path) throw new Error("No delivered capture URL");
	expect(Buffer.from(await (await api(path, phone.token)).arrayBuffer())).toEqual(CAPTURE_JPEG);
	await waitFor(() => !daemon.supervisor.busy);
	first.ws.close();
	const second = await connect();
	second.ws.send(JSON.stringify({ type: "get_history" }));
	const history = await waitFor(() => second.received.find((event) => event.type === "history"));
	const displayed = history.messages.filter((message: { text: string }) => message.text.includes(path));
	expect(displayed).toHaveLength(1);
	expect(displayed[0]?.text).toBe(done.text);
	second.ws.close();
	// The next turn cannot publish a screenshot from this completed request.
	const stale = await api("/api/files/agent", env.GENTLE_DOT_FILES_KEY, {
		action: "share_computer_screenshot",
	});
	expect(stale.status).toBeGreaterThanOrEqual(400);
});
