import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { MessageList } from "../src/components/MessageList.tsx";
import type { ChatMessage } from "../src/store.ts";
import { CHAT_WINDOW_SIZE, useChatWindow } from "../src/useChatWindow.ts";

const messages = (start: number, count: number): ChatMessage[] =>
	Array.from({ length: count }, (_, index) => ({
		id: `m${start + index}`,
		role: "assistant",
		text: `Response ${start + index}`,
		activities: [],
		streaming: false,
	}));
function fixture(initial = messages(0, 5000)) {
	const loadEarlier = vi.fn();
	const prepareForPage = vi.fn();
	const props = {
		messages: initial,
		following: true,
		hasEarlier: false,
		conversationKey: "a",
		loadEarlier,
		prepareForPage,
	};
	const hook = renderHook((p) => useChatWindow(p), { initialProps: props });
	return { ...hook, props, loadEarlier, prepareForPage };
}

it("bounds an ongoing conversation and pages both ways with overlap without losing the original history", () => {
	const h = fixture();
	expect(h.result.current.messages).toHaveLength(CHAT_WINDOW_SIZE);
	expect(h.result.current.messages[0]?.id).toBe("m4880");
	act(() => h.result.current.showEarlier());
	expect(h.result.current.messages[0]?.id).toBe("m4780");
	expect(h.result.current.messages.at(-1)?.id).toBe("m4899");
	expect(h.result.current.hasNewer).toBe(true);
	expect(h.loadEarlier).not.toHaveBeenCalled();
	act(() => h.result.current.showNewer());
	expect(h.result.current.messages.at(-1)?.id).toBe("m4999");
	expect(h.props.messages).toHaveLength(5000);
});

it("preserves the reading range during incoming replies and returns to the real latest on demand", () => {
	const h = fixture();
	h.rerender({ ...h.props, following: false });
	const ids = h.result.current.messages.map((message) => message.id);
	h.rerender({ ...h.props, following: false, messages: [...h.props.messages, ...messages(5000, 200)] });
	expect(h.result.current.messages.map((message) => message.id)).toEqual(ids);
	expect(h.result.current.hasNewer).toBe(true);
	act(() => h.result.current.showLatest());
	h.rerender({ ...h.props, messages: [...h.props.messages, ...messages(5000, 200)] });
	expect(h.result.current.messages.at(-1)?.id).toBe("m5199");
	expect(h.result.current.messages).toHaveLength(120);
});

it("loads older server pages only once, keeps overlap, then resets cleanly on a conversation change", () => {
	const h = fixture(messages(100, 100));
	h.rerender({ ...h.props, hasEarlier: true });
	act(() => h.result.current.showEarlier());
	act(() => h.result.current.showEarlier());
	expect(h.loadEarlier).toHaveBeenCalledExactlyOnceWith("m100");
	expect(h.result.current.loadingEarlier).toBe(true);
	h.rerender({ ...h.props, hasEarlier: false, messages: messages(0, 200) });
	expect(h.result.current.messages[0]?.id).toBe("m0");
	expect(h.result.current.messages.at(-1)?.id).toBe("m119");
	expect(h.result.current.loadingEarlier).toBe(false);
	h.rerender({ ...h.props, conversationKey: "b", messages: messages(5000, 200) });
	expect(h.result.current.messages.at(-1)?.id).toBe("m5199");
	expect(h.result.current.hasNewer).toBe(false);
});

it("exposes older/newer actions without replaying working, queued input, or changing the saved messages", async () => {
	const earlier = vi.fn();
	const newer = vi.fn();
	render(
		<MessageList
			messages={messages(0, 120)}
			hasEarlier
			hasNewer
			onShowEarlier={earlier}
			onShowNewer={newer}
		/>,
	);
	expect(screen.getAllByRole("article")).toHaveLength(120);
	await userEvent.click(screen.getByRole("button", { name: "Show earlier" }));
	await userEvent.click(screen.getByRole("button", { name: "Show newer" }));
	expect(earlier).toHaveBeenCalledOnce();
	expect(newer).toHaveBeenCalledOnce();
});
