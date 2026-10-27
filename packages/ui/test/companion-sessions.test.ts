import { createElement } from "react";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type CompanionSessionSnapshot, useDesktopSessionContext, useWorkingSession } from "../src/companion-sessions.ts";
import { DEFAULT_DESKTOP_COMPANION, type DesktopCompanionControls } from "../src/desktop-companion.ts";
import { CapriConversation } from "../src/capri3d/conversation.tsx";
import { initialState } from "../src/store.ts";

vi.mock("../src/capri3d/replies.ts", () => ({ watchReplies: () => () => {} }));
vi.mock("../src/useVoice.ts", () => ({ useVoice: () => ({ phase: "idle" }) }));
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function snapshot(): CompanionSessionSnapshot {
	return {
		version: 1, stale: false, observedAt: new Date().toISOString(),
		sessions: [{
			paneId: "pane-a", sessionId: "session-a", label: "Proyecto", focused: true,
			visible: true, canFocus: true, activity: { phase: "waiting" },
			targets: { composer: null, sidebar: null },
			pendingQuestion: { id: "permission-a", title: "Permiso", createdAt: new Date().toISOString(), answerable: true },
		}],
	};
}
function setup(read: () => CompanionSessionSnapshot = snapshot) {
	const publish = vi.fn().mockResolvedValue(undefined);
	const fetcher = vi.fn(async () => ({ ok: true, json: async () => read() }));
	vi.stubGlobal("fetch", fetcher);
	const controls = { state: DEFAULT_DESKTOP_COMPANION, context: publish } as unknown as DesktopCompanionControls;
	const info = { url: "ws://127.0.0.1:4317/ws", token: "fixture" };
	const hook = renderHook(() => useDesktopSessionContext(info, controls, true));
	return { ...hook, publish, fetcher };
}
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
const question = { kind: "question", id: "question:permission-a", paneId: "pane-a", sessionId: "session-a" };

it("reads working metadata only for the fresh focused session and clears on failure",async()=>{
 let data=snapshot();delete data.sessions[0]!.pendingQuestion;
 data.sessions[0]!.activity={phase:"working",lastAction:{verb:"EDITO",subject:"gigs.ts",at:new Date().toISOString()}};
 const fetcher=vi.fn(async()=>({ok:true,json:async()=>data}));vi.stubGlobal("fetch",fetcher);
 const info={url:"ws://localhost:4317/ws",token:"fixture"};
 const view=renderHook(()=>useWorkingSession(info,true));await advance(1);
 expect(view.result.current).toMatchObject({sessionId:"session-a",activity:{lastAction:{subject:"gigs.ts"}}});
 data={...data,stale:true};await advance(1000);expect(view.result.current).toBeUndefined();
 data={...data,stale:false};await advance(1000);expect(view.result.current).toBeDefined();
 fetcher.mockRejectedValueOnce(new Error("offline"));await advance(1000);expect(view.result.current).toBeUndefined();
 view.unmount();const count=fetcher.mock.calls.length;await advance(5000);expect(fetcher).toHaveBeenCalledTimes(count);
});

it("refreshes a still-pending question beyond eight seconds and the native 30-second TTL", async () => {
	const { publish, unmount } = setup();
	await advance(60_000);
	expect(publish).toHaveBeenLastCalledWith(expect.objectContaining(question));
	expect(publish.mock.calls.length).toBeGreaterThan(10);
	expect(publish.mock.calls.every(([cue]) => cue.kind === "question")).toBe(true);
	unmount();
	expect(publish).toHaveBeenLastCalledWith({ kind: "rest", id: question.id });
});

