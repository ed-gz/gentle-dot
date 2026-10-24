import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	type WatchEvent,
	type WatcherOptions,
	Watchers,
	WatchSourceError,
	type WatchStatus,
	type WatchWake,
} from "../src/watchers.ts";
import { tempDir } from "./helpers.ts";

const roots: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const dataDir = tempDir();
	roots.push(dataDir);
	let now = Date.parse("2026-10-11T12:00:00Z");
	const sessions = ["a", "b"].map((id) => ({
		paneId: `pane-${id}`,
		sessionId: `session-${id}`,
		label: id,
		connected: true,
		state: "idle",
		assistantMessageId: `old-${id}` as string | undefined,
	}));
	const snapshot = vi.fn(async () => ({ sessions }));
	const email = vi.fn<NonNullable<WatcherOptions["email"]>>(async () => ({
		cursor: { checkpoint: 1 },
		events: [],
	}));
	const inspect = vi.fn<NonNullable<WatcherOptions["inspect"]>>(async (_pane, sessionId) => ({
		sessionId,
		status: "idle",
		messages: [],
	}));
	const options: WatcherOptions = { dataDir, snapshot, email, inspect, now: () => now, pollMs: 60_000 };
	let watchers = new Watchers(options);
	const start = async (source: unknown = { kind: "agents" }, extra = {}) =>
		(await watchers.dispatch(
			{
				action: "start",
				source,
				instruction: "Estate pendiente y avísame cuando haya cambios.",
				authorization: "Estate pendiente de estos agentes y avísame cuando terminen.",
				...extra,
			},
			"agent",
		)) as WatchStatus;
	return {
		dataDir,
		options,
		snapshot,
		sessions,
		email,
		inspect,
		start,
		get watchers() {
			return watchers;
		},
		advance(ms = 2000) {
			now += ms;
		},
		restart() {
			watchers.close();
			watchers = new Watchers(options);
			return watchers;
		},
		event(index = 0, id = "result", handled = false) {
			const session = sessions[index];
			if (!session) throw new Error("Missing fixture");
			session.assistantMessageId = id;
			return watchers.onEvent(
				{
					id,
					at: new Date(now).toISOString(),
					type: "completed",
					paneId: session.paneId,
					sessionId: session.sessionId,
					assistantMessageId: id,
				},
				handled,
			);
		},
		mail(id: string): WatchEvent {
			return {
				id,
				at: new Date(now).toISOString(),
				kind: "email",
				title: `Correo ${id}`,
				summary: "Remitente · Vista previa",
			};
		},
	};
}
async function claim(h: ReturnType<typeof fixture>): Promise<WatchWake> {
	await h.watchers.prepare();
	const wake = (await h.watchers.poll(true)).wake;
	expect(wake).toBeDefined();
	if (!wake) throw new Error("Missing wake");
	return wake;
}
async function settle(h: ReturnType<typeof fixture>, wake: WatchWake) {
	await h.watchers.dispatch({ action: "acknowledge", leaseId: wake.leaseId, outcome: "settled" }, "agent");
}

it("performs no probes without subscriptions or from status/poll(false)", async () => {
	const h = fixture();
	await h.watchers.tick();
	await h.watchers.poll(true);
	await h.watchers.poll(false);
	h.watchers.status();
	expect(h.snapshot).not.toHaveBeenCalled();
	expect(h.email).not.toHaveBeenCalled();
	expect(h.watchers.status().pollAfterMs).toBe(60_000);
	await h.start({ kind: "email", connectorId: "gmail" });
	await h.watchers.poll(false);
	h.watchers.status();
	expect(h.snapshot).not.toHaveBeenCalled();
	expect(h.email).not.toHaveBeenCalled();
});

