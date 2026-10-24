import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type JsonRpcMessage, McpClient, McpTimeoutError, type McpTransport } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type { BrowserContext } from "playwright-core";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserController } from "../src/browser.ts";
import { BrowserRequests } from "../src/browser-requests.ts";
import { McpProxy, type McpProxyOptions, type ProxiedConnector } from "../src/mcp-proxy.ts";
import { SharedFileStore } from "../src/shared-files.ts";
import { tempDir, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const definition = (id: string): ProxiedConnector => ({
	id,
	name: id,
	enabled: true,
	mode: "read_write",
	readOnlyTools: ["search"],
	revision: "one",
	server: { url: `https://${id}.fixture.test/mcp` },
});
async function fixture(options: Partial<McpProxyOptions> = {}) {
	const pending = new Map<string, (text?: string) => void>();
	const calls: string[] = [];
	const opened: string[] = [];
	const closed: string[] = [];
	const disconnect = new Map<string, () => Promise<void>>();
	const transport = (connector: ProxiedConnector): McpTransport => {
		opened.push(connector.id);
		const { client, server } = createInMemoryTransportPair();
		disconnect.set(connector.id, () => server.close());
		server.onClose(() => {
			closed.push(connector.id);
		});
		server.onMessage((message: JsonRpcMessage) => {
			if (!("method" in message) || !("id" in message)) return;
			const params = message.params as Record<string, unknown> | undefined;
			const reply = (result: unknown) => {
				void server.send({ jsonrpc: "2.0", id: message.id, result });
			};
			if (message.method === "initialize")
				reply({
					protocolVersion: params?.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: connector.id, version: "test" },
				});
			else if (message.method === "tools/list")
				reply({
					tools: [
						{ name: "search", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
						{ name: "send", inputSchema: { type: "object" } },
					],
				});
			else if (message.method === "tools/call") {
				const args = params?.arguments as { hold?: string } | undefined;
				calls.push(`${connector.id}:${String(params?.name)}:${args?.hold ?? "fast"}`);
				const finish = (text = "done") => reply({ content: [{ type: "text", text }] });
				if (args?.hold) pending.set(args.hold, finish);
				else finish();
			} else reply({});
		});
		void server.start();
		return client;
	};
	const proxy = new McpProxy({
		connector: definition,
		credentials: async () => ({}),
		approve: async () => true,
		transport,
		...options,
	});
	const key = proxy.rotateKey();
	const server = createServer((req, res) => proxy.handle(req, res));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(async () => {
		await proxy.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const post = async (connector: string, body: object) => {
		const response = await fetch(
			`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/${connector}`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", ...body }),
			},
		);
		return response.status === 202
			? undefined
			: (response.json() as Promise<{ result?: unknown; error?: { code: number; message: string } }>);
	};
	const call = (connector: string, id: number | string, hold?: string, tool = "search") =>
		post(connector, { id, method: "tools/call", params: { name: tool, arguments: hold ? { hold } : {} } });
	return { proxy, pending, calls, opened, closed, disconnect, post, call };
}

it("one connector's slow call and approval never delay Engram or another allowed tool", async () => {
	const decision = deferred<boolean>();
	const approve = vi.fn(() => decision.promise);
	const f = await fixture({ approve });
	const slow = f.call("mail", 1, "slow");
	await waitFor(() => f.pending.has("slow"));
	const sending = f.call("mail", 2, undefined, "send");
	await waitFor(() => approve.mock.calls.length === 1);
	await expect(f.call("engram", 1)).resolves.toMatchObject({ result: { content: [{ text: "done" }] } });
	await expect(f.call("mail", 3)).resolves.toMatchObject({ result: { content: [{ text: "done" }] } });
	expect(f.calls).not.toContain("mail:send:fast");
	decision.resolve(true);
	await expect(sending).resolves.toHaveProperty("result");
	f.pending.get("slow")?.();
	await expect(slow).resolves.toHaveProperty("result");
	expect(f.opened).toEqual(["mail", "engram"]);
});

it("cancelling one call preserves the shared connection and a different in-flight call", async () => {
	const f = await fixture();
	const first = f.call("mail", 10, "first");
	await waitFor(() => f.pending.has("first"));
	const second = f.call("mail", 11, "second");
	await waitFor(() => f.pending.has("second"));
	await f.post("mail", { method: "notifications/cancelled", params: { requestId: 10 } });
	await expect(first).resolves.toMatchObject({ error: { message: expect.stringMatching(/cancel/i) } });
	expect(f.closed).toEqual([]);
	f.pending.get("second")?.("second survived");
	await expect(second).resolves.toMatchObject({ result: { content: [{ text: "second survived" }] } });
	await expect(f.call("mail", 12)).resolves.toHaveProperty("result");
	expect(f.opened).toEqual(["mail"]);
});

it("cancelling the first background reader during shared connection setup preserves another caller", async () => {
	const ready = deferred<Record<string, never>>();
	const credentials = vi.fn(() => ready.promise);
	const prepare = vi.fn(async () => {});
	const f = await fixture({ credentials, prepare });
	const controller = new AbortController();
	const reader = f.proxy.readOnlyTools("mail", controller.signal).catch((error: unknown) => error);
	await waitFor(() => credentials.mock.calls.length === 1);
	const normal = f.call("mail", 13);
	await waitFor(() => prepare.mock.calls.length === 2);
	controller.abort();
	await expect(reader).resolves.toMatchObject({ code: "READ_CANCELLED" });
	ready.resolve({});
	await expect(normal).resolves.toHaveProperty("result");
	expect(f.opened).toEqual(["mail"]);
	expect(f.closed).toEqual([]);
});

it("revoking a connector during initial credentials prevents a late connection or tool execution", async () => {
	let current = definition("mail");
	const ready = deferred<Record<string, never>>();
	const credentials = vi.fn(() => ready.promise);
	const f = await fixture({ connector: () => current, credentials });
	const request = f.call("mail", 14);
	await waitFor(() => credentials.mock.calls.length === 1);
	current = { ...current, enabled: false };
	f.proxy.sync();
	ready.resolve({});
	await expect(request).resolves.toHaveProperty("error");
	expect(f.opened).toEqual([]);
	expect(f.calls).toEqual([]);
});

it("revalidates connector authority when reconnecting after an approved action", async () => {
	let current = definition("mail");
	const ready = deferred<Record<string, never>>();
	let credentialCalls = 0;
	const f = await fixture({
		connector: () => current,
		credentials: async () => (++credentialCalls === 2 ? ready.promise : {}),
		approve: async () => {
			await f.disconnect.get("mail")?.();
			return true;
		},
	});
	const request = f.call("mail", 15, undefined, "send");
	await waitFor(() => credentialCalls === 2);
	current = { ...current, enabled: false };
	f.proxy.sync();
	ready.resolve({});
	await expect(request).resolves.toHaveProperty("error");
	expect(f.opened).toEqual(["mail"]);
	expect(f.calls).toEqual([]);
});

it("cancellation is registered before slow connector preparation and prevents later approval or execution", async () => {
	const ready = deferred<void>();
	const prepare = vi.fn(() => ready.promise);
	const approve = vi.fn(async () => true);
	const f = await fixture({ prepare, approve });
	const request = f.call("mail", 20, undefined, "send");
	await waitFor(() => prepare.mock.calls.length === 1);
	await f.post("mail", { method: "notifications/cancelled", params: { requestId: 20 } });
	let result: unknown;
	void request.then((value) => {
		result = value;
	});
	try {
		await waitFor(() => result, 1000);
		expect(result).toMatchObject({ error: { message: expect.stringMatching(/cancel/i) } });
	} finally {
		ready.resolve();
	}
	await request;
	expect(f.opened).toEqual([]);
	expect(approve).not.toHaveBeenCalled();
	expect(f.calls).toEqual([]);
});

it("a real transport failure still drops that connector and reconnects without affecting another", async () => {
	const f = await fixture();
	const failed = f.call("mail", 30, "failed");
	await waitFor(() => f.pending.has("failed"));
	await expect(f.call("engram", 1)).resolves.toHaveProperty("result");
	await f.disconnect.get("mail")?.();
	await expect(failed).resolves.toHaveProperty("error");
	await expect(f.call("mail", 31)).resolves.toHaveProperty("result");
	await expect(f.call("engram", 2)).resolves.toHaveProperty("result");
	expect(f.opened).toEqual(["mail", "engram", "mail"]);
	expect(f.closed).toEqual(["mail"]);
});

it("distinguishes numeric and string request ids and never replaces a running cancellation owner", async () => {
	const f = await fixture();
	const number = f.call("mail", 40, "number");
	await waitFor(() => f.pending.has("number"));
	const text = f.call("mail", "40", "text");
	await waitFor(() => f.pending.has("text"));
	await expect(f.call("mail", 40)).resolves.toMatchObject({ error: { code: -32600 } });
	await f.post("mail", { method: "notifications/cancelled", params: { requestId: 40 } });
	await expect(number).resolves.toHaveProperty("error");
	f.pending.get("text")?.("string still active");
	await expect(text).resolves.toMatchObject({ result: { content: [{ text: "string still active" }] } });
	expect(f.closed).toEqual([]);
});

it("a local tool timeout leaves another call and the connector connection intact", async () => {
	const f = await fixture();
	const second = f.call("mail", 50, "survivor");
	await waitFor(() => f.pending.has("survivor"));
	const actual = McpClient.prototype.callTool;
	const spy = vi.spyOn(McpClient.prototype, "callTool").mockImplementation(function (
		this: McpClient,
		name,
		args,
		options,
	) {
		if (args?.timeoutFixture) return Promise.reject(new McpTimeoutError(10));
		return actual.call(this, name, args, options);
	});
	try {
		await expect(
			f.post("mail", {
				id: 51,
				method: "tools/call",
				params: { name: "search", arguments: { timeoutFixture: true } },
			}),
		).resolves.toMatchObject({ error: { message: expect.stringMatching(/timed out/i) } });
		expect(f.closed).toEqual([]);
		f.pending.get("survivor")?.();
		await expect(second).resolves.toHaveProperty("result");
	} finally {
		spy.mockRestore();
	}
});

it("a late allow after cancellation cannot execute and connector revocation still refuses pending actions", async () => {
	let current = definition("mail");
	let approval = deferred<boolean>();
	const approve = vi.fn(() => approval.promise);
	const f = await fixture({ connector: (id) => (id === "mail" ? current : definition(id)), approve });
	const cancelled = f.call("mail", 60, undefined, "send");
	await waitFor(() => approve.mock.calls.length === 1);
	await f.post("mail", { method: "notifications/cancelled", params: { requestId: 60 } });
	await expect(cancelled).resolves.toHaveProperty("error");
	approval.resolve(true);
	await expect(f.call("engram", 1)).resolves.toHaveProperty("result");
	expect(f.calls).not.toContain("mail:send:fast");
	approval = deferred<boolean>();
	const revoked = f.call("mail", 61, undefined, "send");
	await waitFor(() => approve.mock.calls.length === 2);
	current = { ...current, enabled: false };
	f.proxy.sync();
	approval.resolve(true);
	await expect(revoked).resolves.toHaveProperty("error");
	expect(f.calls).not.toContain("mail:send:fast");
});

it("a browser permission and slow browser launch do not block status or an external connector", async () => {
	const f = await fixture();
	const dataDir = tempDir();
	const launchGate = deferred<BrowserContext>();
	const permission = deferred<boolean>();
	const fake = Object.assign(new EventEmitter(), {
		pages: () => [],
		setDefaultTimeout: () => {},
		setDefaultNavigationTimeout: () => {},
		route: async () => {},
		close: async () => {
			fake.emit("close");
		},
	});
	const launch = vi.fn(() => launchGate.promise);
	const browser = new BrowserController({ dataDir, executablePath: process.execPath, launch });
	const ask = vi.fn(() => permission.promise);
	const requests = new BrowserRequests({ browser, files: new SharedFileStore(dataDir), ask });
	cleanup.push(async () => {
		permission.resolve(false);
		launchGate.resolve(fake as unknown as BrowserContext);
		requests.close();
		await browser.close();
		rmSync(dataDir, { recursive: true, force: true });
	});
	const opening = requests.action({ action: "request_access", reason: "Fixture isolated browser" }, "agent");
	await waitFor(() => ask.mock.calls.length === 1);
	await expect(requests.action({ action: "status" }, "agent")).resolves.toMatchObject({ active: false });
	await expect(f.call("engram", 70)).resolves.toHaveProperty("result");
	permission.resolve(true);
	await waitFor(() => launch.mock.calls.length === 1);
	await expect(requests.action({ action: "tabs" }, "agent")).resolves.toMatchObject({ running: false });
	await expect(f.call("engram", 71)).resolves.toHaveProperty("result");
	const queued = browser.action({ action: "open", url: "https://fixture.invalid" }, "agent");
	const rejected = expect(queued).rejects.toMatchObject({ code: "STOPPED" });
	const interrupted = expect(opening).rejects.toMatchObject({ code: "STOPPED" });
	await requests.action({ action: "stop" }, "human");
	launchGate.resolve(fake as unknown as BrowserContext);
	await Promise.all([rejected, interrupted]);
});
