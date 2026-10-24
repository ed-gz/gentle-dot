import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sceneForActivity } from "../src/capri-scenes.ts";
import {
	publishCompanionActivity,
	useCompanionActivity,
	useCompanionResponse,
} from "../src/companion-activity.ts";
import {
	type CompanionSessionSnapshot,
	companionSessionCue,
	useDesktopSessionContext,
} from "../src/companion-sessions.ts";
import { DesktopCompanionBubble } from "../src/components/DesktopCompanionBubble.tsx";
import { DEFAULT_DESKTOP_COMPANION, type DesktopCompanionControls } from "../src/desktop-companion.ts";
import { useCapriFloat } from "../src/useCapriFloat.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it("reacts to editing across fields without ever reading a draft, and ignores passwords", () => {
	const hook = renderHook(() => useCompanionActivity(true));
	const fixture = document.createElement("div");
	fixture.innerHTML =
		'<textarea aria-label="Mensaje"></textarea><input type="password" aria-label="Clave"><div contenteditable="true" role="textbox" aria-label="Editor"></div>';
	document.body.append(fixture);
	const box = screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;
	const value = vi.spyOn(box, "value", "get").mockImplementation(() => {
		throw new Error("Draft must not be read");
	});
	fireEvent.input(box);
	expect(hook.result.current.kind).toBe("typing");
	expect(value).not.toHaveBeenCalled();
	act(() => vi.advanceTimersByTime(4100));
	fireEvent.input(screen.getByLabelText("Clave"));
	expect(hook.result.current.kind).toBe("rest");
	fireEvent.input(screen.getByRole("textbox", { name: "Editor" }));
	expect(hook.result.current.kind).toBe("typing");
	fixture.remove();
	hook.unmount();
	expect(vi.getTimerCount()).toBe(0);
});

it("distinguishes pending delivery from an accepted send and failure", () => {
	const hook = renderHook(() => useCompanionActivity(true));
	act(() => publishCompanionActivity("sending"));
	expect(hook.result.current.kind).toBe("sending");
	act(() => publishCompanionActivity("queued"));
	expect(hook.result.current.kind).toBe("queued");
	act(() => publishCompanionActivity("submitted"));
	expect(hook.result.current.kind).toBe("submitted");
	act(() => publishCompanionActivity("failed"));
	expect(hook.result.current.kind).toBe("failed");
	hook.unmount();
});

it("reacts to new replies without guiding toward a reply outside the visible viewport", () => {
	const activity = renderHook(() => useCompanionActivity(true));
	const reply = document.createElement("div");
	reply.className = "context-response-fixture";
	document.body.append(reply);
	const rect = vi.spyOn(reply, "getBoundingClientRect").mockReturnValue({
		x: 20,
		y: 100,
		left: 20,
		top: 100,
		right: 220,
		bottom: 180,
		width: 200,
		height: 80,
		toJSON() {},
	});
	const response = renderHook(
		({ id }) => useCompanionResponse(id, "session", true, ".context-response-fixture"),
		{ initialProps: { id: "initial" } },
	);
	expect(activity.result.current.kind).toBe("greeting");
	response.rerender({ id: "visible" });
	expect(activity.result.current).toMatchObject({ kind: "response", target: { x: 20, y: 100 } });
	act(() => vi.advanceTimersByTime(800));
	rect.mockReturnValue({
		x: 20,
		y: 2000,
		left: 20,
		top: 2000,
		right: 220,
		bottom: 2080,
		width: 200,
		height: 80,
		toJSON() {},
	});
	response.rerender({ id: "offscreen" });
	expect(activity.result.current.kind).toBe("response");
	expect(activity.result.current.target).toBeUndefined();
	response.unmount();
	activity.unmount();
	reply.remove();
});

const scene = {
	state: "idle",
	connected: true,
	attention: false,
	sessions: true,
	interaction: "rest",
	company: "visits",
	phase: 0,
	scene: "auto",
	celebrate: false,
} as const;
it("ignores ambient phases and keeps activity authoritative", () => {
	expect(sceneForActivity({ ...scene, musicPlaying: true })).toBe("idle");
	expect(sceneForActivity({ ...scene, musicPlaying: true, phase: 1 })).toBe("idle");
	expect(sceneForActivity({ ...scene, musicPlaying: true, phase: 3 })).toBe("idle");
	expect(sceneForActivity({ ...scene, musicPlaying: true, attention: true })).toBe("alert");
	expect(sceneForActivity({ ...scene, musicPlaying: true, interaction: "typing" })).toBe("eyes");
	expect(sceneForActivity({ ...scene, musicPlaying: true, interaction: "submitted" })).toBe("follow-message");
	expect(["headphones", "dancing"]).not.toContain(
		sceneForActivity({ ...scene, musicPlaying: true, state: "working" }),
	);
	expect(
		new Set(
			[0, 1, 2, 3].map((activitySequence) =>
				sceneForActivity({ ...scene, interaction: "typing", activitySequence }),
			),
		),
	).toEqual(new Set(["eyes"]));
});