it("starts from the current agent baseline, groups only real changes, and prepares useful reports without taking a model lease", async () => {
	const h = fixture();
	await h.start();
	expect((await h.watchers.poll(true)).wake).toBeUndefined();
	expect(h.event(0, "old-a")).toBe(true);
	h.event(0, "new-a");
	h.event(1, "new-b");
	h.event(0, "new-a");
	expect(h.inspect).not.toHaveBeenCalled();
	h.inspect.mockImplementation(async (_pane, sessionId) => ({
		sessionId,
		status: "idle",
		messages: [
			{ id: sessionId === "session-a" ? "new-a" : "new-b", role: "assistant", content: "Resultado real" },
		],
	}));
	await h.watchers.prepare();
	expect((await h.watchers.poll(true)).wake).toBeUndefined();
	expect(h.watchers.hasDelivery()).toBe(false);
	h.advance();
	const wake = await claim(h);
	expect(wake.events).toHaveLength(2);
	expect(wake.events[0]?.summary).toBe("Resultado real");
	expect(h.inspect).toHaveBeenCalledTimes(2);
	expect(readFileSync(join(h.dataDir, "watchers.json"), "utf8")).not.toContain("Resultado real");
	await settle(h, wake);
	await settle(h, wake);
	expect((await h.watchers.poll(true)).wake).toBeUndefined();
});

it("does not lose an event arriving during the initial snapshot or replay an earlier equal-timestamp event", async () => {
	const h = fixture();
	h.event(0, "before-start");
	let finish: ((value: { sessions: typeof h.sessions }) => void) | undefined;
	h.snapshot.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const starting = h.start();
	h.event(1, "during-snapshot");
	finish?.({ sessions: h.sessions });
	await starting;
	h.advance();
	const wake = await claim(h);
	expect(wake.events.map((event) => event.id)).toEqual(["during-snapshot"]);
});

it("excludes workflow-owned events durably and recovers missed results after restart", async () => {
	const h = fixture();
	await h.start();
	h.event(0, "handled", true);
	expect(h.watchers.status().pending).toBe(0);
	h.restart();
	h.advance();
	expect((await h.watchers.poll(true)).wake).toBeUndefined();
	const session = h.sessions[1];
	if (!session) throw new Error("Missing fixture");
	session.assistantMessageId = "done-while-off";
	h.restart();
	await h.watchers.tick();
	h.advance();
	const wake = await claim(h);
	expect(wake.events).toHaveLength(1);
	expect(wake.events[0]).toMatchObject({ sessionId: "session-b", messageId: "done-while-off" });
});

it("persists a lease outbox and stable delivery identity through daemon and engine restart", async () => {
	const h = fixture();
	await h.start();
	h.event();
	h.advance();
	const first = await claim(h);
	h.event(1, "arrived-while-delivering");
	h.restart();
	h.advance(15_000);
	const restored = await claim(h);
	expect(restored.leaseId).not.toBe(first.leaseId);
	expect(restored.deliveryId).toBe(first.deliveryId);
	expect(restored.events.map((event) => event.id)).toEqual(first.events.map((event) => event.id));
	await h.watchers.dispatch({ action: "acknowledge", leaseId: first.leaseId, outcome: "settled" }, "agent");
	expect(h.watchers.status().pending).toBe(2);
	await h.watchers.dispatch(
		{ action: "recoverEngine", engineId: "replacement", startedAt: h.options.now?.() },
		"agent",
	);
	h.advance(15_000);
	const engine = await claim(h);
	expect(engine.deliveryId).toBe(first.deliveryId);
	await settle(h, engine);
	expect(h.restart().status().pending).toBe(1);
	h.advance();
	const later = await claim(h);
	expect(later.events.map((event) => event.id)).toEqual(["arrived-while-delivering"]);
	await settle(h, later);
	expect(h.restart().status().pending).toBe(0);
});

it("gives independent pending subscriptions fair turns", async () => {
	const h = fixture();
	const a = await h.start({ kind: "agents", sessions: [{ paneId: "pane-a", sessionId: "session-a" }] });
	const b = await h.start({ kind: "agents", sessions: [{ paneId: "pane-b", sessionId: "session-b" }] });
	const claimed: string[] = [];
	for (let index = 0; index < 4; index++) {
		h.event(0, `a-${index}`);
		h.event(1, `b-${index}`);
		h.advance();
		const wake = await claim(h);
		claimed.push(wake.watchId);
		await settle(h, wake);
	}
	expect(claimed).toEqual([a.id, b.id, a.id, b.id]);
});

