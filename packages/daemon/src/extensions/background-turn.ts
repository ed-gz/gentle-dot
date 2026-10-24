import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Reservation = {
	manager: SharedManager;
	sessionId: string;
	phase: "claiming" | "queued" | "running";
};
const slot = Symbol.for("gentle-dot.background-turn.v1");
type SharedManager = object & { [slot]?: Reservation };

// Pi creates contexts for each event, but keeps one sessionManager per engine.
// Reserving before the HTTP claim closes the idle/claim/sendMessage gap across
// extensions. Pi loads each extension with its own module cache, so the slot
// lives on that shared manager, not in module-local state. It is nonenumerable.
// Human input never acquires this reservation or waits for it.

export class BackgroundTurn {
	private reservation: Reservation | undefined;

	acquire(context: ExtensionContext): boolean {
		const manager = context.sessionManager as SharedManager;
		const sessionId = context.sessionManager.getSessionId();
		const existing = manager[slot];
		if (existing && existing.sessionId === sessionId) return existing === this.reservation;
		this.release();
		this.reservation = { manager, sessionId, phase: "claiming" };
		Object.defineProperty(manager, slot, { value: this.reservation, configurable: true });
		return true;
	}

	queued(): void {
		if (this.reservation) this.reservation.phase = "queued";
	}

	started(): void {
		if (this.reservation) this.reservation.phase = "running";
	}

	get awaitingStart(): boolean {
		return this.reservation?.phase === "queued";
	}

	/** Capture the exact reservation before awaiting an ACK; never release a later turn. */
	releaseWhenDone(): () => void {
		const reservation = this.reservation;
		return () => {
			if (this.reservation === reservation) this.release();
		};
	}

	release(): void {
		const reservation = this.reservation;
		if (reservation && reservation.manager[slot] === reservation) delete reservation.manager[slot];
		this.reservation = undefined;
	}
}
