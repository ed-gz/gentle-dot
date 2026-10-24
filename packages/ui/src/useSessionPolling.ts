import { useCallback, useEffect, useRef } from "react";
import type { AgentConversation, OrchestrationClient } from "./orchestration.ts";

/** The open conversation is independent of discovery of every other terminal. One read at a time. */
export function useSessionPolling(
	client: OrchestrationClient,
	paneId: string | undefined,
	sessionId: string | undefined,
	enabled: boolean,
	working: boolean,
	onSnapshot: (value: AgentConversation) => void,
	onError: (error: unknown) => void,
) {
	const callbacks = useRef({ onSnapshot, onError, working });
	callbacks.current = { onSnapshot, onError, working };
	const refresh = useRef<() => void>(() => {});
	useEffect(() => {
		if (!enabled || !paneId || !sessionId) return;
		let live = true;
		let pending = false;
		let running = false;
		let failures = 0;
		let controller: AbortController | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const visibleNow = () => document.visibilityState !== "hidden";
		const poll = async () => {
			if (!live || !visibleNow()) return;
			if (running) {
				pending = true;
				return;
			}
			clearTimeout(timer);
			running = true;
			controller = new AbortController();
			try {
				const value = await client.inspect(paneId, sessionId, controller.signal);
				if (live && !controller.signal.aborted) {
					failures = 0;
					callbacks.current.onSnapshot(value);
				}
			} catch (error) {
				if (live && !controller.signal.aborted) {
					failures++;
					callbacks.current.onError(error);
				}
			} finally {
				running = false;
				if (live && visibleNow()) {
					const delay = failures
						? Math.min(15_000, 1_000 * 2 ** Math.min(failures, 4))
						: callbacks.current.working
							? 1_000
							: 4_000;
					timer = setTimeout(() => void poll(), pending ? 0 : delay);
					pending = false;
				}
			}
		};
		refresh.current = () => void poll();
		const visible = () => {
			if (document.visibilityState === "hidden") {
				clearTimeout(timer);
				controller?.abort();
			} else void poll();
		};
		document.addEventListener("visibilitychange", visible);
		void poll();
		return () => {
			live = false;
			refresh.current = () => {};
			clearTimeout(timer);
			controller?.abort();
			document.removeEventListener("visibilitychange", visible);
		};
	}, [client, paneId, sessionId, enabled]);
	return useCallback(() => refresh.current(), []);
}