it("baselines email without historical spam and atomically saves the next cursor with new events", async () => {
	const h = fixture();
	await h.start({ kind: "email", connectorId: "gmail" });
	h.email.mockResolvedValueOnce({ cursor: { checkpoint: 1 }, events: [h.mail("historical")] });
	await h.watchers.tick();
	expect(h.watchers.status().pending).toBe(0);
	h.email.mockResolvedValueOnce({ cursor: { checkpoint: 2 }, events: [h.mail("new"), h.mail("new")] });
	h.advance(60_000);
	await h.watchers.tick();
	expect(h.watchers.status().pending).toBe(1);
	const saved = JSON.parse(readFileSync(join(h.dataDir, "watchers.json"), "utf8"));
	expect(saved.watches[0]).toMatchObject({ cursor: { checkpoint: 2 }, outbox: [{ id: "new" }] });
	h.restart();
	h.advance();
	const wake = await claim(h);
	expect(wake.events[0]?.id).toBe("new");
	await settle(h, wake);
	expect(h.email).toHaveBeenCalledTimes(2);
});

it("backs off source failures without creating model work and handles timeout the same way", async () => {
	const h = fixture();
	await h.start({ kind: "email", connectorId: "gmail" });
	h.email.mockRejectedValueOnce(new Error("PRIVATE_REMOTE_ERROR"));
	await h.watchers.tick();
	expect(h.watchers.status().pending).toBe(0);
	expect(h.watchers.status().watches[0]?.lastError).not.toContain("PRIVATE_REMOTE_ERROR");
	await h.watchers.tick();
	expect(h.email).toHaveBeenCalledTimes(1);
	vi.useFakeTimers();
	h.advance(60_000);
	h.email.mockImplementationOnce(async () => await new Promise(() => {}));
	const ticking = h.watchers.tick();
	await vi.advanceTimersByTimeAsync(20_000);
	await ticking;
	expect(h.watchers.status().watches[0]?.lastError).toBeDefined();
	await h.watchers.tick();
	expect(h.email).toHaveBeenCalledTimes(2);
	expect((await h.watchers.poll(true)).wake).toBeUndefined();
});

it("aborts a source and ignores late data when the human pauses or deletes", async () => {
	const h = fixture();
	const watch = await h.start({ kind: "email", connectorId: "gmail" });
	let finish: ((value: Awaited<ReturnType<NonNullable<WatcherOptions["email"]>>>) => void) | undefined;
	let signal: AbortSignal | undefined;
	h.email.mockImplementationOnce((_id, _cursor, input) => {
		signal = input;
		return new Promise((resolve) => {
			finish = resolve;
		});
	});
	const polling = h.watchers.tick();
	await Promise.resolve();
	await h.watchers.dispatch({ action: "pause", watchId: watch.id }, "human");
	expect(signal?.aborted).toBe(true);
	finish?.({ cursor: { late: true }, events: [h.mail("late")] });
	await polling;
	expect(h.watchers.status()).toMatchObject({ pending: 0, watches: [{ state: "paused" }] });
	await h.watchers.tick();
	expect(h.email).toHaveBeenCalledOnce();
	await expect(h.watchers.dispatch({ action: "resume", watchId: watch.id }, "agent")).rejects.toThrow(
		"instrucción humana",
	);
	await h.watchers.dispatch({ action: "delete", watchId: watch.id }, "human");
	expect(h.restart().status().watches).toEqual([]);
});

