import { getEventListeners } from "node:events";
import { duplexPair } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { AppChannel } from "../src/app-channel.ts";
import { waitFor } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(waitMs = 2000) {
	const [a, b] = duplexPair();
	const channel = new AppChannel(a, { approvalWaitMs: waitMs });
	const frames: { id: number; method: string; params: { requestId: string } }[] = [];
	let buffer = "";
	b.setEncoding("utf8");
	b.on("data", (chunk: string) => {
		buffer += chunk;
		for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
			frames.push(JSON.parse(buffer.slice(0, end)));
			buffer = buffer.slice(end + 1);
		}
	});
	cleanups.push(() => {
		channel.close();
		b.destroy();
	});
	return {
		channel,
		frames,
		reply: (id: number, result: unknown) => b.write(`${JSON.stringify({ kind: "response", id, result })}\n`),
	};
}
const request = { connector: "Programa de prueba", action: "continuar investigación", preview: [] };

it("cancels only the original native dialog and ignores its later approval", async () => {
	const h = fixture();
	const abort = new AbortController();
	const first = h.channel.approve(request, abort.signal);
	const one = await waitFor(() => h.frames.find((frame) => frame.method === "approve"));
	abort.abort();
	expect(await first).toBe(false);
	const cancellation = await waitFor(() => h.frames.find((frame) => frame.method === "approve_cancel"));
	expect(cancellation.params.requestId).toBe(one.params.requestId);
	h.reply(cancellation.id, { cancelled: true });
	h.reply(one.id, { approved: true });
	const second = h.channel.approve(request);
	const two = await waitFor(() => h.frames.filter((frame) => frame.method === "approve")[1]);
	expect(two.params.requestId).not.toBe(one.params.requestId);
	h.reply(two.id, { approved: true });
	expect(await second).toBe(true);
	expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
});

it("dismisses a timed-out native request instead of leaving an actionable dialog", async () => {
	const h = fixture(40);
	expect(await h.channel.approve(request)).toBe(false);
	const cancellation = await waitFor(() => h.frames.find((frame) => frame.method === "approve_cancel"));
	expect(cancellation.params.requestId).toBe(h.frames[0]?.params.requestId);
	h.reply(cancellation.id, { cancelled: true });
});

it("does not send pre-cancelled approvals and removes listeners after normal replies", async () => {
	const h = fixture();
	const cancelled = new AbortController();
	cancelled.abort();
	expect(await h.channel.approve(request, cancelled.signal)).toBe(false);
	expect(h.frames).toHaveLength(0);
	const live = new AbortController();
	const answer = h.channel.approve(request, live.signal);
	const frame = await waitFor(() => h.frames[0]);
	h.reply(frame.id, { approved: false });
	expect(await answer).toBe(false);
	expect(getEventListeners(live.signal, "abort")).toHaveLength(0);
	live.abort();
	expect(h.frames).toHaveLength(1);
});
