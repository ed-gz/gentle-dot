import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CompletionReports,
	type CompletionReportsOptions,
	type CompletionSession,
} from "../src/completion-reports.ts";
import { tempDir } from "./helpers.ts";

const services: CompletionReports[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.close();
});
const session: CompletionSession = {
	paneId: "pane-1",
	sessionId: "session-1",
	label: "Trabajo",
	connected: true,
	state: "idle",
	capabilities: { inspect: true },
};
const conversation = () => ({
	sessionId: "session-1",
	status: "idle",
	question: null,
	messages: [
		{ role: "user", content: "Revisa el proyecto" },
		{
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "Revisé el proyecto. Las pruebas pasaron." }],
		},
	],
});
function setup(overrides: Partial<CompletionReportsOptions> = {}) {
	let now = 10_000;
	const dataDir = tempDir();
	const snapshot = vi.fn(async () => ({ sessions: [{ ...session }] }));
	const inspect = vi.fn(async (): Promise<unknown> => conversation());
	const options = { dataDir, snapshot, inspect, now: () => now, ...overrides };
	const service = new CompletionReports(options);
	services.push(service);
	const event = (id = "e1", fields: Record<string, unknown> = {}) => ({
		id,
		at: new Date(now).toISOString(),
		type: "completed",
		paneId: "pane-1",
		sessionId: "session-1",
		...fields,
	});
	return {
		service,
		options,
		snapshot,
		inspect,
		event,
		nextTime: () => {
			now += 1000;
		},
	};
}