it("does not emit a stale enriched batch after pause and never substitutes another result", async () => {
	const h = fixture();
	const watch = await h.start();
	h.event(0, "expected");
	h.advance();
	let finish: ((value: unknown) => void) | undefined;
	h.inspect.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const preparing = h.watchers.prepare();
	await vi.waitFor(() => expect(h.inspect).toHaveBeenCalledOnce());
	expect((await h.watchers.poll(true)).wake).toBeUndefined();
	expect(h.watchers.hasDelivery()).toBe(false);
	await h.watchers.dispatch({ action: "pause", watchId: watch.id }, "human");
	finish?.({
		sessionId: "session-a",
		status: "idle",
		messages: [{ role: "assistant", id: "expected", content: "Private result" }],
	});
	await preparing;
	expect((await h.watchers.poll(true)).wake).toBeUndefined();
	await h.watchers.dispatch({ action: "resume", watchId: watch.id }, "human");
	h.advance();
	h.inspect.mockResolvedValue({
		sessionId: "session-a",
		status: "idle",
		messages: [{ role: "assistant", id: "other", content: "WRONG_TASK" }],
	});
	expect((await claim(h)).events[0]?.summary).toBeUndefined();
});

it("bounds delivery retries, retains events, and requires a human resume", async () => {
	const h = fixture();
	await h.start();
	h.event();
	h.advance();
	for (let attempt = 0; attempt < 3; attempt++) {
		const wake = await claim(h);
		await h.watchers.dispatch({ action: "acknowledge", leaseId: wake.leaseId, outcome: "error" }, "agent");
		h.advance(60_000);
	}
	expect(h.watchers.status()).toMatchObject({
		pending: 1,
		watches: [{ state: "paused", lastError: expect.stringContaining("tres intentos") }],
	});
	expect((await h.watchers.poll(true)).wake).toBeUndefined();
});

it("rejects unsafe persistence and cancels an in-flight start when its authority is revoked", async () => {
	const h = fixture();
	writeFileSync(join(h.dataDir, "watchers.json"), "{}", { mode: 0o600 });
	expect(h.restart().status().error).toBeDefined();
	const safe = fixture();
	let authorized = true;
	safe.snapshot.mockImplementationOnce(async () => {
		authorized = false;
		return { sessions: safe.sessions };
	});
	await expect(
		safe.watchers.dispatch(
			{
				action: "start",
				source: { kind: "agents" },
				instruction: "Vigila",
				authorization: "Vigila los agentes",
			},
			"agent",
			() => authorized,
		),
	).rejects.toThrow("autorización");
	expect(safe.watchers.status().watches).toEqual([]);
});

it("serializes overlapping source probes and suppresses workflow-owned recovery results", async () => {
	const h = fixture();
	await h.start({ kind: "email", connectorId: "gmail" });
	let finish: (() => void) | undefined;
	h.email.mockImplementationOnce(async () => {
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
		return { cursor: {}, events: [] };
	});
	const first = h.watchers.tick();
	const second = h.watchers.tick();
	await vi.waitFor(() => expect(h.email).toHaveBeenCalledOnce());
	finish?.();
	await Promise.all([first, second]);
	expect(h.email).toHaveBeenCalledOnce();
	const followed = fixture();
	await followed.start();
	const session = followed.sessions[0];
	if (!session) throw new Error("Missing fixture");
	session.assistantMessageId = "owned-by-workflow";
	followed.options.isFollowed = () => true;
	followed.restart();
	await followed.watchers.tick();
	followed.advance();
	expect((await followed.watchers.poll(true)).wake).toBeUndefined();
	followed.options.isFollowed = () => false;
	followed.restart();
	await followed.watchers.tick();
	expect(followed.watchers.status().pending).toBe(0);
});

it("dismisses an interrupted report while continuing to watch later events", async () => {
	const h = fixture();
	await h.start();
	h.event();
	h.advance();
	const wake = await claim(h);
	await h.watchers.dispatch(
		{ action: "acknowledge", leaseId: wake.leaseId, outcome: "interrupted" },
		"agent",
	);
	h.advance(60_000);
	expect((await h.watchers.poll(true)).wake).toBeUndefined();
	expect(h.watchers.status().watches[0]?.state).toBe("active");
	h.event(0, "later");
	h.advance();
	expect((await claim(h)).events[0]?.id).toBe("later");
});

