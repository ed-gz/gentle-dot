import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "./store.ts";

export const CHAT_WINDOW_SIZE = 120;
const OVERLAP = 20;

/** Keep expensive rich messages bounded; browsing never changes the saved conversation. */
export function useChatWindow({
	messages,
	conversationKey,
	following,
	hasEarlier,
	loadEarlier,
	prepareForPage,
}: {
	messages: ChatMessage[];
	conversationKey: string | undefined;
	following: boolean;
	hasEarlier: boolean;
	loadEarlier: (before: string) => void;
	prepareForPage: () => void;
}) {
	const visible = useMemo(
		() => messages.filter((message) => message.text.trim() || message.attachments?.length || message.note),
		[messages],
	);
	const [range, setRange] = useState<{ key: string | undefined; endId: string | undefined }>({
		key: conversationKey,
		endId: undefined,
	});
	const [loadingBefore, setLoadingBefore] = useState<string>();
	const forceLatest = useRef(false);
	const previousWindow = useRef<{ key: string | undefined; endId: string | undefined }>({
		key: conversationKey,
		endId: undefined,
	});
	const storedEnd = range.key === conversationKey ? range.endId : undefined;
	const endId = forceLatest.current
		? undefined
		: (storedEnd ??
			(!following && visible.length > CHAT_WINDOW_SIZE && previousWindow.current.key === conversationKey
				? previousWindow.current.endId
				: undefined));
	const found = endId ? visible.findIndex((message) => message.id === endId) : -1;
	const end = found < 0 ? visible.length : found + 1;
	const start = Math.max(0, end - CHAT_WINDOW_SIZE);
	previousWindow.current = { key: conversationKey, endId: visible[end - 1]?.id };
	// Freeze the loaded range as soon as the reader moves away from the end. Streaming/new replies
	// remain in the store, but cannot remove a selected or currently-read message from the DOM.
	useEffect(() => {
		if (forceLatest.current) {
			if (following) forceLatest.current = false;
			return;
		}
		if (!following && visible.length > CHAT_WINDOW_SIZE && (storedEnd === undefined || found < 0))
			setRange({ key: conversationKey, endId: visible[end - 1]?.id });
		else if (storedEnd !== undefined && found < 0) setRange({ key: conversationKey, endId: undefined });
	}, [following, storedEnd, found, end, visible, conversationKey]);
	useEffect(() => {
		if (range.key !== conversationKey) {
			setRange({ key: conversationKey, endId: undefined });
			setLoadingBefore(undefined);
		}
	}, [conversationKey, range.key]);
	useEffect(() => {
		if (loadingBefore && (messages[0]?.id !== loadingBefore || !hasEarlier)) setLoadingBefore(undefined);
	}, [messages, hasEarlier, loadingBefore]);
	useEffect(() => {
		if (!loadingBefore) return;
		// Failed/disconnected history requests stay retryable without an unbounded spinner.
		const timer = setTimeout(() => setLoadingBefore(undefined), 10_000);
		return () => clearTimeout(timer);
	}, [loadingBefore]);

	return {
		messages: visible.slice(start, end),
		hasEarlier: start > 0 || hasEarlier,
		hasNewer: end < visible.length,
		loadingEarlier: loadingBefore !== undefined,
		showEarlier: () => {
			if (loadingBefore) return;
			prepareForPage();
			setRange({ key: conversationKey, endId: visible[Math.min(end - 1, start + OVERLAP - 1)]?.id });
			if (start === 0 && hasEarlier && messages[0]) {
				setLoadingBefore(messages[0].id);
				loadEarlier(messages[0].id);
			}
		},
		showNewer: () => {
			prepareForPage();
			const nextEnd = Math.min(visible.length, end + CHAT_WINDOW_SIZE - OVERLAP);
			setRange({ key: conversationKey, endId: visible[nextEnd - 1]?.id });
		},
		showLatest: () => {
			forceLatest.current = true;
			setRange({ key: conversationKey, endId: undefined });
		},
	};
}
