import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

export type Presence = "active" | "inactive" | "unknown";
export interface PresenceSummary {
	id: string;
	summaries: string[];
	events: string[];
	dropped: number;
}
const WINDOW_MS = 90_000;
const MAX_DELAY_MS = 5 * 60_000;
const BATCHABLE = new Set(["dotReply", "dotError", "agentCompleted", "agentAvailable", "agentError"]);
type Phone = {
	enabled: boolean;
	items: { summary: string; event: string }[];
	dropped: number;
	started?: number;
	seen: Map<string, boolean>;
	released?: PresenceSummary;
};

/** Unexpected/failed logind output is never evidence of activity. */
export function parseIdleHint(value: string): boolean | undefined {
	const match = /^IdleHint=(yes|no)$/.exec(value.trim());
	return match ? match[1] === "yes" : undefined;
}

export function readIdleHint(): Promise<boolean | undefined> {
	if (process.platform !== "linux" || !process.getuid) return Promise.resolve(undefined);
	const uid = String(process.getuid());
	return new Promise((resolve) =>
		execFile("loginctl", ["show-user", uid, "--property=IdleHint"], { timeout: 2000, maxBuffer: 4096 },
			(error, stdout) => resolve(error ? undefined : parseIdleHint(stdout))),
	);
}

/** Daemon-owned delivery policy. Never stores input text, only bounded notification copy. */
export class MobilePresence {
	private current: Presence = "unknown";
	private candidate: Presence = "unknown";
	private candidateAt = 0;
	private sampledAt = -Infinity;
	private humanAt?: number;
	private humanSignal = false;
	private readonly phones = new Map<string, Phone>();

	private now: () => number;
	private readonly onRelease?: (key: string, summary: PresenceSummary) => void;

	constructor(now: () => number = Date.now, onRelease?: (key: string, summary: PresenceSummary) => void) {
		this.now = now;
		this.onRelease = onRelease;
	}

	sample(idle: boolean | undefined, humanAt?: number, humanSignal = false): void {
		const now = this.now();
		this.sampledAt = now;
		this.humanAt = humanAt;
		this.humanSignal = humanSignal;
		let next: Presence = "unknown";
		if (idle === true) next = "inactive";
		else if (idle === false) {
			if (!humanSignal) next = "active"; // No editor input feed: logind-only fallback.
			else if (humanAt !== undefined && Number.isFinite(humanAt) && humanAt <= now + 1000)
				next = now - humanAt <= WINDOW_MS ? "active" : "inactive";
		}
		if (next !== this.candidate) {
			this.candidate = next;
			this.candidateAt = now;
		}
		// Missing evidence fails open immediately; known flips must survive two samples.
		if (next === "unknown" || now - this.candidateAt >= 2000) this.current = next;
		this.tick();
	}

	state(): Presence {
		if (this.now() - this.sampledAt > 30_000) return "unknown";
		if (this.current === "active" && this.humanSignal && this.humanAt !== undefined && this.now() - this.humanAt > WINDOW_MS)
			return "inactive";
		return this.current;
	}

	configure(key: string, enabled?: boolean): void {
		let phone = this.phones.get(key);
		if (!phone) {
			// Pairing limits devices to 20; also bound this cache across revocations.
			if (this.phones.size >= 32) this.phones.delete(this.phones.keys().next().value!);
			phone = { enabled: enabled ?? true, items: [], dropped: 0, seen: new Map() };
			this.phones.set(key, phone);
		}
		// Browser connections have no native preference header; do not overwrite a saved opt-out.
		if (enabled !== undefined) phone.enabled = enabled;
		if (!phone.enabled) this.release(key, phone);
	}

	hold(key: string, id: string, event: string, summary: string): boolean {
		const phone = this.phones.get(key);
		// Only a closed set of non-actionable events is eligible. Unknown events also fail open.
		if (!phone || !BATCHABLE.has(event)) return false;
		this.tick();
		if (phone.seen.has(id)) return phone.seen.get(id)!;
		const held = this.muted(key);
		phone.seen.set(id, held);
		if (phone.seen.size > 512) phone.seen.delete(phone.seen.keys().next().value!);
		if (!held) return false;
		phone.started ??= this.now();
		phone.items.push({ summary: summary.slice(0, 240), event });
		if (phone.items.length > 8) {
			phone.items.shift();
			phone.dropped++;
		}
		return true;
	}

	muted(key: string): boolean {
		return this.phones.get(key)?.enabled === true && this.state() === "active";
	}
	keys(): IterableIterator<string> { return this.phones.keys(); }
	forget(key: string): void { this.phones.delete(key); }
	suppressed(key: string, id: string): boolean { return this.phones.get(key)?.seen.get(id) === true; }
	summary(key: string): PresenceSummary | undefined {
		this.tick();
		return this.phones.get(key)?.released;
	}
	tick(): void {
		for (const [key, phone] of this.phones)
			if (phone.started !== undefined && (this.state() !== "active" || this.now() - phone.started >= MAX_DELAY_MS))
				this.release(key, phone);
	}
	private release(key: string, phone: Phone): void {
		if (!phone.items.length) return;
		const batch: PresenceSummary = {
			id: `presence:${randomUUID()}`,
			summaries: phone.items.map((item) => item.summary),
			events: phone.items.map((item) => item.event),
			dropped: phone.dropped,
		};
		phone.released = batch;
		phone.items = [];
		phone.dropped = 0;
		phone.started = undefined;
		this.onRelease?.(key, batch);
	}
}
