import type { ServerMessage } from "@gentle-dot/protocol";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DotClient, tokenFromLocation } from "../src/client.ts";
import type { ConnectionStatus } from "../src/store.ts";
import { useDot } from "../src/useDot.ts";

class FakeSocket {
	static all: FakeSocket[] = [];
	readyState = 0;
	sent: unknown[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	readonly url: string;
	constructor(url: string) {
		this.url = url;
		FakeSocket.all.push(this);
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.readyState = 3;
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	receive(message: { type: ServerMessage["type"]; [key: string]: unknown }) {
		this.onmessage?.({ data: JSON.stringify({ seq: 1, ...message }) });
	}
	drop(code = 1006) {
		this.readyState = 3;
		this.onclose?.({ code });
	}
}

function makeClient() {
	const statuses: ConnectionStatus[] = [];
	const messages: ServerMessage[] = [];
	const client = new DotClient(
		{ url: "ws://127.0.0.1:4317/ws", token: "secret" },
		{
			onStatus: (s) => statuses.push(s),
			onMessage: (m) => messages.push(m),
			WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
		},
	);
	return { client, statuses, messages };
}

beforeEach(() => {
	FakeSocket.all = [];
	vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("DotClient", () => {
	it("says hello with the token, then asks for history, conversations, and accounts once ready", () => {
		const { client, statuses, messages } = makeClient();
		client.start();
		const socket = FakeSocket.all[0];
		socket?.open();
		expect(socket?.sent).toEqual([{ type: "hello", token: "secret", protocol: 1 }]);
		socket?.receive({ type: "ready", agentState: "idle" });
		expect(statuses.at(-1)).toBe("open");
		expect(messages.map((m) => m.type)).toEqual(["ready"]);
		expect(socket?.sent.slice(1)).toEqual([
			{ type: "get_history" },
			{ type: "list_conversations" },
			{ type: "auth_list" },
		]);
	});

	it("reconnects with backoff after a drop", () => {
		const { client, statuses } = makeClient();
		client.start();
		FakeSocket.all[0]?.open();
		FakeSocket.all[0]?.receive({ type: "ready", agentState: "idle" });
		FakeSocket.all[0]?.drop();
		expect(statuses.at(-1)).toBe("closed");
		vi.advanceTimersByTime(499);
		expect(FakeSocket.all).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(FakeSocket.all).toHaveLength(2);
	});

	it("stops retrying when the token is rejected", () => {
		const { client, statuses } = makeClient();
		client.start();
		FakeSocket.all[0]?.open();
		FakeSocket.all[0]?.drop(4401);
		vi.advanceTimersByTime(60_000);
		expect(FakeSocket.all).toHaveLength(1);
		expect(statuses.at(-1)).toBe("unauthorized");
	});

	it("reports whether a message could be sent", () => {
		const { client } = makeClient();
		client.start();
		expect(client.send({ type: "abort" })).toBe(false);
		FakeSocket.all[0]?.open();
		FakeSocket.all[0]?.receive({ type: "ready", agentState: "idle" });
		expect(client.send({ type: "abort" })).toBe(true);
	});

	it("times out a silent handshake and recovers without replaying messages", () => {
		const { client, statuses } = makeClient();
		client.start();
		const first = FakeSocket.all[0];
		first?.open();
		vi.advanceTimersByTime(12_000);
		expect(first?.readyState).toBe(3);
		expect(statuses.at(-1)).toBe("closed");
		expect(client.send({ type: "send", text: "do not replay", requestId: "once" })).toBe(false);
		vi.advanceTimersByTime(500);
		FakeSocket.all[1]?.open();
		FakeSocket.all[1]?.receive({ type: "ready", agentState: "idle" });
		expect(statuses.at(-1)).toBe("open");
		expect(FakeSocket.all[1]?.sent).not.toContainEqual(expect.objectContaining({ type: "send" }));
		client.stop();
	});

	it("ignores late messages and reconnect events after stopping a client", () => {
		const { client, messages, statuses } = makeClient();
		client.start();
		const first = FakeSocket.all[0];
		client.stop();
		first?.open();
		first?.receive({ type: "ready", agentState: "idle" });
		first?.receive({ type: "message_delta", messageId: "old", text: "old host" });
		first?.drop();
		client.resume(true);
		vi.advanceTimersByTime(60_000);
		expect(messages).toEqual([]);
		expect(first?.sent).toEqual([]);
		expect(FakeSocket.all).toHaveLength(1);
		expect(statuses).toEqual(["connecting"]);
	});

	it("refreshes a stale socket on resume, keeping recent connections and prompts intact", () => {
		const { client, messages } = makeClient();
		client.start();
		const first = FakeSocket.all[0];
		first?.open();
		first?.receive({ type: "ready", agentState: "idle" });
		client.send({ type: "send", text: "once", requestId: "once" });
		client.resume();
		expect(FakeSocket.all).toHaveLength(1);
		vi.advanceTimersByTime(15_000);
		client.resume();
		expect(FakeSocket.all).toHaveLength(2);
		first?.receive({ type: "message_delta", messageId: "old", text: "late" });
		expect(messages.map((message) => message.type)).toEqual(["ready"]);
		FakeSocket.all[1]?.open();
		FakeSocket.all[1]?.receive({ type: "ready", agentState: "idle" });
		expect(FakeSocket.all[1]?.sent).not.toContainEqual(expect.objectContaining({ type: "send" }));
		client.stop();
	});

	it("backs off to thirty seconds offline and retries immediately when the network returns", () => {
		const { client } = makeClient();
		client.start();
		for (const delay of [500, 1000, 2000, 5000, 10_000, 30_000]) {
			const previous = FakeSocket.all.length;
			FakeSocket.all.at(-1)?.drop();
			vi.advanceTimersByTime(delay - 1);
			expect(FakeSocket.all).toHaveLength(previous);
			vi.advanceTimersByTime(1);
			expect(FakeSocket.all).toHaveLength(previous + 1);
		}
		FakeSocket.all.at(-1)?.drop();
		client.resume(true);
		expect(FakeSocket.all).toHaveLength(8);
		client.stop();
	});

	it("does not retry a rejected or incompatible connection when coming back online", () => {
		for (const code of [4401, 4400]) {
			const { client } = makeClient();
			client.start();
			FakeSocket.all.at(-1)?.drop(code);
			const previous = FakeSocket.all.length;
			client.resume(true);
			vi.advanceTimersByTime(60_000);
			expect(FakeSocket.all).toHaveLength(previous);
			client.stop();
		}
	});

	it("reports send failure without throwing or replaying a possibly interrupted request", () => {
		const { client, statuses } = makeClient();
		client.start();
		const first = FakeSocket.all[0];
		first?.open();
		first?.receive({ type: "ready", agentState: "idle" });
		if (!first) throw new Error("Expected connected socket");
		first.send = () => {
			throw new Error("Network unavailable");
		};
		expect(client.send({ type: "abort" })).toBe(false);
		expect(statuses.at(-1)).toBe("closed");
		client.stop();
	});
});

describe("tokenFromLocation", () => {
	it("reads the token from the fragment, stores it, and removes it from the address", () => {
		const storage = new Map<string, string>();
		const replace = vi.fn();
		const token = tokenFromLocation(
			{ hash: "#token=abc", pathname: "/", search: "" },
			{ getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
			replace,
		);
		expect(token).toBe("abc");
		expect(storage.get("gentle-dot-token")).toBe("abc");
		expect(replace).toHaveBeenCalledWith("/");
		const again = tokenFromLocation(
			{ hash: "", pathname: "/", search: "" },
			{ getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
			replace,
		);
		expect(again).toBe("abc");
	});
});

describe("useDot.send", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("reports whether the message was handed to an open connection", () => {
		vi.stubGlobal("WebSocket", FakeSocket);
		const info = { url: "ws://127.0.0.1:4317/ws", token: "secret" };
		const { result } = renderHook(() => useDot(info));
		const message = { type: "send", text: "hi", requestId: "r1" } as const;

		let handed: boolean | undefined;
		act(() => {
			handed = result.current.send(message);
		});
		expect(handed).toBe(false);
		expect(result.current.state.notices.at(-1)?.message).toBe("Not connected yet. Try again in a moment.");

		const socket = FakeSocket.all[0];
		act(() => {
			socket?.open();
			socket?.receive({ type: "ready", agentState: "idle" });
		});
		act(() => {
			handed = result.current.send(message);
		});
		expect(handed).toBe(true);
		expect(socket?.sent.at(-1)).toEqual(message);
	});

	it("recovers on phone resume and removes the old client on unmount", () => {
		vi.stubGlobal("WebSocket", FakeSocket);
		const info = { url: "ws://127.0.0.1:4317/ws", token: "secret" };
		const { unmount } = renderHook(() => useDot(info));
		act(() => {
			FakeSocket.all[0]?.open();
			FakeSocket.all[0]?.receive({ type: "ready", agentState: "idle" });
			vi.advanceTimersByTime(15_000);
			window.dispatchEvent(new Event("gentledot-resume"));
		});
		expect(FakeSocket.all).toHaveLength(2);
		unmount();
		window.dispatchEvent(new Event("online"));
		expect(FakeSocket.all).toHaveLength(2);
	});
});

describe("background history responses", () => {
	afterEach(() => vi.unstubAllGlobals());
	function fixture() {
		vi.stubGlobal("WebSocket", FakeSocket);
		const info = { url: "ws://127.0.0.1:4317/ws", token: "fixture" };
		const hook = renderHook(() => useDot(info));
		const socket = FakeSocket.all[0];
		if (!socket) throw new Error("Expected fixture connection");
		act(() => {
			socket.open();
			socket.receive({ type: "ready", agentState: "idle" });
			socket.receive({
				type: "history",
				conversationId: "first",
				messages: [{ id: "original", role: "user", text: "Original", activities: [] }],
			});
		});
		return { ...hook, socket };
	}
	it("discards a delayed refresh after reading starts while accepting a still-safe refresh", () => {
		const f = fixture();
		let reading = false;
		act(() => {
			f.result.current.refreshHistory(() => !reading);
		});
		const request = f.socket.sent.at(-1) as { requestId: string };
		reading = true;
		act(() => f.socket.receive({ type: "history", requestId: request.requestId, messages: [] }));
		expect(f.result.current.state.messages[0]?.id).toBe("original");
		reading = false;
		act(() => {
			f.result.current.refreshHistory(() => !reading);
		});
		const next = f.socket.sent.at(-1) as { requestId: string };
		act(() => f.socket.receive({ type: "history", requestId: next.requestId, messages: [] }));
		expect(f.result.current.state.messages).toEqual([]);
	});
	it.each(["user_message", "rotation", "send"])("invalidates an in-flight refresh on %s", (change) => {
		const f = fixture();
		act(() => {
			f.result.current.refreshHistory(() => true);
		});
		const request = f.socket.sent.at(-1) as { requestId: string };
		act(() => {
			if (change === "rotation")
				f.socket.receive({
					type: "history",
					conversationId: "next",
					messages: [{ id: "rotated", role: "user", text: "Rotated", activities: [] }],
				});
			else if (change === "send")
				f.result.current.send({ type: "send", text: "New instruction", requestId: "new" });
			else f.socket.receive({ type: "user_message", messageId: "new", text: "New instruction" });
			f.socket.receive({ type: "history", requestId: request.requestId, messages: [] });
		});
		expect(f.result.current.state.messages.length).toBeGreaterThan(0);
		if (change === "rotation") expect(f.result.current.state.conversationId).toBe("next");
		if (change === "user_message") expect(f.result.current.state.messages.at(-1)?.id).toBe("new");
	});
});
