import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentConversation, OrchestrationClient } from "../src/orchestration.ts";
import { useSessionPolling } from "../src/useSessionPolling.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
const page: AgentConversation = { sessionId: "one", messages: [], status: "working", question: null };

it("refreshes the open session without global discovery, never overlaps reads, and pauses when hidden", async () => {
	vi.useFakeTimers();
	const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	let complete!: (value: AgentConversation) => void;
	const inspect = vi.fn(
		() =>
			new Promise<AgentConversation>((resolve) => {
				complete = resolve;
			}),
	);
	const client = { inspect, snapshot: vi.fn(), act: vi.fn() } as OrchestrationClient;
	const onSnapshot = vi.fn();
	const { result, unmount } = renderHook(() =>
		useSessionPolling(client, "pane", "one", true, true, onSnapshot, vi.fn()),
	);
	expect(inspect).toHaveBeenCalledTimes(1);
	await act(async () => {
		result.current();
		result.current();
		await vi.advanceTimersByTimeAsync(10_000);
	});
	expect(inspect).toHaveBeenCalledTimes(1);
	await act(async () => {
		complete(page);
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1);
	});
	expect(onSnapshot).toHaveBeenCalledWith(page);
	expect(inspect).toHaveBeenCalledTimes(2);
	await act(async () => complete(page));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1_000);
	});
	expect(inspect).toHaveBeenCalledTimes(3);
	visibility.mockReturnValue("hidden");
	await act(async () => {
		document.dispatchEvent(new Event("visibilitychange"));
		complete(page);
		await vi.advanceTimersByTimeAsync(60_000);
	});
	expect(inspect).toHaveBeenCalledTimes(3);
	expect(client.snapshot).not.toHaveBeenCalled();
	visibility.mockReturnValue("visible");
	await act(async () => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
	expect(inspect).toHaveBeenCalledTimes(4);
	unmount();
});

it("fences late reads from a replaced session and retains a single polling owner", async () => {
	vi.useFakeTimers();
	let finishOld!: (value: AgentConversation) => void;
	const inspect = vi
		.fn()
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishOld = resolve;
				}),
		)
		.mockResolvedValue({ ...page, sessionId: "two" });
	const onSnapshot = vi.fn();
	const client = { inspect, snapshot: vi.fn(), act: vi.fn() } as OrchestrationClient;
	const { rerender, unmount } = renderHook(
		({ id }) => useSessionPolling(client, "pane", id, true, false, onSnapshot, vi.fn()),
		{ initialProps: { id: "one" } },
	);
	rerender({ id: "two" });
	await act(async () => finishOld(page));
	expect(onSnapshot).toHaveBeenCalledExactlyOnceWith({ ...page, sessionId: "two" });
	await act(async () => {
		await vi.advanceTimersByTimeAsync(4_000);
	});
	expect(inspect).toHaveBeenCalledTimes(3);
	unmount();
});
