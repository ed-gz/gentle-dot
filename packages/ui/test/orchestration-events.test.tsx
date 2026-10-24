import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OrchestrationClient, OrchestrationSnapshot } from "../src/orchestration.ts";
import { useOrchestration } from "../src/useOrchestration.ts";

afterEach(() => {
	delete window.__GENTLE_MOBILE__;
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it("releases a confirmed send without waiting for discovery of every other session", async () => {
	const snapshot: OrchestrationSnapshot = { available: true, sessions: [], approvals: [], policies: [], events: [] };
	let finishRefresh!: (value: OrchestrationSnapshot) => void;
	const client: OrchestrationClient = {
		snapshot: vi.fn().mockResolvedValueOnce(snapshot).mockImplementation(() => new Promise(resolve => { finishRefresh = resolve; })),
		act: vi.fn(async () => {}), inspect: vi.fn(),
	};
	const { result } = renderHook(() => useOrchestration(client));
	await waitFor(() => expect(result.current.snapshot).toBe(snapshot));
	await act(async () => {
		expect(await result.current.act({ action: "prompt", paneId: "pane", sessionId: "session", text: "continue" })).toBe(true);
	});
	expect(result.current.busy).toBe(false);
	expect(client.snapshot).toHaveBeenCalledTimes(2);
	await act(async () => finishRefresh(snapshot));
});

it("pauses session network requests in the background and refreshes on return", async () => {
	vi.useFakeTimers();
	const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
	const snapshot: OrchestrationSnapshot = {
		available: true,
		sessions: [],
		approvals: [],
		policies: [],
		events: [],
	};
	const client: OrchestrationClient = {
		snapshot: vi.fn(async () => snapshot),
		act: vi.fn(),
		inspect: vi.fn(),
	};
	const { unmount } = renderHook(() => useOrchestration(client));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(60_000);
	});
	expect(client.snapshot).not.toHaveBeenCalled();
	visibility.mockReturnValue("visible");
	await act(async () => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
	expect(client.snapshot).toHaveBeenCalledOnce();
	visibility.mockReturnValue("hidden");
	await act(async () => {
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(60_000);
	});
	expect(client.snapshot).toHaveBeenCalledOnce();
	unmount();
});

it("leaves notifications to the event stream and preserves status on disconnection", async () => {
	const notify = vi.fn(async () => {});
	window.__GENTLE_MOBILE__ = { transcribe: vi.fn(), notify };
	let snapshot: OrchestrationSnapshot = {
		available: true,
		sessions: [],
		approvals: [],
		policies: [],
		events: [
			{ id: "old", at: new Date().toISOString(), type: "completed", message: "Earlier task finished" },
		],
	};
	const client: OrchestrationClient = {
		snapshot: vi.fn(async () => snapshot),
		act: vi.fn(),
		inspect: vi.fn(),
	};
	const { result } = renderHook(() => useOrchestration(client));
	await waitFor(() => expect(result.current.snapshot).toBe(snapshot));
	expect(notify).not.toHaveBeenCalled();
	snapshot = {
		...snapshot,
		events: [
			...snapshot.events,
			{ id: "new", at: new Date().toISOString(), type: "completed", message: "Release finished" },
		],
	};
	await act(() => result.current.refresh());
	expect(notify).not.toHaveBeenCalled();
	await act(() => result.current.refresh());
	expect(notify).not.toHaveBeenCalled();
	vi.mocked(client.snapshot).mockRejectedValueOnce(new Error("Computer is offline"));
	await act(() => result.current.refresh());
	expect(result.current.error).toBe("Computer is offline");
	expect(result.current.snapshot).toBe(snapshot);
});

it("requires a snapshot from the current computer and isolates a late response from the previous one", async () => {
	const snapshot: OrchestrationSnapshot = {
		available: true,
		sessions: [],
		approvals: [],
		policies: [],
		events: [],
	};
	let resolveFirst!: () => void;
	const first: OrchestrationClient = {
		snapshot: vi.fn(async () => snapshot),
		act: vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveFirst = resolve;
				}),
		),
		inspect: vi.fn(),
	};
	let resolveSecond!: (value: OrchestrationSnapshot) => void;
	const second: OrchestrationClient = {
		snapshot: vi.fn(
			() =>
				new Promise<OrchestrationSnapshot>((resolve) => {
					resolveSecond = resolve;
				}),
		),
		act: vi.fn(),
		inspect: vi.fn(),
	};
	const { result, rerender } = renderHook(({ client }) => useOrchestration(client), {
		initialProps: { client: first },
	});
	await waitFor(() => expect(result.current.snapshot).toBe(snapshot));
	let pending!: Promise<boolean>;
	act(() => {
		pending = result.current.act({
			action: "answer",
			paneId: "pane",
			sessionId: "session",
			requestId: "first",
			approved: true,
		});
	});
	rerender({ client: second });
	expect(result.current.snapshot).toBeUndefined();
	await act(async () => {
		expect(
			await result.current.act({
				action: "answer",
				paneId: "pane",
				sessionId: "session",
				requestId: "first",
				approved: true,
			}),
		).toBe(false);
	});
	await act(async () => {
		resolveFirst();
		await pending;
	});
	expect(await pending).toBe(false);
	expect(second.act).not.toHaveBeenCalled();
	await act(async () => resolveSecond(snapshot));
	expect(result.current.snapshot).toBe(snapshot);
});
