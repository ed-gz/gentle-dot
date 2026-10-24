import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionActivityTracker, EDITOR_ACTIVITY_EVENT } from "../src/orchestration/companion-activity.ts";
import { CompanionContext } from "../src/orchestration/companion-context.ts";
import { installEditorActivityBridge } from "../src/orchestration/editor-activity-bridge.ts";
import { type OrchestrationSnapshot, Orchestrator } from "../src/orchestration/index.ts";
import type { Manifest } from "../src/orchestration/registry.ts";

afterEach(() => vi.useRealTimers());
const time = Date.parse("2026-10-23T15:00:00.000Z");
const snapshot: OrchestrationSnapshot = {
	providers: [],
	available: true,
	policies: [],
	events: [],
	sessions: ["p1", "p2"].map((paneId) => ({
		paneId,
		sessionId: `s-${paneId}`,
		provider: "herdr",
		label: paneId,
		terminalId: `t-${paneId}`,
		workspaceId: "w1",
		connected: true,
		managed: true,
		state: "idle",
		capabilities: { inspect: true, prompt: true, abort: true, approvals: true },
		lastMessage: "private transcript",
	})),
	approvals: [
		{
			id: "q1",
			paneId: "p2",
			sessionId: "s-p2",
			title: "Permiso pendiente",
			message: "private question body",
			action: "approve",
			createdAt: new Date(time).toISOString(),
			expiresAt: "",
			answerable: true,
		},
	],
};
const herdr = {
	focused_workspace_id: "w1",
	focused_tab_id: "tab1",
	focused_pane_id: "p1",
	layouts: [
		{
			workspace_id: "w1",
			tab_id: "tab1",
			focused_pane_id: "p1",
			zoomed: true,
			panes: [{ pane_id: "p1", rect: { x: 0, y: 0, width: 80, height: 40 } }, { pane_id: "p2" }],
		},
	],
};

describe("contextual companion projection", () => {
	it("projects focus, zoomed visibility and exact pending session without transcript or invented pixels", () => {
		const context = new CompanionContext();
		context.update(snapshot, herdr, new Map(), time);
		const result = context.read(time);
		expect(result).toMatchObject({
			stale: false,
			focusedPaneId: "p1",
			visiblePaneIds: ["p1"],
			capabilities: { geometry: false },
		});
		expect(result.sessions[0]).toMatchObject({
			focused: true,
			visible: true,
			targets: { composer: null, sidebar: null },
			canFocus: true,
		});
		expect(result.sessions[1]).toMatchObject({
			focused: false,
			visible: false,
			activity: { phase: "waiting" },
			pendingQuestion: { id: "q1" },
		});
		expect(JSON.stringify(result)).not.toContain("private");
		const first = result.sessions[0];
		if (!first) throw new Error("Missing fixture session");
		first.activity.phase = "typing";
		expect(context.read(time).sessions[0]?.activity.phase).toBe("idle");
	});
	it("expires typing between polls, suppresses stale focus and does not infer absent visibility", () => {
		const context = new CompanionContext();
		const tracker = new CompanionActivityTracker();
		tracker.editor("changed", time);
		context.update(
			snapshot,
			{ focused_pane_id: "p1" },
			new Map([["p1", tracker.snapshot(true, false, time)]]),
			time,
		);
		expect(context.read(time).sessions[0]).toMatchObject({ visible: null, activity: { phase: "typing" } });
		expect(context.read(time + 4000).sessions[0]?.activity.phase).toBe("idle");
		expect(context.read(time + 13000)).toMatchObject({
			stale: true,
			focusedPaneId: null,
			visiblePaneIds: [],
		});
		expect(
			context
				.read(time + 13000)
				.sessions.every((session) => session.activity.phase === "unknown" && !session.canFocus),
		).toBe(true);
	});
	it("keeps real submission and response timestamps while questions take priority", () => {
		const tracker = new CompanionActivityTracker();
		tracker.submitted(time);
		expect(tracker.snapshot(true, false, time)).toMatchObject({
			phase: "submitted",
			submittedAt: new Date(time).toISOString(),
		});
		tracker.response(true, time + 10);
		expect(tracker.snapshot(false, false, time + 10).phase).toBe("working");
		tracker.editor("changed", time + 20);
		expect(tracker.snapshot(false, false, time + 20).phase).toBe("typing");
		expect(tracker.snapshot(false, true, time + 20).phase).toBe("waiting");
		tracker.response(false, time + 4000);
		expect(tracker.snapshot(true, false, time + 4000)).toMatchObject({
			phase: "idle",
			responseEndedAt: new Date(time + 4000).toISOString(),
		});
	});
});

