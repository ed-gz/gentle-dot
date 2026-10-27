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

it.each([
	{ source: { appName: "Hyprshot" }, summary: "Screenshot copied to clipboard" },
	{ source: { appName: "grimblast" }, summary: "Copied" },
	{ source: { appName: "flameshot" }, summary: "Saved and copied" },
	{ source: { desktopEntry: "org.kde.spectacle" }, summary: "Image saved" },
	{ source: { appName: "gnome-screenshot" }, summary: "Saved" },
	{ summary: "Captura guardada" },
	{ summary: "Screenshot Saved" },
	{ kind: "capture" as const, source: { appName: "Screenshot" }, summary: "Screenshot Saved" },
	{ summary: "Captura guardada y copiada" },
])("minimizes screenshot presentation: $summary", (patch) => {
	expect(notificationPresentation(notification({ ...patch, body: "File: Screenshot_2026.png\nFolder: /Pictures/Screenshots" }))).toEqual({
		summary: "📁 Captura copiada", body: undefined, quoted: false, showMore: false, confirmation: false,
	});
});

it.each([
 { summary: "Screenshot failed", source: { appName: "Hyprshot" } },
 { summary: "Authentication required", source: { appName: "Screenshot" } },
 { summary: "Missing Dependencies", source: { appName: "Screenshot System" } },
 { summary: "Nuevo mensaje en General", source: { appName: "Slack" }, body: "Alex Rivera: Screenshot Saved" },
 { summary: "Build complete", body: "Saved /Pictures/Screenshots/a.png" },
])("does not minimize unrelated messages or screenshot failures: $summary", (patch) => {
 expect(notificationPresentation(notification(patch)).showMore).toBeUndefined();
});

it("does not claim copying when a screenshot was only saved", () => {
 expect(notificationPresentation(notification({ summary: "Screenshot saved, not copied", body: "Clipboard unavailable" }))).toEqual({summary:"📁 Captura guardada",body:undefined,quoted:false,showMore:false,confirmation:false});
});

it("exposes only evidence-backed sender/channel/private metadata", () => {
 const cue=notification({source:{appName:"Slack",sender:"Leslie",conversation:"#distribución"},summary:"Nuevo mensaje en #distribución",body:"¿Me ayudas?"});
 expect(notificationPresentation(cue)).toMatchObject({sender:"Leslie",channel:"#distribución",body:"¿Me ayudas?"});
 expect(notificationPresentation({...cue,source:{appName:"Slack",sender:"Leslie",conversation:"privado"}})).toMatchObject({sender:"Leslie",privateMessage:true});
 const unknown=notificationPresentation({...cue,source:{appName:"Slack",sender:"Leslie"},summary:"Nuevo mensaje en…"});
 expect(unknown.privateMessage).toBeUndefined();expect(unknown.channel).toBeUndefined();
});
it.each(["Chrome", "Slack"])("keeps %s message text out of structured identity and destination metadata", (appName) => {
 const body="Acceso denegado: vuelve a iniciar sesión";
 const cue=notification({source:{appName},summary:"Nuevo mensaje en #ops",body});
 expect(notificationPresentation(cue)).toEqual({summary:`Te llegó un mensaje${appName === "Slack" ? " en Slack" : ""}.`,body,quoted:true});
 const explicitSender=notificationPresentation({...cue,source:{appName,sender:"Leslie"}});
 expect(explicitSender.sender).toBe("Leslie");
 expect(explicitSender.channel).toBeUndefined();
 expect(explicitSender.privateMessage).toBeUndefined();
 for (const summary of ["Nuevo mensaje en privado", "Nuevo mensaje en Leslie"]) {
  const message=notificationPresentation({...cue,summary,source:{appName,sender:"Leslie"}});
  expect(message.channel).toBeUndefined();
  expect(message.privateMessage).toBeUndefined();
  expect(message.body).toBe(body);
 }
});
it("marks session completion, not questions or errors, as confirmed",()=>{
 expect(notificationPresentation(notification({summary:"La sesión «Portal B2B» terminó."})).confirmation).toBe(true);
 expect(notificationPresentation(notification({kind:"question",summary:"La sesión «Portal B2B» terminó."})).confirmation).toBeUndefined();
 expect(notificationPresentation(notification({summary:"La sesión falló"})).confirmation).toBeUndefined();
});
it("pins a regular notification's existing presentation", () => {
	expect(notificationPresentation(notification({ summary: "Build complete", body: "All checks passed" }))).toEqual({
		summary: "Build complete", body: "All checks passed", quoted: false,
	});
});

it("keeps Alex's words quoted and attributes the introduction to her actual source", () => {
	const cue = notification({
		source: { appName: "Slack", sender: "Alex Rivera" },
		body: "La revisión está lista. Gracias",
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
	expect(screen.getByText("Alex Rivera te escribió en Slack.")).toBeInTheDocument();
	expect(view.container.querySelector("blockquote")).toHaveTextContent("«La revisión está lista. Gracias»");
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

it("classifies the Slack wrapper without inferring identity or stripping source text", () => {
	const cue = notification({
		source: { appName: "Slack" },
		summary: "Nuevo mensaje en…",
		body: "Alex Rivera: La revisión está lista. Gracias",
	});
	expect(notificationPresentation(cue)).toEqual({
		summary: "Te llegó un mensaje en Slack.",
		body: "Alex Rivera: La revisión está lista. Gracias",
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

it("classifies the web-message wrapper without inventing a sender or the browser's website", () => {
	const message = notification({
		source: { appName: "Google Chrome", desktopEntry: "google-chrome" },
		summary: "Nuevo mensaje en...",
		body: "Alex Rivera: La revisión está lista. Gracias",
	});
	expect(notificationPresentation(message)).toEqual({
		summary: "Te llegó un mensaje.",
		body: "Alex Rivera: La revisión está lista. Gracias",
		quoted: true,
	});
	expect(notificationPresentation({ ...message, summary: "Error de autenticación" })).toEqual({
		summary: "Te llegó una notificación.",
		body: "Error de autenticación\nAlex Rivera: La revisión está lista. Gracias",
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
