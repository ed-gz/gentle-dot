import type { ClientMessage } from "@gentle-dot/protocol";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { type ConnectionInfo, DotClient } from "./client.ts";
import { initialState, reduce } from "./store.ts";
import type { RefreshHistory } from "./useHistoryRefresh.ts";

/** Connects to the daemon once `info` is known and exposes the reduced state. */
export function useDot(info: ConnectionInfo | undefined) {
	const [state, dispatch] = useReducer(reduce, initialState);
	const client = useRef<DotClient | undefined>(undefined);
	const pendingRefresh = useRef<{ id: string; accept: () => boolean } | undefined>(undefined);

	useEffect(() => {
		if (!info) return;
		const c = new DotClient(info, {
			onStatus: (status) => {
				if (status !== "open") pendingRefresh.current = undefined;
				dispatch({ type: "connection", status });
			},
			onMessage: (message) => {
				if (
					["user_message", "message_delta", "message_done", "activity", "ask"].includes(message.type) ||
					(message.type === "agent_state" && message.state !== "idle")
				)
					pendingRefresh.current = undefined;
				if (message.type === "history" && message.requestId) {
					const pending = pendingRefresh.current;
					if (pending?.id !== message.requestId) return;
					pendingRefresh.current = undefined;
					if (!pending.accept()) return;
				} else if (message.type === "history") {
					// Reconnects, switches and rotations are authoritative; invalidate an older refresh.
					pendingRefresh.current = undefined;
				}
				dispatch({ type: "server", message });
			},
		});
		client.current = c;
		c.start();
		const visible = () => {
			if (document.visibilityState === "visible") c.resume();
		};
		const resumed = () => c.resume();
		const online = () => c.resume(true);
		document.addEventListener("visibilitychange", visible);
		window.addEventListener("gentledot-resume", resumed);
		window.addEventListener("online", online);
		return () => {
			c.stop();
			if (client.current === c) client.current = undefined;
			document.removeEventListener("visibilitychange", visible);
			window.removeEventListener("gentledot-resume", resumed);
			window.removeEventListener("online", online);
		};
	}, [info]);

	/** True once the message is handed to an open connection; false (with a notice) otherwise. */
	const send = useCallback((message: ClientMessage): boolean => {
		if (["send", "new_conversation", "open_conversation", "abort"].includes(message.type))
			pendingRefresh.current = undefined;
		if (client.current?.send(message)) return true;
		dispatch({
			type: "server",
			message: {
				type: "error",
				code: "offline",
				message: "Not connected yet. Try again in a moment.",
				seq: 0,
			},
		});
		return false;
	}, []);
	const refreshHistory = useCallback<RefreshHistory>((accept) => {
		const id = crypto.randomUUID();
		pendingRefresh.current = { id, accept };
		if (client.current?.send({ type: "get_history", requestId: id })) return true;
		pendingRefresh.current = undefined;
		return false;
	}, []);
	const dismiss = useCallback((id: number) => dispatch({ type: "dismiss", id }), []);

	return { state, send, dismiss, dispatch, refreshHistory };
}
