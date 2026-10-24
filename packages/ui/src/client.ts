import { type ClientMessage, CloseCode, PROTOCOL_VERSION, type ServerMessage } from "@gentle-dot/protocol";
import type { ConnectionStatus } from "./store.ts";

export interface ConnectionInfo {
	url: string;
	token: string;
	webUrl?: string;
}

interface ClientHandlers {
	onStatus: (status: ConnectionStatus) => void;
	onMessage: (message: ServerMessage) => void;
	WebSocketImpl?: typeof WebSocket;
}

const BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 30_000];
const CONNECT_TIMEOUT_MS = 12_000;
const RESUME_STALE_MS = 15_000;
const TOKEN_KEY = "gentle-dot-token";

/** One WebSocket session with the daemon: hello, reconnect with backoff, and history refresh. */
export class DotClient {
	private socket: WebSocket | undefined;
	private ready = false;
	private stopped = true;
	private rejected = false;
	private attempts = 0;
	private lastReceived = 0;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private connectTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly info: ConnectionInfo;
	private readonly handlers: ClientHandlers;

	constructor(info: ConnectionInfo, handlers: ClientHandlers) {
		this.info = info;
		this.handlers = handlers;
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.rejected = false;
		this.attempts = 0;
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		this.clearConnection();
	}

	/** A resumed phone refreshes a possibly half-open socket, never replays a prompt. */
	resume(networkChanged = false): void {
		if (this.stopped || this.rejected) return;
		if (!networkChanged && this.socket && Date.now() - this.lastReceived < RESUME_STALE_MS) return;
		this.clearConnection();
		this.attempts = 0;
		this.connect();
	}

	send(message: ClientMessage): boolean {
		if (!this.ready || !this.socket || this.socket.readyState !== 1) return false;
		try {
			this.socket.send(JSON.stringify(message));
			return true;
		} catch {
			this.retry();
			return false;
		}
	}

	private clearConnection(): void {
		clearTimeout(this.retryTimer);
		clearTimeout(this.connectTimer);
		const old = this.socket;
		this.socket = undefined;
		this.ready = false;
		// Invalidate handlers before closing: queued events from an old host cannot reach the chat.
		old?.close();
	}

	private retry(): void {
		this.clearConnection();
		if (this.stopped || this.rejected) return;
		this.handlers.onStatus("closed");
		const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)] ?? 30_000;
		this.attempts += 1;
		this.retryTimer = setTimeout(() => this.connect(), delay);
	}

	private connect(): void {
		if (this.stopped || this.rejected) return;
		const Impl = this.handlers.WebSocketImpl ?? WebSocket;
		this.ready = false;
		this.handlers.onStatus("connecting");
		let socket: WebSocket;
		try {
			socket = new Impl(this.info.url);
		} catch {
			this.retry();
			return;
		}
		this.socket = socket;
		this.lastReceived = Date.now();
		const current = () => !this.stopped && socket === this.socket;
		this.connectTimer = setTimeout(() => {
			if (current() && !this.ready) this.retry();
		}, CONNECT_TIMEOUT_MS);
		socket.onopen = () => {
			if (!current()) return;
			try {
				socket.send(JSON.stringify({ type: "hello", token: this.info.token, protocol: PROTOCOL_VERSION }));
			} catch {
				this.retry();
			}
		};
		socket.onmessage = (event: MessageEvent) => {
			if (!current()) return;
			let message: ServerMessage;
			try {
				message = JSON.parse(String(event.data)) as ServerMessage;
			} catch {
				return;
			}
			if (!message || typeof message !== "object") return;
			this.lastReceived = Date.now();
			this.handlers.onMessage(message);
			if (message.type === "ready" && !this.ready && current()) {
				clearTimeout(this.connectTimer);
				this.ready = true;
				this.attempts = 0;
				this.handlers.onStatus("open");
				this.send({ type: "get_history" });
				this.send({ type: "list_conversations" });
				this.send({ type: "auth_list" });
			}
		};
		socket.onclose = (event: CloseEvent) => {
			if (!current()) return;
			if (event.code === CloseCode.unauthorized || event.code === CloseCode.badProtocol) {
				this.rejected = true;
				this.clearConnection();
				this.handlers.onStatus(event.code === CloseCode.unauthorized ? "unauthorized" : "closed");
				return;
			}
			this.retry();
		};
	}
}

interface LocationLike {
	hash: string;
	pathname: string;
	search: string;
}

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/**
 * The browser receives the token once in the URL fragment (`#token=…`), keeps it
 * in session storage, and removes it from the address bar.
 */
export function tokenFromLocation(
	location: LocationLike,
	storage: StorageLike,
	replaceUrl: (url: string) => void,
): string | undefined {
	const match = /(?:^#|&)token=([^&]+)/.exec(location.hash);
	if (match?.[1]) {
		const token = decodeURIComponent(match[1]);
		storage.setItem(TOKEN_KEY, token);
		replaceUrl(`${location.pathname}${location.search}`);
		return token;
	}
	return storage.getItem(TOKEN_KEY) ?? undefined;
}