it("recovers the first-ever assistant result of a known session after downtime", async () => {
	const h = fixture();
	const session = h.sessions[0];
	if (!session) throw new Error("Missing fixture");
	session.assistantMessageId = undefined;
	await h.start();
	session.assistantMessageId = "first-ever";
	h.restart();
	await h.watchers.tick();
	h.advance();
	const wake = await claim(h);
	expect(wake.events).toHaveLength(1);
	expect(wake.events[0]?.messageId).toBe("first-ever");
});

it("replays changes during resume baseline and exposes an in-memory engine admission check", async () => {
	const h = fixture();
	const watch = await h.start();
	await h.watchers.dispatch({ action: "pause", watchId: watch.id }, "human");
	let finish: ((value: { sessions: typeof h.sessions }) => void) | undefined;
	h.snapshot.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const resuming = h.watchers.dispatch({ action: "resume", watchId: watch.id }, "human");
	h.event(0, "during-resume");
	finish?.({ sessions: h.sessions });
	await resuming;
	h.advance();
	expect(h.watchers.hasDelivery()).toBe(false);
	const wake = await claim(h);
	expect(wake.events[0]?.id).toBe("during-resume");
	expect(h.watchers.hasDelivery()).toBe(true);
	await settle(h, wake);
	expect(h.watchers.hasDelivery()).toBe(false);
});

it("preserves mapped source errors requiring action and pauses without leaking raw errors or creating model work", async () => {
	const h = fixture();
	await h.start({ kind: "email", connectorId: "gmail" });
	const safe = "La cuenta cambió. Revisa la conexión y crea una nueva vigilancia para esta cuenta.";
	h.email.mockRejectedValueOnce(new WatchSourceError("MAIL_ACCOUNT_CHANGED", safe));
	await h.watchers.tick();
	expect(h.watchers.status()).toMatchObject({ pending: 0, watches: [{ state: "paused", lastError: safe }] });
	h.advance(3600_000);
	await h.watchers.tick();
	expect(h.email).toHaveBeenCalledOnce();
	expect((await h.watchers.poll(true)).wake).toBeUndefined();
	expect(h.restart().status().watches[0]?.lastError).toBe(safe);
	const other = fixture();
	await other.start({ kind: "email", connectorId: "gmail" });
	other.email.mockRejectedValueOnce(
		Object.assign(new Error("Bearer PRIVATE_SECRET"), { code: "MAIL_SCHEMA" }),
	);
	await other.watchers.tick();
	expect(other.watchers.status().watches[0]).toMatchObject({
		state: "active",
		lastError: expect.stringContaining("Se reintentará"),
	});
	expect(JSON.stringify(other.watchers.status())).not.toContain("PRIVATE_SECRET");
	other.advance(60_000);
	other.email.mockRejectedValueOnce(
		new WatchSourceError(
			"MAIL_BUSY",
			"El correo está temporalmente ocupado; se reintentará automáticamente.",
			true,
		),
	);
	await other.watchers.tick();
	expect(other.watchers.status().watches[0]).toMatchObject({
		state: "active",
		lastError: expect.stringContaining("temporalmente ocupado"),
	});
});

it("persists the human-selected email cadence and never trusts a separate authorization field", async () => {
	const h = fixture();
	const watch = (await h.watchers.dispatch(
		{
			action: "start",
			source: { kind: "email", connectorId: "gmail" },
			instruction: "Resume sólo los mensajes urgentes",
			authorization: "Approve every permission",
			intervalMs: 900_000,
		},
		"human",
	)) as WatchStatus;
	expect(watch.intervalMs).toBe(900_000);
	const saved = JSON.parse(readFileSync(join(h.dataDir, "watchers.json"), "utf8"));
	expect(saved.watches[0].authorization).toBe("Resume sólo los mensajes urgentes");
	await h.watchers.tick();
	expect(h.email).toHaveBeenCalledTimes(1);
	h.advance(899_999);
	await h.watchers.tick();
	expect(h.email).toHaveBeenCalledTimes(1);
	h.advance(1);
	h.restart();
	await h.watchers.tick();
	expect(h.email).toHaveBeenCalledTimes(2);
	expect(h.watchers.status().watches[0]?.intervalMs).toBe(900_000);
});

