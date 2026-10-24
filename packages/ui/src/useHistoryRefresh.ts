import { useEffect, useRef } from "react";
import type { DotState } from "./store.ts";

export type RefreshHistory = (acceptSnapshot: () => boolean) => boolean;
const REFRESH_AT = 400;
const readerBusy = () =>
	!window.getSelection()?.isCollapsed || Boolean(document.querySelector("dialog[open], [role='dialog']"));
const idle = (state: DotState) =>
	state.connection === "open" &&
	state.agentState === "idle" &&
	state.asks.length === 0 &&
	state.queue.steering.length === 0 &&
	state.queue.followUp.length === 0 &&
	!state.messages.some((message) => message.streaming);

/** Release accumulated client history only while idle at the end; the full transcript stays on disk. */
export function useHistoryRefresh(
	state: DotState,
	atLatest: boolean,
	refresh?: RefreshHistory,
	isAtLatest?: () => boolean,
) {
	const threshold = useRef({ key: state.conversationId, count: REFRESH_AT });
	const current = useRef({ state, atLatest, refresh, isAtLatest });
	current.current = { state, atLatest, refresh, isAtLatest };
	const eligible = Boolean(refresh) && state.features.historyRefresh === true && atLatest && idle(state);
	useEffect(() => {
		if (threshold.current.key !== state.conversationId || state.messages.length < REFRESH_AT)
			threshold.current = { key: state.conversationId, count: REFRESH_AT };
		if (!eligible || state.messages.length < threshold.current.count) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const key = state.conversationId;
		const accept = () => {
			const latest = current.current;
			return (
				latest.state.conversationId === key &&
				latest.atLatest &&
				(latest.isAtLatest?.() ?? true) &&
				idle(latest.state) &&
				!readerBusy()
			);
		};
		const schedule = () => {
			clearTimeout(timer);
			if (readerBusy()) return;
			timer = setTimeout(() => {
				const latest = current.current;
				if (!accept() || latest.state.messages.length < threshold.current.count) return;
				// A failed request or server returning the same data never causes a refresh loop.
				threshold.current = { key, count: latest.state.messages.length + REFRESH_AT };
				latest.refresh?.(accept);
			}, 1000);
		};
		schedule();
		document.addEventListener("selectionchange", schedule);
		document.addEventListener("close", schedule, true);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("selectionchange", schedule);
			document.removeEventListener("close", schedule, true);
		};
	}, [eligible, state.conversationId, state.messages.length]);
}