function snapshot(): CompanionSessionSnapshot {
	return {
		version: 1,
		stale: false,
		observedAt: new Date().toISOString(),
		sessions: [
			{
				paneId: "p1",
				sessionId: "s1",
				label: "Actual",
				focused: true,
				visible: true,
				canFocus: true,
				activity: { phase: "working" },
				targets: { composer: null, sidebar: null },
			},
			{
				paneId: "p2",
				sessionId: "s2",
				label: "Otra",
				focused: false,
				visible: false,
				canFocus: true,
				activity: { phase: "waiting" },
				targets: { composer: null, sidebar: null },
				pendingQuestion: {
					id: "q2",
					title: "Autorización",
					createdAt: new Date().toISOString(),
					answerable: true,
				},
			},
		],
	};
}
it("guides to an unseen question with its real identity without inventing coordinates", () => {
	const data = snapshot(),
		cue = companionSessionCue(data);
	expect(cue).toMatchObject({ kind: "question", id: "question:q2", paneId: "p2", sessionId: "s2" });
	expect(cue.target).toBeUndefined();
	expect(companionSessionCue({ ...data, stale: true })).toMatchObject({ kind: "rest" });
	data.sessions.pop();
	expect(companionSessionCue(data)).toMatchObject({ kind: "working", sessionId: "s1" });
	data.sessions[0]!.activity = { phase: "typing", typingUntil: new Date(Date.now() - 1).toISOString() };
	expect(companionSessionCue(data)).toMatchObject({ kind: "rest" });
});

it("sits only on a fresh verified editor and steps aside when typing starts", () => {
	const data = snapshot();
	data.sessions.pop();
	const session = data.sessions[0]!;
	session.activity = { phase: "idle" };
	session.targets.composer = {
		x: -1200,
		y: 600,
		width: 800,
		height: 120,
		kind: "editor",
		verified: true,
		observedAt: new Date().toISOString(),
	};
	expect(companionSessionCue(data)).toMatchObject({
		kind: "input-ready",
		placement: "perch",
		target: { x: -1200, y: 600 },
	});
	session.activity = { phase: "typing", typingUntil: new Date(Date.now() + 3000).toISOString() };
	expect(companionSessionCue(data)).toMatchObject({ kind: "typing", placement: "aside" });
	session.targets.composer.kind = "cursor";
	expect(companionSessionCue(data)).toMatchObject({ kind: "typing", placement: "aside" });
	session.activity = { phase: "idle" };
	expect(companionSessionCue(data)).toMatchObject({ kind: "input-ready" });
	expect(companionSessionCue(data).target).toBeUndefined();
	session.targets.composer.kind = "editor";
	session.targets.composer.observedAt = new Date(Date.now() - 2501).toISOString();
	expect(companionSessionCue(data)).toMatchObject({ kind: "input-ready" });
	expect(companionSessionCue(data).target).toBeUndefined();
	session.targets.composer.observedAt = new Date().toISOString();
	session.visible = false;
	expect(companionSessionCue(data).kind).toBe("input-ready");
	expect(companionSessionCue(data).target).toBeUndefined();
	session.targets.composer = null;
	session.activity = { phase: "typing", typingUntil: new Date(Date.now() + 3000).toISOString() };
	expect(companionSessionCue(data)).toMatchObject({ kind: "typing" });
	expect(companionSessionCue(data).target).toBeUndefined();
});

it("keeps pinned coordinates while real input guidance changes", () => {
	const options = {
		enabled: true,
		moving: true,
		pinned: true,
		side: "auto" as const,
		size: { width: 100, height: 100 },
		position: { x: 0.25, y: 0.25 },
		onPosition: vi.fn(),
		target: { x: 100, y: 300, width: 200, height: 60 },
	};
	const hook = renderHook(({ target }) => useCapriFloat({ ...options, target }), {
		initialProps: { target: options.target },
	});
	const start = hook.result.current.point;
	hook.rerender({ target: { x: 200, y: 600, width: 150, height: 60 } });
	act(() => vi.advanceTimersByTime(21000));
	expect(hook.result.current.point).toEqual(start);
	hook.unmount();
});