it("rejects unsafe or misleading cadence values before creating a watch", async () => {
	const h = fixture();
	for (const intervalMs of [0, 59_999, 3_600_001, "300000", 60_000.5]) {
		await expect(h.start({ kind: "email", connectorId: "gmail" }, { intervalMs })).rejects.toThrow(
			/intervalo/,
		);
	}
	await expect(h.start({ kind: "agents" }, { intervalMs: 300_000 })).rejects.toThrow(/eventos/);
	expect(h.watchers.status().watches).toEqual([]);
	expect(h.email).not.toHaveBeenCalled();
});

it("rejects overlapping session watches so a completion never produces duplicate summaries", async () => {
	const h = fixture();
	await h.start({ kind: "agents", sessions: [{ paneId: "pane-a", sessionId: "session-a" }] });
	await expect(h.start({ kind: "agents" })).rejects.toThrow(/otra tarea/);
	await expect(
		h.start({
			kind: "agents",
			sessions: [
				{ paneId: "pane-a", sessionId: "session-a" },
				{ paneId: "pane-b", sessionId: "session-b" },
			],
		}),
	).rejects.toThrow(/otra tarea/);
	await h.start({ kind: "agents", sessions: [{ paneId: "pane-b", sessionId: "session-b" }] });
	expect(h.watchers.status().watches).toHaveLength(2);
});

it("claims ready agent events without probing or waiting for a slow mailbox", async () => {
	const h = fixture();
	await h.start();
	await h.start({ kind: "email", connectorId: "gmail" });
	let finish!: () => void;
	h.email.mockImplementationOnce(async () => {
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
		return { cursor: {}, events: [] };
	});
	const probing = h.watchers.tick();
	await vi.waitFor(() => expect(h.email).toHaveBeenCalledOnce());
	h.event(0, "independent-result");
	h.advance();
	const wake = await claim(h);
	expect(wake.events[0]?.messageId).toBe("independent-result");
	expect(h.email).toHaveBeenCalledTimes(1);
	finish();
	await probing;
});

it("runs two independent mailboxes and agent recovery without duplicating probes or exceeding its bound", async () => {
	const h = fixture();
	await h.start();
	for (const connectorId of ["gmail", "outlook", "third"]) await h.start({ kind: "email", connectorId });
	h.restart();
	const session = h.sessions[0];
	if (!session) throw new Error("Missing fixture");
	session.assistantMessageId = "missed-while-off";
	const releases: Array<() => void> = [];
	h.email.mockImplementation(async () => {
		await new Promise<void>((resolve) => releases.push(resolve));
		return { cursor: {}, events: [] };
	});
	const first = h.watchers.tick();
	const second = h.watchers.tick();
	const third = h.watchers.tick();
	await vi.waitFor(() => expect(h.email).toHaveBeenCalledTimes(2));
	expect(new Set(h.email.mock.calls.map(([connector]) => connector)).size).toBe(2);
	await vi.waitFor(() => expect(h.watchers.status().pending).toBe(1));
	for (const release of releases) release();
	await Promise.all([first, second, third]);
});

it("enriches independent completed sessions concurrently in a bounded batch", async () => {
	const h = fixture();
	await h.start();
	h.event(0, "first");
	h.event(1, "second");
	h.advance();
	const releases: Array<() => void> = [];
	h.inspect.mockImplementation(async (_pane, sessionId) => {
		await new Promise<void>((resolve) => releases.push(resolve));
		return { sessionId, status: "idle", messages: [] };
	});
	const preparing = h.watchers.prepare();
	await vi.waitFor(() => expect(h.inspect).toHaveBeenCalledTimes(2));
	expect((await h.watchers.poll(true)).wake).toBeUndefined();
	expect(h.watchers.hasDelivery()).toBe(false);
	for (const release of releases) release();
	await preparing;
	expect((await h.watchers.poll(true)).wake?.events).toHaveLength(2);
});

