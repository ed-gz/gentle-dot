import { afterEach, expect, it, vi } from "vitest";
import { CompanionActivityPoll, type CompanionPollPeer } from "../src/orchestration/companion-poll.ts";

afterEach(() => vi.useRealTimers());
const first: CompanionPollPeer = { key: "instance1:s1", paneId: "p1", sessionId: "s1" };

it("polls only the focused capable peer every 500ms while the companion is consumed", async () => {
	vi.useFakeTimers();
	let focused: CompanionPollPeer | undefined;
	const read = vi.fn(async () => ({ phase: "typing" }));
	const accept = vi.fn();
	const poll = new CompanionActivityPoll({ peer: () => focused, read, accept, unavailable: vi.fn() });
	poll.touch();
	await vi.advanceTimersByTimeAsync(500);
	expect(read).not.toHaveBeenCalled(); // Legacy/missing capability never gets a new RPC.
	focused = first;
	await vi.advanceTimersByTimeAsync(500);
	expect(read).toHaveBeenCalledExactlyOnceWith(first);
	expect(accept).toHaveBeenCalledWith(first, { phase: "typing" });
	focused = { key: "instance2:s2", paneId: "p2", sessionId: "s2" };
	await vi.advanceTimersByTimeAsync(500);
	expect(read).toHaveBeenLastCalledWith(focused);
	await vi.advanceTimersByTimeAsync(1500);
	const count = read.mock.calls.length;
	await vi.advanceTimersByTimeAsync(10000);
	expect(read).toHaveBeenCalledTimes(count); // Lease expires when Capri stops consuming.
	poll.close();
});

it("backs off unsupported peers, resets activity on disconnect and retries a different instance", async () => {
	vi.useFakeTimers();
	let focused = first;
	const read = vi.fn(async () => {
		throw Object.assign(new Error("unsupported"), { code: "UNKNOWN_ACTION" });
	});
	const unavailable = vi.fn();
	const poll = new CompanionActivityPoll({ peer: () => focused, read, accept: vi.fn(), unavailable });
	poll.touch();
	await vi.advanceTimersByTimeAsync(500);
	expect(unavailable).toHaveBeenCalledExactlyOnceWith(first);
	for (let i = 0; i < 10; i++) {
		poll.touch();
		await vi.advanceTimersByTimeAsync(500);
	}
	expect(read).toHaveBeenCalledOnce();
	focused = { ...first, key: "new-instance:s1" };
	poll.touch();
	await vi.advanceTimersByTimeAsync(500);
	expect(read).toHaveBeenCalledTimes(2);
	poll.close();
});

it("discards late replies after focus/session change and stops cleanly with a request in flight", async () => {
	vi.useFakeTimers();
	let focused = first;
	let finish: (value: unknown) => void = () => {};
	const read = vi.fn(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const accept = vi.fn();
	const poll = new CompanionActivityPoll({ peer: () => focused, read, accept, unavailable: vi.fn() });
	poll.touch();
	await vi.advanceTimersByTimeAsync(500);
	focused = { ...first, sessionId: "s2", key: "instance1:s2" };
	finish({ phase: "typing" });
	await vi.advanceTimersByTimeAsync(0);
	expect(accept).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(500);
	expect(read).toHaveBeenCalledTimes(2);
	poll.close();
	finish({ phase: "working" });
	await vi.advanceTimersByTimeAsync(5000);
	expect(accept).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});