describe("editor activity bridge", () => {
	it("observes only actual editor changes during input, preserving callback assignment, values and disposal", () => {
		vi.useFakeTimers();
		vi.setSystemTime(time);
		const messages: unknown[] = [];
		const listeners = new Map<string, (data: unknown) => void>();
		const events = {
			emit: (channel: string, data: unknown) => {
				if (channel === EDITOR_ACTIVITY_EVENT) messages.push(data);
			},
			on: (channel: string, callback: (data: unknown) => void) => {
				listeners.set(channel, callback);
				return () => {
					listeners.delete(channel);
				};
			},
		};
		const nativeChange = vi.fn();
		const editor = {
			onChange: undefined as ((text: string) => void) | undefined,
			handleInput(value: string) {
				if (value !== "ArrowLeft") this.onChange?.(value);
			},
			dispose: vi.fn(),
		};
		const originalInput = editor.handleInput;
		const originalDispose = editor.dispose;
		installEditorActivityBridge(editor, events, "s1");
		editor.onChange = nativeChange; // Pi assigns this after its factory returns.
		editor.onChange?.("programmatic content");
		editor.handleInput("ArrowLeft");
		expect(messages).toEqual([{ sessionId: "s1", kind: "ready" }]);
		editor.handleInput("private draft");
		expect(nativeChange).toHaveBeenLastCalledWith("private draft");
		expect(messages).toEqual([
			{ sessionId: "s1", kind: "ready" },
			{ sessionId: "s1", kind: "changed" },
		]);
		expect(JSON.stringify(messages)).not.toContain("draft");
		listeners.get(`${EDITOR_ACTIVITY_EVENT}:probe`)?.({ sessionId: "other" });
		expect(messages).toHaveLength(2);
		listeners.get(`${EDITOR_ACTIVITY_EVENT}:probe`)?.({ sessionId: "s1" });
		expect(messages).toHaveLength(3);
		editor.dispose();
		expect(editor.handleInput).toBe(originalInput);
		expect(editor.onChange).toBe(nativeChange);
		expect(originalDispose).toHaveBeenCalledOnce();
		expect(listeners.size).toBe(0);
	});
	it("allows another extension to wrap onChange without recursion or changing exceptions", () => {
		const emit = vi.fn();
		const change = vi.fn();
		const editor: { onChange: (value: string) => void; handleInput(value: string): void } = {
			onChange: change,
			handleInput(value: string) {
				this.onChange(value);
			},
		};
		const close = installEditorActivityBridge(editor, { emit, on: () => () => {} }, "s1");
		const previous = editor.onChange;
		editor.onChange = vi.fn((value) => previous(value));
		editor.handleInput("fixture");
		expect(change).toHaveBeenCalledExactlyOnceWith("fixture");
		const failure = new Error("native callback failure");
		editor.onChange = () => {
			throw failure;
		};
		expect(() => editor.handleInput("fixture")).toThrow(failure);
		close();
	});
	it("prepares only a verified Gentle Shell insertion without changing installed source", async () => {
		const path = resolve("scripts/orchestration/install-editor-activity-bridge.mjs");
		const { prepareEditorActivityBridge } = await import(path);
		const gentle = dirname(createRequire(import.meta.url).resolve("gentle-pi/package.json"));
		const changes = prepareEditorActivityBridge(gentle);
		expect(Object.keys(changes)).toEqual(["extensions/gentle-shell.ts"]);
		expect(changes["extensions/gentle-shell.ts"]).toContain(
			"installEditorActivityBridge(prompt, pi.events, ctx.sessionManager.getSessionId());",
		);
		expect(changes["extensions/gentle-shell.ts"]).not.toContain("getEditorText()");
	});
});