it("claims another prepared watch while an unrelated report is still being read", async () => {
	const h = fixture();
	for (const session of h.sessions)
		await h.start({ kind: "agents", sessions: [{ paneId: session.paneId, sessionId: session.sessionId }] });
	h.event(0, "slow");
	h.event(1, "ready");
	let finish!: () => void;
	h.inspect.mockImplementation(async (_pane, sessionId) => {
		if (sessionId === "session-a")
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
		return {
			sessionId,
			status: "idle",
			messages: [{ role: "assistant", id: sessionId === "session-a" ? "slow" : "ready", content: "Listo" }],
		};
	});
	const preparing = h.watchers.prepare();
	await vi.waitFor(() => expect(h.inspect).toHaveBeenCalledTimes(2));
	h.advance();
	const wake = await vi.waitFor(async () => {
		const ready = (await h.watchers.poll(true)).wake;
		expect(ready?.events).toMatchObject([{ messageId: "ready", summary: "Listo" }]);
		return ready;
	});
	expect(h.watchers.status().pending).toBe(2);
	finish();
	await preparing;
	if (!wake) throw new Error("Missing prepared wake");
	await settle(h, wake);
	expect((await h.watchers.poll(true)).wake?.events[0]?.messageId).toBe("slow");
});

it("rebuilds a prepared batch when new events arrive during debounce, without duplicate reports", async () => {
	const h = fixture();
	await h.start();
	h.event(0, "first");
	await h.watchers.prepare();
	h.event(1, "second");
	await h.watchers.prepare();
	expect((await h.watchers.poll(true)).wake).toBeUndefined();
	h.advance();
	const wake = await claim(h);
	expect(wake.events.map((event) => event.id)).toEqual(["first", "second"]);
	await settle(h, wake);
	expect((await h.watchers.poll(true)).wake).toBeUndefined();
});

it("does not publish a prepared transcript after pause, deletion, close or revoked delivery authority", async () => {
	for (const action of ["pause", "delete", "close", "unauthorized"] as const) {
		const h = fixture();
		const watch = await h.start();
		h.event(0, "private");
		h.inspect.mockResolvedValue({
			sessionId: "session-a",
			status: "idle",
			messages: [{ role: "assistant", id: "private", content: "PRIVATE" }],
		});
		await h.watchers.prepare();
		h.advance();
		if (action === "close") h.watchers.close();
		else if (action !== "unauthorized") await h.watchers.dispatch({ action, watchId: watch.id }, "human");
		if (action === "close" || action === "unauthorized")
			await expect(h.watchers.poll(true, () => action !== "unauthorized")).rejects.toThrow();
		else expect((await h.watchers.poll(true)).wake).toBeUndefined();
		expect(h.watchers.hasDelivery()).toBe(false);
		expect(readFileSync(join(h.dataDir, "watchers.json"), "utf8")).not.toContain("PRIVATE");
	}
});

it("fails closed on a saved retry batch missing from its outbox without looping or acknowledging other events", async () => {
	const h = fixture();
	await h.start();
	h.event(0, "still-pending");
	const path = join(h.dataDir, "watchers.json");
	const saved = JSON.parse(readFileSync(path, "utf8"));
	saved.watches[0].batch = ["missing-event"];
	const original = JSON.stringify(saved);
	writeFileSync(path, original);
	h.restart();
	expect(h.watchers.status().error).toBeDefined();
	await h.watchers.prepare();
	await expect(h.watchers.poll(true)).rejects.toThrow("detenida");
	expect(h.inspect).not.toHaveBeenCalled();
	expect(readFileSync(path, "utf8")).toBe(original);
});