describe("opt-in completion reports", () => {
	it("defaults off, persists only an explicit flag privately and never replays previous-run events", async () => {
		const h = setup();
		h.service.onEvent(h.event());
		expect(await h.service.take()).toEqual({ enabled: false, revision: 0, reports: [] });
		expect(h.snapshot).not.toHaveBeenCalled();
		h.service.configure(true);
		h.service.onEvent(h.event());
		expect(h.service.status().pending).toBe(1);
		const path = join(h.options.dataDir, "completion-reports.json");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, enabled: true });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const old = h.event("old");
		h.nextTime();
		const restarted = new CompletionReports(h.options);
		services.push(restarted);
		restarted.onEvent(old);
		expect(await restarted.take()).toEqual({ enabled: true, revision: 0, reports: [] });
	});

	it("keeps corrupt preferences off and rejects truthy non-boolean configuration", () => {
		const h = setup();
		writeFileSync(join(h.options.dataDir, "completion-reports.json"), "{broken");
		const restarted = new CompletionReports(h.options);
		services.push(restarted);
		expect(restarted.status().enabled).toBe(false);
		expect(() => restarted.configure("true")).toThrow(/Indica/);
	});

	it("deduplicates events, caps the queue and inspects only one verified session per poll", async () => {
		const h = setup();
		h.service.configure(true);
		h.service.onEvent(h.event("one", { paneId: "first" }));
		h.service.onEvent(h.event("one", { paneId: "first" }));
		expect(h.service.status().pending).toBe(1);
		for (let n = 0; n < 40; n++) h.service.onEvent(h.event(`event-${n}`, { paneId: `pane-${n}` }));
		h.snapshot.mockResolvedValue({
			sessions: Array.from({ length: 40 }, (_, n) => ({ ...session, paneId: `pane-${n}` })),
		});
		expect(h.service.status()).toMatchObject({ pending: 32, dropped: 9 });
		const batch = await h.service.take();
		expect(batch.reports).toHaveLength(1);
		expect(batch.reports[0]).toMatchObject({
			id: "event-8",
			sessionId: "session-1",
			outcome: "idle",
			lastAssistant: "Revisé el proyecto. Las pruebas pasaron.",
		});
		expect(h.inspect).toHaveBeenCalledTimes(1);
		expect(h.inspect).toHaveBeenCalledWith("pane-8", "session-1");
	});

	it("coalesces a session's pending completions and discards an older in-flight result", async () => {
		const h = setup();
		h.service.configure(true);
		h.service.onEvent(h.event("A"));
		h.nextTime();
		h.service.onEvent(h.event("B"));
		expect(h.service.status().pending).toBe(1);
		expect((await h.service.take()).reports[0]?.id).toBe("B");
		expect(h.service.status().pending).toBe(0);
		let finish: ((value: unknown) => void) | undefined;
		h.inspect.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		h.service.onEvent(h.event("C"));
		const taking = h.service.take();
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		h.nextTime();
		h.service.onEvent(h.event("D"));
		finish?.(conversation());
		expect((await taking).reports).toEqual([]);
		expect(h.service.status().pending).toBe(1);
		expect((await h.service.take()).reports[0]?.id).toBe("D");
	});

	it("does not attribute a different final message to an identified completion", async () => {
		const h = setup();
		h.service.configure(true);
		h.service.onEvent(h.event("A", { assistantMessageId: "answer-A" }));
		h.inspect.mockResolvedValue({
			...conversation(),
			messages: [{ role: "assistant", id: "answer-B", content: "New work" }],
		});
		expect((await h.service.take()).reports).toEqual([]);
		h.service.onEvent(h.event("B", { assistantMessageId: "answer-B" }));
		expect((await h.service.take()).reports[0]?.lastAssistant).toBe("New work");
	});

	it("ignores other events and will not inspect a reused, disconnected, or working pane", async () => {
		const h = setup();
		h.service.configure(true);
		h.service.onEvent(h.event("attention", { type: "attention" }));
		h.service.onEvent(h.event("legacy", { sessionId: undefined }));
		expect(h.service.status().pending).toBe(0);
		for (const change of [
			{ sessionId: "replacement" },
			{ connected: false },
			{ state: "working" },
			{ capabilities: { inspect: false } },
		]) {
			h.snapshot.mockResolvedValue({ sessions: [{ ...session, ...change }] });
			h.service.onEvent(h.event(JSON.stringify(change)));
			expect((await h.service.take()).reports).toEqual([]);
		}
		expect(h.inspect).not.toHaveBeenCalled();
	});

	it("does not report stale messages, pending permission, inspection failure or a changed session as success", async () => {
		const h = setup();
		h.service.configure(true);
		for (const value of [
			{ ...conversation(), sessionId: "changed" },
			{ ...conversation(), status: "working" },
			{ ...conversation(), question: { id: "needs-human" } },
			{
				...conversation(),
				messages: [...conversation().messages, { role: "user", content: "Ahora otra tarea" }],
			},
		]) {
			h.inspect.mockResolvedValue(value);
			h.service.onEvent(h.event(JSON.stringify(value).slice(0, 200)));
			expect((await h.service.take()).reports).toEqual([]);
		}
		h.inspect.mockRejectedValue(new Error("Connection failed"));
		h.service.onEvent(h.event("failure"));
		expect((await h.service.take()).reports).toEqual([
			expect.objectContaining({
				outcome: "unavailable",
				lastAssistant: "",
				unavailableReason: expect.any(String),
			}),
		]);
		expect(h.service.status().error).toMatch(/no se pudo verificar/);
		h.inspect.mockRejectedValue(Object.assign(new Error("La sesión cambió"), { code: "SESSION_CHANGED" }));
		h.service.onEvent(h.event("replaced-during-inspection"));
		expect((await h.service.take()).reports).toEqual([]);
	});

	it("labels aborts and errors honestly, caps quoted output and omits tool output", async () => {
		const h = setup();
		h.service.configure(true);
		for (const stopReason of ["error", "aborted"]) {
			h.inspect.mockResolvedValue({
				...conversation(),
				messages: [
					{ role: "tool", content: "SECRET_NOT_INCLUDED" },
					{ role: "assistant", stopReason, content: [{ type: "text", text: "x".repeat(20_000) }] },
				],
			});
			h.service.onEvent(h.event(stopReason));
			const report = (await h.service.take()).reports[0];
			expect(report).toMatchObject({ outcome: stopReason, truncated: true });
			expect(report?.lastAssistant).toHaveLength(16_000);
			expect(JSON.stringify(report)).not.toContain("SECRET_NOT_INCLUDED");
			h.inspect.mockResolvedValue({
				...conversation(),
				stopReason,
				messages: [
					{ role: "assistant", content: "Old task completed" },
					{ role: "user", content: "New task with no final answer" },
				],
			});
			h.service.onEvent(h.event(`${stopReason}-without-answer`));
			const incomplete = (await h.service.take()).reports[0];
			expect(incomplete).toMatchObject({ outcome: stopReason, truncated: false });
			expect(incomplete?.lastAssistant).not.toContain("Old task completed");
		}
	});

	it("drops in-flight and queued results immediately when disabled or authority is revoked", async () => {
		for (const revoke of [true, false]) {
			const h = setup();
			h.service.configure(true);
			let finish: ((value: unknown) => void) | undefined;
			h.inspect.mockImplementation(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
			h.service.onEvent(h.event());
			let allowed = true;
			const pending = h.service.take(() => allowed);
			await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
			if (revoke) allowed = false;
			else h.service.configure(false);
			finish?.(conversation());
			expect((await pending).reports).toEqual([]);
			expect(h.service.status().pending).toBe(0);
		}
	});

	it("does not opt back in when disabling cannot persist, and prevents duplicate concurrent drains", async () => {
		const h = setup();
		h.service.configure(true);
		let finish: ((value: unknown) => void) | undefined;
		h.inspect.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		h.service.onEvent(h.event());
		const pending = h.service.take();
		await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
		expect((await h.service.take()).reports).toEqual([]);
		rmSync(h.options.dataDir, { recursive: true });
		writeFileSync(h.options.dataDir, "not a directory");
		expect(() => h.service.configure(false)).toThrow(/guardar/);
		expect(h.service.status()).toMatchObject({ enabled: false, pending: 0 });
		finish?.(conversation());
		expect((await pending).reports).toEqual([]);
	});
});

