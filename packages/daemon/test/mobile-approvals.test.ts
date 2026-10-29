import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppApproval } from "../src/app-channel.ts";
import { MobileApprovals } from "../src/mobile-approvals.ts";

const request: AppApproval = {
	connector: "GitHub",
	action: "merge a pull request",
	preview: [
		{ name: "Repository", value: "owner/project" },
		{ name: "PR", value: 42 },
		{ name: "Options", value: { squash: true, checks: ["passed"] } },
	],
};
const brokers: MobileApprovals[] = [];
function broker(options: ConstructorParameters<typeof MobileApprovals>[0] = {}) {
	const result = new MobileApprovals(options);
	brokers.push(result);
	return result;
}
afterEach(() => {
	for (const b of brokers.splice(0)) b.close();
	vi.useRealTimers();
});

describe("mobile per-action approvals", () => {
	it("binds the decision to every displayed field and to a unique generation even if an ID is reused", async () => {
		const b = broker({ now: () => 1000, waitMs: 2000 });
		const first = b.begin("reused", request);
		const original = b.list()[0]!;
		for (const changed of [{...original, title: "different"}, {...original, message: "different"}, {...original, expiresAt: new Date(2000).toISOString()}, {...original, revision: crypto.randomUUID()}])
			expect(b.answerExact(changed, true)).toBe(false);
		expect(b.list()).toHaveLength(1);
		expect(b.answerExact(original, false)).toBe(true);
		expect(await first.answer).toBe(false);
		const second = b.begin("reused", request);
		const next = b.list()[0]!;
		expect(next.revision).not.toBe(original.revision);
		expect(b.answerExact(original, true)).toBe(false);
		expect(b.answerExact(next, true)).toBe(true);
		expect(await second.answer).toBe(true);
	});
	it("shows the complete preview and immutable expiry before granting exactly one action", async () => {
		const b = broker({ now: () => 1000, waitMs: 2000 });
		const pending = b.begin("request-a", request);
		const view = b.list()[0];
		expect(view).toMatchObject({ id: "request-a", expiresAt: new Date(3000).toISOString() });
		expect(view?.message).toContain("owner/project");
		expect(view?.message).toContain('"checks": [\n    "passed"\n  ]');
		if (view) view.message = "changed";
		expect(b.list()[0]?.message).toContain("Repository");
		expect(b.answer("request-a", true)).toBe(true);
		expect(await pending.answer).toBe(true);
		expect(b.answer("request-a", true)).toBe(false);
		expect(b.list()).toEqual([]);
	});
	it("decline wins over a late approval, without affecting another request", async () => {
		const b = broker();
		const first = b.begin("a", request);
		const second = b.begin("b", request);
		expect(b.answer("missing", true)).toBe(false);
		expect(b.answer("a", false)).toBe(true);
		expect(b.answer("a", true)).toBe(false);
		expect(await first.answer).toBe(false);
		expect(b.list().map((item) => item.id)).toEqual(["b"]);
		second.cancel();
		expect(await second.answer).toBe(false);
	});
	it("fails closed on timeout and rejects a delayed approval even before the timer callback", async () => {
		let now = 1000;
		const b = broker({ now: () => now, waitMs: 100 });
		const first = b.begin("a", request);
		now += 100;
		expect(b.answer("a", true)).toBe(false);
		expect(await first.answer).toBe(false);
		vi.useFakeTimers();
		const second = b.begin("b", request);
		await vi.advanceTimersByTimeAsync(100);
		expect(await second.answer).toBe(false);
		expect(b.list()).toEqual([]);
	});
	it("abort, cancellation and close retire pending requests permanently", async () => {
		const b = broker();
		const abort = new AbortController();
		const first = b.begin("a", request, abort.signal);
		abort.abort();
		expect(await first.answer).toBe(false);
		expect(b.answer("a", true)).toBe(false);
		expect(await b.begin("aborted", request, abort.signal).answer).toBe(false);
		const second = b.begin("b", request);
		b.close();
		expect(await second.answer).toBe(false);
		expect(await b.begin("closed", request).answer).toBe(false);
		expect(b.list()).toEqual([]);
	});
	it("disconnect cancels every pending request while allowing fresh requests after reconnect", async () => {
		const b = broker();
		const first = b.begin("first", request);
		const second = b.begin("second", request);
		b.cancelAll();
		expect(await first.answer).toBe(false);
		expect(await second.answer).toBe(false);
		expect(b.answer("second", true)).toBe(false);
		const next = b.begin("reconnected", request);
		expect(b.answer("reconnected", true)).toBe(true);
		expect(await next.answer).toBe(true);
	});
	it("rejects duplicate pending ids without replacing the original request", async () => {
		const b = broker();
		const pending = b.begin("same", request);
		expect(() => b.begin("same", { ...request, action: "different action" })).toThrow("unique");
		expect(b.list()).toHaveLength(1);
		b.answer("same", false);
		expect(await pending.answer).toBe(false);
	});
	it("does not silently omit unsupported values or truncate oversized previews", () => {
		const b = broker();
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		for (const value of [undefined, Infinity, () => true, cyclic])
			expect(() => b.begin("bad", { ...request, preview: [{ name: "value", value }] })).toThrow();
		expect(() =>
			b.begin("large", { ...request, preview: [{ name: "Payload", value: "á".repeat(33000) }] }),
		).toThrow("64 KiB");
		expect(b.list()).toEqual([]);
	});
	it("does not coerce strings into approval", async () => {
		const b = broker();
		const pending = b.begin("a", request);
		expect(b.answer("a", "false" as unknown as boolean)).toBe(false);
		expect(b.list()).toHaveLength(1);
		pending.cancel();
		expect(await pending.answer).toBe(false);
	});
});