it("acknowledges only a painted notification, presents plain text and opens questions only by click", () => {
	const ready = vi.fn().mockResolvedValue(undefined),
		open = vi.fn().mockResolvedValue(undefined);
	const controls = {
		state: {
			...DEFAULT_DESKTOP_COMPANION,
			enabled: true,
			context: {
				musicPlaying: false,
				musicAvailable: true,
				notificationsAvailable: true,
				notification: {
					id: "n1",
					kind: "notification",
					summary: "<b>Captura</b>",
					expiresAt: Date.now() + 5000,
				},
			},
		},
		contextReady: ready,
		openContext: open,
		dismissContext: vi.fn(),
	} as unknown as DesktopCompanionControls;
	const view = render(<DesktopCompanionBubble controls={controls} />);
	expect(ready).not.toHaveBeenCalled();
	expect(screen.getByText("<b>Captura</b>").querySelector("b")).toBeNull();
	act(() => vi.advanceTimersByTime(40));
	expect(ready).toHaveBeenCalledWith("n1");
	expect(open).not.toHaveBeenCalled();
	view.rerender(
		<DesktopCompanionBubble
			controls={{
				...controls,
				state: {
					...controls.state,
					context: {
						...controls.state.context!,
						notification: undefined,
						cue: { id: "q1", paneId: "p1", sessionId: "s1", kind: "question", expiresAt: Date.now() + 5000 },
					},
				},
			}}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: /Abrir sesión en Herdr:/ }));
	expect(open).toHaveBeenCalledTimes(1);
});

it("clears only the session cue it owns when work ends or its connection fails", async () => {
	const publish = vi.fn().mockResolvedValue(undefined);
	const controls = {
		state: DEFAULT_DESKTOP_COMPANION,
		context: publish,
	} as unknown as DesktopCompanionControls;
	const data = snapshot();
	const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => structuredClone(data) });
	vi.stubGlobal("fetch", fetcher);
	const info = { url: "ws://127.0.0.1:4317/ws", token: "fixture" };
	const hook = renderHook(() => useDesktopSessionContext(info, controls, true));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1);
	});
	expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ id: "question:q2", kind: "question" }));
	data.sessions = [];
	await act(async () => {
		await vi.advanceTimersByTimeAsync(750);
	});
	expect(publish).toHaveBeenLastCalledWith({ id: "question:q2", kind: "rest" });
	data.sessions = snapshot().sessions.slice(0, 1);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(750);
	});
	expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ id: "working:s1", kind: "working" }));
	fetcher.mockRejectedValue(new Error("offline"));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(750);
	});
	expect(publish).toHaveBeenLastCalledWith({ id: "working:s1", kind: "rest" });
	hook.unmount();
});

it("retries a question after native delivery fails without marking it as already announced", async () => {
	const data = snapshot();
	const publish = vi.fn().mockRejectedValue(new Error("native unavailable"));
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation(async () => ({
			ok: true,
			json: async () => ({ ...structuredClone(data), observedAt: new Date().toISOString() }),
		})),
	);
	const controls = {
		state: DEFAULT_DESKTOP_COMPANION,
		context: publish,
	} as unknown as DesktopCompanionControls;
	const hook = renderHook(() =>
		useDesktopSessionContext({ url: "ws://127.0.0.1:4317/ws", token: "fixture" }, controls, true),
	);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(9000);
	});
	publish.mockResolvedValue(undefined);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(750);
	});
	expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ id: "question:q2", kind: "question" }));
	hook.unmount();
});

it("clears a cue whose native publication finishes after its surface is disabled", async () => {
	let resolve: (() => void) | undefined;
	const publish = vi
		.fn()
		.mockImplementationOnce(
			() =>
				new Promise<void>((done) => {
					resolve = done;
				}),
		)
		.mockResolvedValue(undefined);
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => snapshot() }));
	const controls = {
		state: DEFAULT_DESKTOP_COMPANION,
		context: publish,
	} as unknown as DesktopCompanionControls;
	const hook = renderHook(() =>
		useDesktopSessionContext({ url: "ws://127.0.0.1:4317/ws", token: "fixture" }, controls, true),
	);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1);
	});
	hook.unmount();
	await act(async () => {
		resolve?.();
		await Promise.resolve();
	});
	expect(publish).toHaveBeenLastCalledWith({ id: "question:q2", kind: "rest" });
});