describe("background report preparation", () => {
	it("returns immediately while a source inspection is slow, then delivers exactly once", async () => {
		const h = setup();
		h.service.configure(true);
		h.service.onEvent(h.event());
		let finish!: () => void;
		h.inspect.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return conversation();
		});
		expect(h.service.takeReady().reports).toEqual([]);
		await vi.waitFor(() => expect(h.inspect).toHaveBeenCalledTimes(1));
		expect(h.service.takeReady().reports).toEqual([]);
		finish();
		await vi.waitFor(() => expect(h.service.status().ready).toBe(1));
		expect(h.service.takeReady().reports[0]?.id).toBe("e1");
		expect(h.service.takeReady().reports).toEqual([]);
		expect(h.inspect).toHaveBeenCalledTimes(1);
	});
	it("invalidates prepared reports after a newer result or disabled preference", async () => {
		const h = setup();
		h.service.configure(true);
		h.service.onEvent(h.event("old"));
		h.service.prepare();
		await vi.waitFor(() => expect(h.service.status().ready).toBe(1));
		h.nextTime();
		h.service.onEvent(h.event("new"));
		expect(h.service.status().ready).toBe(0);
		expect(h.service.takeReady().reports).toEqual([]);
		await vi.waitFor(() => expect(h.service.status().ready).toBe(1));
		h.service.configure(false);
		expect(h.service.takeReady()).toMatchObject({ enabled: false, reports: [] });
	});
	it("does not publish a result prepared across preference revocation", async () => {
		const h = setup();
		h.service.configure(true);
		h.service.onEvent(h.event());
		let finish!: () => void;
		h.inspect.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return conversation();
		});
		h.service.prepare();
		await vi.waitFor(() => expect(h.inspect).toHaveBeenCalledOnce());
		h.service.configure(false);
		finish();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(h.service.status().ready).toBe(0);
	});
});
