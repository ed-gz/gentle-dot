import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	isVisualNotification,
	notificationPresentation,
	spokenCompanionCue,
} from "../src/companion-notification.ts";
import { DesktopCompanionBubble } from "../src/components/DesktopCompanionBubble.tsx";
import { DesktopCompanionSurface } from "../src/components/DesktopCompanionSurface.tsx";
import {
	DEFAULT_DESKTOP_COMPANION,
	type DesktopCompanionControls,
	type DesktopCompanionCue,
	parseDesktopCompanion,
} from "../src/desktop-companion.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
const notification = (patch: Partial<DesktopCompanionCue> = {}): DesktopCompanionCue => ({
	id: "message",
	kind: "notification",
	expiresAt: Date.now() + 8000,
	...patch,
});

it("keeps Leslie's words quoted and attributes the introduction to her actual source", () => {
	const cue = notification({
		source: { appName: "Slack", sender: "Leslie Alanis" },
		body: "Sí, ya me dejó! Gracias",
	});
	const ready = vi.fn().mockResolvedValue(undefined);
	const controls = {
		state: {
			...DEFAULT_DESKTOP_COMPANION,
			enabled: true,
			context: {
				musicPlaying: false,
				musicAvailable: false,
				notificationsAvailable: true,
				notification: cue,
			},
		},
		contextReady: ready,
	} as unknown as DesktopCompanionControls;
	const view = render(<DesktopCompanionBubble controls={controls} />);
	expect(screen.getByText("Leslie Alanis te escribió en Slack.")).toBeInTheDocument();
	expect(view.container.querySelector("blockquote")).toHaveTextContent("«Sí, ya me dejó! Gracias»");
	expect(ready).not.toHaveBeenCalled();
	act(() => vi.advanceTimersByTime(40));
	expect(ready).toHaveBeenCalledWith("message");
});

it("never invents a sender from colon-containing text or confuses a source message with Capri", () => {
	const message = notificationPresentation(
		notification({ source: { appName: "Slack" }, body: "Incidente: captura fallida" }),
	);
	expect(message).toEqual({
		summary: "Slack te avisa.",
		body: "Incidente: captura fallida",
		quoted: true,
	});
	expect(
		notificationPresentation(notification({ source: { appName: "ChatGPT" }, body: "Listo" })).summary,
	).toBe("ChatGPT te avisa.");
});

it("recognizes the reported Slack envelope while leaving unrelated titles and source messages intact", () => {
	const cue = notification({
		source: { appName: "Slack" },
		summary: "Nuevo mensaje en…",
		body: "Leslie Alanis: Sí, ya me dejó! Gracias",
	});
	expect(notificationPresentation(cue)).toEqual({
		summary: "Leslie Alanis te escribió en Slack.",
		body: "Sí, ya me dejó! Gracias",
		quoted: true,
	});
	expect(notificationPresentation({ ...cue, source: { appName: "Downloads" } }).summary).toBe(
		"Downloads te avisa.",
	);
	expect(notificationPresentation({ ...cue, summary: "Aviso" }).body).toBe(`Aviso\n${cue.body}`);
	expect(notificationPresentation({ ...cue, body: "https://example.com" }).summary).toBe(
		"Te llegó un mensaje en Slack.",
	);
	expect(notificationPresentation({ ...cue, body: "Incidente: captura fallida" }).summary).toBe(
		"Te llegó un mensaje en Slack.",
	);
});

it("preserves important title information and keeps questions visible during visual notifications", () => {
	const cue = notification({
		source: { appName: "Slack" },
		summary: "Authentication required",
		body: "Click here",
	});
	expect(notificationPresentation(cue).body).toBe("Authentication required\nClick here");
	const question = notification({ id: "question", kind: "question", summary: "¿Continuar?" });
	expect(
		spokenCompanionCue({
			musicPlaying: false,
			musicAvailable: false,
			notificationsAvailable: true,
			notification: notification({ kind: "capture", summary: "Screenshot Saved" }),
			cue: question,
		}),
	).toBe(question);
});