function orchestratorFixture() {
	let humanActivityAt: string | undefined;
	const onInteraction = vi.fn();
	let focus = "p1";
	let realSession = "s-p1";
	let authorized = true;
	let acknowledgeFocus = true;
	const manifest: Manifest = {
		version: 1,
		socketPath: "/fixture-pi.sock",
		pid: 123,
		sessionId: "s-p1",
		managed: true,
		binding: { terminalId: "t1", herdrSocketPath: "/fixture-herdr.sock" },
	};
	const request = vi.fn(async (_socket: string, method: string) => {
		if (method === "session.snapshot")
			return {
				snapshot: {
					...herdr,
					focused_pane_id: focus,
					panes: [{ pane_id: "p1", terminal_id: "t1", workspace_id: "w1", label: "fixture" }],
				},
			};
		if (method === "pane.get") return { pane: { pane_id: "p1", terminal_id: "t1" } };
		if (method === "pane.process_info") return { process_info: { foreground_processes: [{ pid: 123 }] } };
		if (method === "snapshot")
			return { sessionId: realSession, status: "idle", messages: [], capabilities: {}, companionActivity:{humanActivityAt} };
		if (method === "pane.focus") {
			if (acknowledgeFocus) focus = "p1";
			return { focused: true };
		}
		throw new Error(`Unexpected fixture method ${method}`);
	});
	const orchestrator = new Orchestrator({
		dataDir: "/tmp/companion-fixture-only",
		onInteraction,
		socketPath: "/fixture-herdr.sock",
		request,
		registry: async () => [manifest],
		pollMs: 0,
		orcaCommand: false,
		terminalLauncher: false,
	});
	return {
		orchestrator,
		request,
		onInteraction,
		human: () => { humanActivityAt = new Date(time).toISOString(); },
		authorize: () => authorized,
		revoke: () => {
			authorized = false;
		},
		change: () => {
			realSession = "new-session";
		},
		unconfirmed: () => {
			focus = "other";
			acknowledgeFocus = false;
		},
	};
}

it("observes personal editor/submission metadata once for the exact logical session, not prompt content", async () => {
 const h=orchestratorFixture();
 try {
  await h.orchestrator.snapshot(); expect(h.onInteraction).not.toHaveBeenCalled();
  h.human(); await h.orchestrator.snapshot(); await h.orchestrator.snapshot();
  expect(h.onInteraction).toHaveBeenCalledExactlyOnceWith({paneId:"p1",sessionId:"s-p1"},"human");
 } finally { await h.orchestrator.close(); }
});
it("does not mark ordinary submission/agent response as personal activity", () => {
 const tracker=new CompanionActivityTracker();
 tracker.submitted(time); tracker.response(true,time+1);
 expect(tracker.snapshot(false,false,time+2).humanActivityAt).toBeUndefined();
 tracker.editor("changed",time+3);
 expect(tracker.snapshot(false,false,time+4).humanActivityAt).toBe(new Date(time+3).toISOString());
});

it("serves contextual cache without any extra terminal snapshot or mutation", async () => {
	const h = orchestratorFixture();
	try {
		expect(h.orchestrator.companion().stale).toBe(true);
		expect(h.request).not.toHaveBeenCalled();
		await h.orchestrator.snapshot();
		h.request.mockClear();
		for (let i = 0; i < 20; i++) expect(h.orchestrator.companion().sessions).toHaveLength(1);
		expect(h.request).not.toHaveBeenCalled();
	} finally {
		await h.orchestrator.close();
	}
});
it("focus requires an exact live session and authorization, verifies confirmation and never answers a question", async () => {
	const h = orchestratorFixture();
	try {
		await expect(
			h.orchestrator.focusCompanion({ paneId: "p1", sessionId: "s-p1" }, h.authorize),
		).resolves.toMatchObject({ focused: true, scope: "herdr" });
		expect(h.request.mock.calls.some((call) => ["answer", "abort", "prompt"].includes(call[1]))).toBe(false);
		h.unconfirmed();
		await expect(
			h.orchestrator.focusCompanion({ paneId: "p1", sessionId: "s-p1" }, h.authorize),
		).rejects.toMatchObject({ code: "FOCUS_UNCONFIRMED" });
		h.change();
		h.request.mockClear();
		await expect(
			h.orchestrator.focusCompanion({ paneId: "p1", sessionId: "s-p1" }, h.authorize),
		).rejects.toMatchObject({ code: "SESSION_CHANGED" });
		expect(h.request.mock.calls.some((call) => call[1] === "pane.focus")).toBe(false);
		h.revoke();
		h.request.mockClear();
		await expect(
			h.orchestrator.focusCompanion({ paneId: "p1", sessionId: "s-p1" }, h.authorize),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(h.request).not.toHaveBeenCalled();
	} finally {
		await h.orchestrator.close();
	}
});
