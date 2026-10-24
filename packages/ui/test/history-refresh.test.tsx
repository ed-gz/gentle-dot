import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type DotState, initialState } from "../src/store.ts";
import { useHistoryRefresh } from "../src/useHistoryRefresh.ts";

const history = (count: number) =>
	Array.from({ length: count }, (_, i) => ({
		id: `m${i}`,
		role: "user" as const,
		text: `Message ${i}`,
		streaming: false,
		activities: [],
	}));
const idle: DotState = {
	...initialState,
	connection: "open",
	agentState: "idle",
	conversationId: "a",
	features: { conversations: false, historyRefresh: true },
	messages: history(450),
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	window.getSelection()?.removeAllRanges();
	document.querySelectorAll("dialog").forEach((node) => {
		node.remove();
	});
});
const settle = () => act(() => vi.advanceTimersByTime(1001));

it("rebases an idle client at latest once and doesn't loop if a server returns the same oversized history", () => {
	const send = vi.fn(() => true);
	const h = renderHook((state) => useHistoryRefresh(state, true, send), { initialProps: idle });
	settle();
	expect(send).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
	h.rerender({ ...idle, messages: [...idle.messages] });
	settle();
	expect(send).toHaveBeenCalledOnce();
	h.rerender({ ...idle, messages: history(100) });
	h.rerender(idle);
	settle();
	expect(send).toHaveBeenCalledTimes(2);
});

it.each([
	{ atLatest: false },
	{ agentState: "thinking" as const },
	{ asks: [{ requestId: "a", method: "confirm" as const, title: "Allow?" }] },
	{ queue: { steering: ["next"], followUp: [] } },
	{
		messages: [
			{ id: "stream", role: "assistant" as const, text: "", activities: [], streaming: true },
			...idle.messages.slice(1),
		],
	},
	{ connection: "closed" as const },
])("defers while the reader or assistant is busy: %j", (guard) => {
	const send = vi.fn(() => true);
	renderHook(() =>
		useHistoryRefresh({ ...idle, ...guard }, "atLatest" in guard ? (guard.atLatest ?? true) : true, send),
	);
	settle();
	expect(send).not.toHaveBeenCalled();
});

it("does not close the image viewer or remove selected text and rechecks when the interaction finishes", () => {
	const send = vi.fn(() => true);
	const dialog = document.createElement("dialog");
	dialog.open = true;
	document.body.append(dialog);
	renderHook(() => useHistoryRefresh(idle, true, send));
	settle();
	expect(send).not.toHaveBeenCalled();
	act(() => {
		dialog.open = false;
		dialog.dispatchEvent(new Event("close"));
	});
	settle();
	expect(send).toHaveBeenCalledOnce();
});

it("cancels the pending refresh when new work or reading starts", () => {
	const send = vi.fn(() => true);
	const h = renderHook((atLatest) => useHistoryRefresh(idle, atLatest, send), { initialProps: true });
	act(() => vi.advanceTimersByTime(500));
	h.rerender(false);
	settle();
	expect(send).not.toHaveBeenCalled();
});

it("revalidates a delayed response against scrolling, selection, image opening and conversation changes", () => {
	const refresh = vi.fn((_accept: () => boolean) => true);
	let atEnd = true;
	const h = renderHook((state) => useHistoryRefresh(state, true, refresh, () => atEnd), {
		initialProps: idle,
	});
	settle();
	const accept = refresh.mock.calls[0]?.[0] as unknown as () => boolean;
	expect(accept()).toBe(true);
	atEnd = false;
	expect(accept()).toBe(false);
	atEnd = true;
	const text = document.createElement("p");
	text.textContent = "Selected message";
	document.body.append(text);
	const range = document.createRange();
	range.selectNodeContents(text);
	window.getSelection()?.addRange(range);
	expect(accept()).toBe(false);
	window.getSelection()?.removeAllRanges();
	text.remove();
	const dialog = document.createElement("dialog");
	dialog.open = true;
	document.body.append(dialog);
	expect(accept()).toBe(false);
	dialog.remove();
	h.rerender({ ...idle, conversationId: "next" });
	expect(accept()).toBe(false);
});