it("acknowledges a file only from its decoded visual gesture and never while a question has priority", () => {
	const images: { onload?: () => void; complete: boolean; naturalWidth: number }[] = [];
	vi.spyOn(document, "hidden", "get").mockReturnValue(false);
	vi.stubGlobal(
		"Image",
		class {
			src = "";
			complete = false;
			naturalWidth = 0;
			constructor() {
				images.push(this);
			}
		},
	);
	const ready = vi.fn().mockResolvedValue(undefined);
	const controls = {
		state: {
			...DEFAULT_DESKTOP_COMPANION,
			enabled: true,
			visible: true,
			context: {
				musicPlaying: false,
				musicAvailable: false,
				notificationsAvailable: true,
				notification: notification({ kind: "capture", summary: "Screenshot Saved" }),
			},
		},
		contextReady: ready,
		interact: vi.fn().mockResolvedValue(undefined),
	} as unknown as DesktopCompanionControls;
	const view = render(
		<DesktopCompanionSurface
			controls={controls}
			agentState="idle"
			connected
			toggle={() => {}}
			startDrag={() => {}}
		/>,
	);
	act(() => vi.advanceTimersByTime(100));
	expect(ready).not.toHaveBeenCalled();
	act(() => {
		const image = images.find((item) => item.onload)!;
		image.complete = true;
		image.naturalWidth = 1536;
		image.onload?.();
	});
	act(() => vi.advanceTimersByTime(40));
	expect(ready).toHaveBeenCalledExactlyOnceWith("message");
	// The native ready response republishes state. It must not create a paint/ACK feedback loop.
	controls.state = { ...controls.state, context: structuredClone(controls.state.context) };
	view.rerender(
		<DesktopCompanionSurface
			controls={controls}
			agentState="idle"
			connected
			toggle={() => {}}
			startDrag={() => {}}
		/>,
	);
	act(() => vi.advanceTimersByTime(200));
	expect(ready).toHaveBeenCalledTimes(1);
	ready.mockClear();
	controls.state.context!.notification = notification({
		id: "second",
		kind: "download",
		summary: "Download complete",
	});
	controls.state.context!.cue = notification({
		id: "question",
		kind: "question",
		summary: "¿Continuar?",
		paneId: "p",
		sessionId: "s",
	});
	view.rerender(
		<DesktopCompanionSurface
			controls={controls}
			agentState="idle"
			connected
			toggle={() => {}}
			startDrag={() => {}}
		/>,
	);
	expect(view.container.querySelector("button")).toHaveAttribute("data-attention", "true");
	act(() => {
		for (const image of images) {
			image.complete = true;
			image.naturalWidth = 1536;
			image.onload?.();
		}
	});
	act(() => vi.advanceTimersByTime(500));
	expect(ready).not.toHaveBeenCalled();
	view.unmount();
	const bubble = render(<DesktopCompanionBubble controls={controls} />);
	expect(bubble.container).toHaveTextContent("¿Continuar?");
	act(() => vi.advanceTimersByTime(100));
	expect(ready).not.toHaveBeenCalled();
});

it.each(["capture", "download"] as const)(
	"never paints or acknowledges a %s from the speech window",
	(kind) => {
		const ready = vi.fn().mockResolvedValue(undefined);
		const cue = notification({ kind, summary: "Saved" });
		const controls = {
			state: {
				...DEFAULT_DESKTOP_COMPANION,
				enabled: true,
				context: {
					musicPlaying: false,
					musicAvailable: false,
					notificationsAvailable: true,
					notification: cue,
				},
			},
			contextReady: ready,
		} as unknown as DesktopCompanionControls;
		const view = render(<DesktopCompanionBubble controls={controls} />);
		expect(isVisualNotification(cue)).toBe(true);
		expect(view.container.querySelector("aside")).toHaveAttribute("data-visible", "false");
		act(() => vi.advanceTimersByTime(1000));
		expect(ready).not.toHaveBeenCalled();
	},
);

it("bounds and validates source metadata without accepting arbitrary structures", () => {
	const state = parseDesktopCompanion({
		...DEFAULT_DESKTOP_COMPANION,
		context: {
			notification: notification({
				source: { appName: " Slack\u0000 ", sender: "L".repeat(300), category: 12 } as never,
			}),
		},
	});
	expect(state.context?.notification?.source).toEqual({ appName: "Slack", sender: "L".repeat(128) });
});

it("attributes the reported web-message wrapper without inventing the browser's website", () => {
	const message = notification({
		source: { appName: "Google Chrome", desktopEntry: "google-chrome" },
		summary: "Nuevo mensaje en...",
		body: "Leslie Alanis: Sí, ya me dejó! Gracias",
	});
	expect(notificationPresentation(message)).toEqual({
		summary: "Leslie Alanis te escribió.",
		body: "Sí, ya me dejó! Gracias",
		quoted: true,
	});
	expect(notificationPresentation({ ...message, summary: "Error de autenticación" })).toEqual({
		summary: "Te llegó una notificación.",
		body: "Error de autenticación\nLeslie Alanis: Sí, ya me dejó! Gracias",
		quoted: true,
	});
});

it("preloads the action atlas once without acknowledging a notification", () => {
	const decode = vi.fn().mockResolvedValue(undefined);
	const loaded: { src: string }[] = [];
	vi.stubGlobal(
		"Image",
		class {
			src = "";
			decode = decode;
			constructor() {
				loaded.push(this);
			}
		},
	);
	const ready = vi.fn().mockResolvedValue(undefined);
	const controls = {
		state: { ...DEFAULT_DESKTOP_COMPANION, enabled: true, visible: true },
		contextReady: ready,
		interact: vi.fn().mockResolvedValue(undefined),
	} as unknown as DesktopCompanionControls;
	const view = render(
		<DesktopCompanionSurface
			controls={controls}
			agentState="idle"
			connected
			toggle={() => {}}
			startDrag={() => {}}
		/>,
	);
	expect(loaded.some((image) => image.src.includes("capri-motion-actions-v1"))).toBe(true);
	expect(decode).toHaveBeenCalledTimes(1);
	act(() => vi.advanceTimersByTime(100));
	expect(ready).not.toHaveBeenCalled();
	view.rerender(
		<DesktopCompanionSurface
			controls={{ ...controls }}
			agentState="idle"
			connected
			toggle={() => {}}
			startDrag={() => {}}
		/>,
	);
	expect(decode).toHaveBeenCalledTimes(1);
});
