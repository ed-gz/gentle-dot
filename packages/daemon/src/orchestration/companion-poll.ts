/** Small, demand-driven channel for the focused adapter only. No history or terminal input. */
export interface CompanionPollPeer {
	key: string;
	paneId: string;
	sessionId: string;
}
export class CompanionActivityPoll<T extends CompanionPollPeer> {
	private readonly peer: () => T | undefined;
	private readonly read: (peer: T) => Promise<unknown>;
	private readonly accept: (peer: T, value: unknown) => void;
	private readonly unavailable: (peer: T) => void;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private activeUntil = 0;
	private stopped = false;
	private inFlight = false;
	private blocked = new Map<string, number>();
	constructor(options: {
		peer(): T | undefined;
		read(peer: T): Promise<unknown>;
		accept(peer: T, value: unknown): void;
		unavailable(peer: T): void;
	}) {
		this.peer = options.peer;
		this.read = options.read;
		this.accept = options.accept;
		this.unavailable = options.unavailable;
	}
	touch() {
		if (this.stopped) return;
		this.activeUntil = Date.now() + 2500;
		this.schedule();
	}
	private schedule() {
		if (this.stopped || this.inFlight || this.timer || Date.now() >= this.activeUntil) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.tick();
		}, 500);
		this.timer.unref?.();
	}
	private async tick() {
		if (this.stopped || Date.now() >= this.activeUntil) return;
		const peer = this.peer();
		if (!peer || (this.blocked.get(peer.key) ?? 0) > Date.now()) {
			this.schedule();
			return;
		}
		this.inFlight = true;
		try {
			const value = await this.read(peer);
			if (!this.stopped && Date.now() < this.activeUntil && this.peer()?.key === peer.key)
				this.accept(peer, value);
		} catch (error) {
			const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
			this.blocked.set(
				peer.key,
				Date.now() +
					(["UNSUPPORTED", "UNKNOWN_METHOD", "METHOD_NOT_FOUND", "UNKNOWN_ACTION"].includes(String(code))
						? 60000
						: 5000),
			);
			if (this.blocked.size > 64) this.blocked.delete(this.blocked.keys().next().value as string);
			if (!this.stopped && this.peer()?.key === peer.key) this.unavailable(peer);
		} finally {
			this.inFlight = false;
			this.schedule();
		}
	}
	close() {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.blocked.clear();
	}
}
