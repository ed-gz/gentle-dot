import { expect, it, vi } from "vitest";
import type { localRequest } from "../src/orchestration/herdr.ts";
import type { Manifest } from "../src/orchestration/registry.ts";
import { peerSessionMetadata } from "../src/orchestration/session-peer.ts";

const bound: Manifest = {
	version: 2,
	managed: true,
	socketPath: "/dot.sock",
	pid: 42,
	processIdentity: "owned-process",
	instanceId: "dot-instance",
	sessionId: "owned-session",
	sessionFile: "/owned.jsonl",
	binding: { provider: "herdr", terminalId: "terminal", herdrSocketPath: "/herdr.sock" },
};
const peer: Manifest = {
	...bound,
	version: 1,
	managed: false,
	socketPath: "/peer.sock",
	instanceId: undefined,
	processIdentity: undefined,
};
const response = {
	sessionId: bound.sessionId,
	model: { id: "runtime-model", provider: "fixture", apiKey: "PRIVATE" },
	context: { tokens: 1234, contextWindow: 200000, percent: 0.617, private: "PRIVATE" },
	capabilities: { questions: true },
	profile: { name: "UNVERIFIED" },
	mcp: [{ name: "UNVERIFIED" }],
	messages: [{ role: "user", content: "PRIVATE" }],
};
const identify = async () => bound.processIdentity;

it("reads only public live model/context from the same process and session with a bounded read-only request", async () => {
	const request = vi.fn(async () => response);
	const value = await peerSessionMetadata(bound, [bound, peer], request, () => true, identify);
	expect(value).toEqual({
		version: 1,
		source: "live",
		model: { id: "runtime-model", name: "runtime-model", provider: "fixture", source: "live" },
		context: { tokens: 1234, contextWindow: 200000, percent: 0.617, source: "live" },
	});
	expect(request).toHaveBeenCalledWith(
		"/peer.sock",
		"snapshot",
		{ expectedSessionId: "owned-session", limit: 1 },
		750,
		expect.any(Function),
	);
	expect(JSON.stringify(value)).not.toMatch(/PRIVATE|UNVERIFIED|questions/);
});

it("never consults ambiguous peers, other terminals/sessions/processes or unsupported primary adapters", async () => {
	const request = vi.fn(async () => response);
	const invalid = [
		{ ...peer, pid: 43 },
		{ ...peer, sessionId: "other" },
		{ ...peer, processIdentity: "reused-pid" },
		{ ...peer, sessionFile: "/other.jsonl" },
		{ ...peer, binding: { ...peer.binding, terminalId: "other" } },
		{ ...peer, binding: { ...peer.binding, herdrSocketPath: "/other.sock" } },
	];
	for (const candidate of invalid)
		expect(await peerSessionMetadata(bound, [candidate], request, () => true, identify)).toBeUndefined();
	for (const primary of [
		{ ...bound, version: 1 as const },
		{ ...bound, processIdentity: undefined },
		{ ...bound, managed: false },
	])
		expect(await peerSessionMetadata(primary, [peer], request, () => true, identify)).toBeUndefined();
	expect(
		await peerSessionMetadata(
			bound,
			[peer, { ...peer, socketPath: "/second.sock" }],
			request,
			() => true,
			identify,
		),
	).toBeUndefined();
	expect(request).not.toHaveBeenCalled();
});

it("rejects PID reuse before and after reading, session changes and revoked phone access", async () => {
	const request = vi.fn(async () => response);
	expect(
		await peerSessionMetadata(
			bound,
			[peer],
			request,
			() => true,
			async () => "reused",
		),
	).toBeUndefined();
	expect(request).not.toHaveBeenCalled();
	let checks = 0;
	expect(
		await peerSessionMetadata(
			bound,
			[peer],
			request,
			() => true,
			async () => (++checks === 1 ? bound.processIdentity : "reused"),
		),
	).toBeUndefined();
	expect(
		await peerSessionMetadata(
			bound,
			[peer],
			async () => ({ ...response, sessionId: "other" }),
			() => true,
			identify,
		),
	).toBeUndefined();
	let authorized = true;
	expect(
		await peerSessionMetadata(
			bound,
			[peer],
			async () => {
				authorized = false;
				return response;
			},
			() => authorized,
			identify,
		),
	).toBeUndefined();
});

it("isolates timeout and malformed fields without fabricating quota, tools or configuration", async () => {
	expect(
		await peerSessionMetadata(
			bound,
			[peer],
			async () => {
				throw new Error("timeout");
			},
			() => true,
			identify,
		),
	).toBeUndefined();
	const request = (async () => ({
		sessionId: bound.sessionId,
		model: { id: "valid", provider: "fixture" },
		context: { tokens: -1, contextWindow: -1, percent: NaN },
	})) as typeof localRequest;
	expect(await peerSessionMetadata(bound, [peer], request, () => true, identify)).toMatchObject({
		model: { id: "valid" },
	});
	expect((await peerSessionMetadata(bound, [peer], request, () => true, identify))?.context).toBeUndefined();
});