it.each(["withdrawn", "stale", "aged", "invalid-date", "future"])("clears a published question when the snapshot is %s", async (reason) => {
	let data = snapshot();
	let future = false;
	const { publish, unmount } = setup(() => future ? { ...data, observedAt: new Date(Date.now() + 5000).toISOString() } : data);
	await advance(1);
	expect(publish).toHaveBeenLastCalledWith(expect.objectContaining(question));
	if (reason === "withdrawn") delete data.sessions[0]!.pendingQuestion;
	else if (reason === "stale") data.stale = true;
	else if (reason === "aged") data.observedAt = new Date(Date.now() - 12_001).toISOString();
	else if (reason === "future") future = true;
	else data.observedAt = "invalid";
	await advance(750);
	expect(publish).toHaveBeenLastCalledWith({ kind: "rest", id: question.id });
	const count = publish.mock.calls.length;
	await advance(35_000);
	expect(publish).toHaveBeenCalledTimes(count);
	future = false;
	data = snapshot();
	await advance(750);
	expect(publish).toHaveBeenLastCalledWith(expect.objectContaining(question));
	unmount();
});

it("does not renew a frozen snapshot indefinitely even if HTTP requests keep succeeding", async () => {
	const data = snapshot();
	const { publish, unmount } = setup(() => data);
	await advance(35_000);
	expect(publish).toHaveBeenLastCalledWith({ kind: "rest", id: question.id });
	unmount();
});

it("refreshes the exact pane/session binding even when request IDs are reused", async () => {
	const data = snapshot();
	const { publish, unmount } = setup(() => ({ ...data, observedAt: new Date().toISOString() }));
	await advance(9000);
	data.sessions[0]!.paneId = "pane-b";
	data.sessions[0]!.sessionId = "session-b";
	await advance(750);
	expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ ...question, paneId: "pane-b", sessionId: "session-b" }));
	unmount();
});

it("withdraws on transport failure and can publish the same request on recovery", async () => {
	const { publish, fetcher, unmount } = setup();
	await advance(1);
	fetcher.mockRejectedValueOnce(new Error("offline"));
	await advance(750);
	expect(publish).toHaveBeenLastCalledWith({ kind: "rest", id: question.id });
	await advance(750);
	expect(publish).toHaveBeenLastCalledWith(expect.objectContaining(question));
	unmount();
});

function approval() {
	return { id: "permission-a", paneId: "pane-a", sessionId: "session-a", title: "Permiso", message: "Ejecutar", action: "bash", kind: "confirm" as const, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), answerable: true };
}
function conversation(ask = approval(), answer = vi.fn().mockResolvedValue(undefined)) {
	const props = { state: initialState, send: vi.fn(), open: false, close: vi.fn(), more: vi.fn(), onLayout: vi.fn(), approval: ask, answer };
	return { ...render(createElement(CapriConversation, props)), props, answer };
}
it("keeps a confirmation visible past the transport TTL, but never extends the approval expiry", async () => {
	conversation();
	await advance(35_000);
	expect(screen.getByRole("button", { name: "Aprobar" })).toBeEnabled();
	await advance(25_000);
	expect(screen.queryByRole("button", { name: "Aprobar" })).toBeNull();
});
it("removes withdrawn approval controls", () => {
	const { rerender, props } = conversation();
	rerender(createElement(CapriConversation, { ...props, approval: undefined }));
	expect(screen.queryByRole("button", { name: "Aprobar" })).toBeNull();
});
it("retains failed-answer retry behavior and sends only the exact request identity", async () => {
	const answer = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
	conversation(approval(), answer);
	await act(async () => fireEvent.click(screen.getByRole("button", { name: "Rechazar" })));
	expect(screen.getByRole("alert")).toHaveTextContent("No se pudo responder");
	await act(async () => fireEvent.click(screen.getByRole("button", { name: "Rechazar" })));
	expect(answer.mock.calls).toEqual([[{ action: "answer", paneId: "pane-a", sessionId: "session-a", requestId: "permission-a", approved: false }], [{ action: "answer", paneId: "pane-a", sessionId: "session-a", requestId: "permission-a", approved: false }]]);
	expect(screen.queryByRole("button", { name: "Rechazar" })).toBeNull();
});
