import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	approvalAnswerError,
	DesktopCompanionLauncher,
	DesktopCompanionSurface,
} from "../src/components/DesktopCompanionSurface.tsx";
import { DotSurface } from "../src/components/DotSurface.tsx";
import type { DesktopCompanionControls } from "../src/desktop-companion.ts";

it.each([
 "La pregunta cambió", "Sesión no disponible", "Esta solicitud venció. Actualiza la sesión antes de responder.",
 "No se puede conectar con HERDR o la sesión de Pi.", "La sesión cerró la conexión antes de responder.",
 "La conexión local no respondió a tiempo.", "Falló la conexión con los agentes (503).",
 "El equipo devolvió un estado de agentes no válido.",
])("preserves the app approval failure: %s", message => {
 expect(approvalAnswerError(new Error(message))).toEqual(new Error(message));
});
it.each([new Error("boom /home/secret"), new TypeError("Failed to fetch"), new Error(""), "La pregunta cambió", null, {message:"adapter internals"}])("normalizes untrusted approval failure %s", error => {
 expect(approvalAnswerError(error)).toEqual(new Error("No se pudo responder con la sesión. Volvé a intentarlo o abrí el panel."));
});

const quickEntry = vi.hoisted(() => ({ active: false, handlers: new Map<string, () => void>() }));
vi.mock("@tauri-apps/api/core", async importOriginal => ({
 ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
 isTauri: () => quickEntry.active,
 invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name: string, handler: () => void) => {
 quickEntry.handlers.set(name, handler);
 return () => { quickEntry.handlers.delete(name); };
}) }));
vi.mock("../src/capri3d/Capri3D.tsx", async () => {
 const { useEffect } = await import("react");
 return { Capri3D: ({onActive}: {onActive(active: boolean): void}) => {
  useEffect(() => { if (quickEntry.active) onActive(true); }, [onActive]);
  return null;
 } };
});

it.each(["3d", "2d"] as const)("SUPER+C toggles quick entry closed in %s mode; history only via its own button; Escape only closes entry", async renderMode => {
 quickEntry.active = true;
 const toggle = vi.fn();
 const view = render(<DesktopCompanionSurface controls={controls({renderMode})} agentState="idle" connected toggle={toggle} startDrag={vi.fn()} />);
 await act(async () => {});
 expect(screen.queryByRole("textbox", {name:"Mensaje para Dot"})).not.toBeInTheDocument();
 expect(quickEntry.handlers.has("dot://capri-message")).toBe(true);
 act(() => quickEntry.handlers.get("dot://capri-message")!());
 expect(screen.getByRole("textbox", {name:"Mensaje para Dot"})).toHaveFocus();
 expect(toggle).not.toHaveBeenCalled();
 act(() => quickEntry.handlers.get("dot://capri-message")!());
 expect(screen.queryByRole("textbox", {name:"Mensaje para Dot"})).not.toBeInTheDocument();
 expect(toggle).not.toHaveBeenCalled();
 act(() => quickEntry.handlers.get("dot://capri-message")!());
 view.unmount();
 expect(quickEntry.handlers.has("dot://capri-message")).toBe(false);
});

vi.mock("../src/capri2d/Capri2D.tsx", async () => {
 const { selectAct } = await import("../src/capri2d/director.ts");
 const { useEffect } = await import("react");
 return { Capri2D: ({intent = {}, onActive}: {intent?: import("../src/capri2d/director.ts").RigIntent; onActive(active: boolean): void}) => {
  useEffect(() => { if (quickEntry.active) onActive(true); }, [onActive]);
  return <canvas data-testid="capri2d" data-act={selectAct(intent)} />;
 } };
});
it("drives the 2D acts from completion, failure and a sustained question", () => {
 const value = controls({renderMode:"2d"});
 const props = {controls:value,connected:true,toggle:vi.fn(),startDrag:vi.fn()};
 const view=render(<DesktopCompanionSurface {...props} agentState="working" />);
 view.rerender(<DesktopCompanionSurface {...props} agentState="idle" />);
 expect(screen.getByTestId("capri2d")).toHaveAttribute("data-act","victory");
 view.rerender(<DesktopCompanionSurface {...props} agentState="error" />);
 expect(screen.getByTestId("capri2d")).toHaveAttribute("data-act","hurt");
 view.rerender(<DesktopCompanionSurface {...props} controls={controls({renderMode:"2d",context:{musicPlaying:false,musicAvailable:false,notificationsAvailable:false,cue:{kind:"question",id:"q",paneId:"p",sessionId:"s",expiresAt:Date.now()+30000}}})} agentState="needs_you" />);
 expect(screen.getByTestId("capri2d")).toHaveAttribute("data-act","point");
 act(()=>vi.advanceTimersByTime(10000));
 expect(screen.getByTestId("capri2d")).toHaveAttribute("data-act","point");
});
it.each(["2d", "sprites", "3d"] as const)("mounts Capri2D only for render mode %s", renderMode => {
 const view = render(<DesktopCompanionSurface controls={controls({ renderMode })} agentState="idle" connected toggle={vi.fn()} startDrag={vi.fn()} />);
 expect(view.queryByTestId("capri2d") !== null).toBe(renderMode === "2d");
});

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(document, "hidden", "get").mockReturnValue(false);
	vi.stubGlobal(
		"PointerEvent",
		class extends MouseEvent {
			readonly pointerId: number;
			readonly isPrimary: boolean;
			constructor(type: string, init: PointerEventInit = {}) {
				super(type, init);
				this.pointerId = init.pointerId ?? 1;
				this.isPrimary = init.isPrimary ?? true;
			}
		},
	);
});
afterEach(() => {
 quickEntry.active = false;
 quickEntry.handlers.clear();
	localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
it.each(["notification", "capture"] as const)("uses minimal screenshot text on the %s surface", (kind) => {
 const value = controls({ context: { musicPlaying: false, musicAvailable: false, notificationsAvailable: true,
  notification: { id: "shot", kind, summary: "Screenshot Saved", body: "File: Screenshot_2026.png\nFolder: /Pictures/Screenshots", source: { appName: "Screenshot" }, expiresAt: Date.now() + 8000 },
 } });
 const { button } = setup(value);
 expect(button).toHaveAccessibleName("Capri: Captura tomada y copiada. Abrir conversación");
 expect(button.getAttribute("aria-label")).not.toContain("Screenshot_2026");
 expect(screen.queryByText("Ver más")).not.toBeInTheDocument();
});

it("never drags or nudges a pinned companion, but keeps click-to-chat", () => {
 const control = controls({ pinned: true });
 const startDrag = vi.fn(), toggle = vi.fn();
 render(<DesktopCompanionSurface controls={control} agentState="idle" connected toggle={toggle} startDrag={startDrag} />);
 const button = screen.getByRole("button", { name: /Abrir conversación/ });
 fireEvent.pointerDown(button, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
 fireEvent.pointerMove(button, { pointerId: 1, clientX: 40, clientY: 10 });
 fireEvent.pointerUp(button, { pointerId: 1 });
 fireEvent.keyDown(button, { key: "ArrowRight" });
 expect(startDrag).not.toHaveBeenCalled();
 expect(control.move).not.toHaveBeenCalled();
 fireEvent.click(button);
 expect(toggle).toHaveBeenCalledOnce();
});
function controls(patch: Partial<DesktopCompanionControls["state"]> = {}): DesktopCompanionControls {
	return {
		state: {
			enabled: true,
			motion: true,
			appearances: true,
			visible: true,
			paused: false,
			available: true,
			pinned: false,
			areas: [],
			monitors: [],
			...patch,
		},
		pending: false,
		change: vi.fn().mockResolvedValue(undefined),
		interact: vi.fn().mockResolvedValue(undefined),
		recall: vi.fn().mockResolvedValue(undefined),
		hide: vi.fn().mockResolvedValue(undefined),
		menu: vi.fn().mockResolvedValue(undefined),
		move: vi.fn().mockResolvedValue(undefined),
	};
}
function setup(value = controls()) {
	const toggle = vi.fn(),
		startDrag = vi.fn().mockResolvedValue(undefined);
	const view = render(
		<DesktopCompanionSurface
			controls={value}
			agentState="idle"
			connected
			toggle={toggle}
			startDrag={startDrag}
		/>,
	);
	return { value, toggle, startDrag, view, button: screen.getByRole("button") };
}

it.each([["run", "working"], ["read", "reading"], ["edit", "typing"], ["thinking", "thinking"]] as const)("renders the %s action pose", (actionKind, pose) => {
 const { container } = render(<DesktopCompanionSurface controls={controls()} agentState="working" actionKind={actionKind} connected toggle={vi.fn()} startDrag={vi.fn()} />);
 expect(container.querySelector("[data-pose]")).toHaveAttribute("data-pose", pose);
});

it("watches typing without verified editor geometry and without phase changes", () => {
 const { button } = setup(controls({ context: { musicPlaying: false, musicAvailable: false, notificationsAvailable: false, cue: { kind: "typing", id: "typing:test", expiresAt: Date.now() + 90_000 } } }));
 expect(button).toHaveAttribute("data-pose", "eyes");
 act(() => vi.advanceTimersByTime(60_000));
 expect(button).toHaveAttribute("data-pose", "eyes");
});

it("keeps the original rose when desktop Capri is off, regardless of mobile or web mode", () => {
	localStorage.setItem(
		"gentle-dot-companion-v1",
		JSON.stringify({ mode: "capri", motion: false, company: "rebecca" }),
	);
	const storage = vi.spyOn(Storage.prototype, "getItem");
	render(
		<DotSurface
			agentState="idle"
			connected
			toggle={vi.fn()}
			startDrag={vi.fn()}
			desktopCompanion={controls({ enabled: false })}
		/>,
	);
	expect(screen.getByRole("button")).toHaveAccessibleName("Gentle Dot: ready");
	expect(document.querySelector(".rose")).not.toBeNull();
	expect(document.querySelector(".desktop-companion-surface")).toBeNull();
	expect(storage).not.toHaveBeenCalled();
});

it("uses native enabled state and ignores app appearance preferences", () => {
	localStorage.setItem("gentle-dot-companion-v1", JSON.stringify({ mode: "gentle", motion: false }));
	const storage = vi.spyOn(Storage.prototype, "getItem");
	render(
		<DotSurface
			agentState="idle"
			connected
			toggle={vi.fn()}
			startDrag={vi.fn()}
			desktopCompanion={controls()}
		/>,
	);
	expect(screen.getByRole("button")).toHaveClass("desktop-companion-surface");
	expect(screen.getByRole("button")).toHaveAttribute("data-motion", "true");
	expect(document.querySelector(".rose")).toBeNull();
	expect(storage).not.toHaveBeenCalled();
});

it("rests calmly without clock-driven scene rotation", () => {
	const { button } = setup();
	expect(button).toHaveAttribute("data-pose", "idle");
	act(() => vi.advanceTimersByTime(60_000));
	expect(button).toHaveAttribute("data-pose", "idle");
});

it("keeps question and connection poses ahead of ambient scenes", () => {
	const value = controls();
	const props = { controls: value, connected: true, toggle: vi.fn(), startDrag: vi.fn() };
	const view = render(<DesktopCompanionSurface {...props} agentState="needs_you" />);
	expect(screen.getByRole("button")).toHaveAttribute("data-pose", "alert");
	expect(screen.getByRole("button")).toHaveAccessibleName(/Hay una pregunta para ti/);
	expect(screen.queryByText("!")).not.toBeInTheDocument();
	view.rerender(<DesktopCompanionSurface {...props} agentState="needs_you" connected={false} />);
	expect(screen.getByRole("button")).toHaveAttribute("data-pose", "alert");
	expect(screen.getByRole("button")).toHaveAccessibleName(/Sin conexión/);
});

it("combines hover and focus before resuming native movement", () => {
	const { button, value } = setup();
	fireEvent.mouseEnter(button);
	fireEvent.focus(button);
	expect(value.interact).toHaveBeenCalledTimes(1);
	expect(value.interact).toHaveBeenLastCalledWith(true);
	expect(button).toHaveAttribute("data-motion", "false");
	fireEvent.mouseLeave(button);
	expect(value.interact).toHaveBeenCalledTimes(1);
	fireEvent.blur(button);
	expect(value.interact).toHaveBeenLastCalledWith(false);
	expect(button).toHaveAttribute("data-motion", "true");
});

it("uses the native drag threshold and suppresses the pointer click after dragging", async () => {
	const { button, startDrag, toggle, value } = setup();
	button.setPointerCapture = vi.fn();
	button.hasPointerCapture = vi.fn().mockReturnValue(true);
	button.releasePointerCapture = vi.fn();
	fireEvent.pointerDown(button, { pointerId: 1, clientX: 10, clientY: 10, button: 0 });
	fireEvent.pointerMove(button, { pointerId: 1, clientX: 14, clientY: 10 });
	expect(startDrag).not.toHaveBeenCalled();
	fireEvent.pointerMove(button, { pointerId: 1, clientX: 17, clientY: 10 });
	fireEvent.pointerMove(button, { pointerId: 1, clientX: 30, clientY: 10 });
	expect(startDrag).toHaveBeenCalledOnce();
	fireEvent.pointerUp(button, { pointerId: 1 });
	fireEvent.click(button, { detail: 1 });
	expect(toggle).not.toHaveBeenCalled();
	expect(value.interact).toHaveBeenLastCalledWith(false);
	fireEvent.pointerDown(button, { pointerId: 2, clientX: 10, clientY: 10, button: 0 });
	fireEvent.pointerUp(button, { pointerId: 2 });
	fireEvent.click(button, { detail: 1 });
	expect(toggle).toHaveBeenCalledOnce();
	await act(async () => {});
});

it("cancels native interaction on pointer cancel and window blur", () => {
	const { button, value } = setup();
	fireEvent.pointerDown(button, { pointerId: 1, clientX: 10, clientY: 10, button: 0 });
	fireEvent.pointerCancel(button, { pointerId: 1 });
	expect(value.interact).toHaveBeenLastCalledWith(false);
	fireEvent.mouseEnter(button);
	fireEvent.focus(button);
	expect(value.interact).toHaveBeenLastCalledWith(true);
	fireEvent(window, new Event("blur"));
	expect(value.interact).toHaveBeenLastCalledWith(false);
});

it("opens from the keyboard and moves the native window with arrow keys", () => {
	const { button, value, toggle } = setup();
	fireEvent.keyDown(button, { key: "ArrowLeft" });
	expect(value.move).toHaveBeenLastCalledWith(-24, 0);
	fireEvent.keyDown(button, { key: "ArrowDown", shiftKey: true });
	expect(value.move).toHaveBeenLastCalledWith(0, 64);
	expect(toggle).not.toHaveBeenCalled();
	fireEvent.keyDown(button, { key: "Enter" });
	expect(toggle).toHaveBeenCalledOnce();
});

it("has no animation timers while the native window is hidden", () => {
	const value = controls();
	const { view, button } = setup(value);
	fireEvent.mouseEnter(button);
	expect(value.interact).toHaveBeenLastCalledWith(true);
	view.rerender(
		<DesktopCompanionSurface
			controls={{ ...value, state: { ...value.state, visible: false } }}
			agentState="idle"
			connected
			toggle={vi.fn()}
			startDrag={vi.fn()}
		/>,
	);
	expect(value.interact).toHaveBeenLastCalledWith(false);
	expect(button).toHaveAttribute("data-visible", "false");
	expect(vi.getTimerCount()).toBe(0);
	act(() => vi.advanceTimersByTime(120_000));
	expect(button).toHaveAttribute("data-pose", "idle");
});

it("stops timers on document hiding and restarts only after becoming visible", () => {
	const { button } = setup();
	const visibility = vi.spyOn(document, "hidden", "get");
	visibility.mockReturnValue(true);
	act(() => document.dispatchEvent(new Event("visibilitychange")));
	expect(vi.getTimerCount()).toBe(0);
	act(() => vi.advanceTimersByTime(60_000));
	expect(button).toHaveAttribute("data-pose", "idle");
	visibility.mockReturnValue(false);
	act(() => document.dispatchEvent(new Event("visibilitychange")));
	act(() => vi.advanceTimersByTime(12_000));
	expect(button).toHaveAttribute("data-pose", "idle");
});

it("honors reduced motion but keeps gestures alive during native position pauses", () => {
	vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
	const { button, view, value } = setup();
	expect(button).toHaveAttribute("data-motion", "false");
	expect(value.interact).toHaveBeenLastCalledWith(true);
	expect(vi.getTimerCount()).toBe(0);
	view.unmount();
	vi.unstubAllGlobals();
	render(
		<DesktopCompanionSurface
			controls={{ ...value, state: { ...value.state, paused: true } }}
			agentState="idle"
			connected
			toggle={vi.fn()}
			startDrag={vi.fn()}
		/>,
	);
	expect(screen.getByRole("button")).toHaveAttribute("data-motion", "false");
	expect(screen.getByRole("button")).toHaveAttribute("data-animated", "true");
});

it("updates the native pause when the system motion preference changes", () => {
	let change = () => {};
	const query = {
		matches: false,
		addEventListener: (_event: string, callback: () => void) => {
			change = callback;
		},
		removeEventListener() {},
	};
	vi.stubGlobal("matchMedia", () => query);
	const { value, button } = setup();
	act(() => {
		query.matches = true;
		change();
	});
	expect(value.interact).toHaveBeenLastCalledWith(true);
	expect(button).toHaveAttribute("data-motion", "false");
	expect(vi.getTimerCount()).toBe(0);
	fireEvent.mouseEnter(button);
	act(() => {
		query.matches = false;
		change();
	});
	expect(value.interact).toHaveBeenLastCalledWith(true);
	fireEvent.mouseLeave(button);
	expect(value.interact).toHaveBeenLastCalledWith(false);
	expect(button).toHaveAttribute("data-motion", "true");
});

it("reasserts a required native pause if a native update cleared it", () => {
	const value = controls({ paused: true });
	const { button, view } = setup(value);
	fireEvent.mouseEnter(button);
	expect(value.interact).toHaveBeenCalledTimes(1);
	view.rerender(
		<DesktopCompanionSurface
			controls={{ ...value, state: { ...value.state, paused: false } }}
			agentState="idle"
			connected
			toggle={vi.fn()}
			startDrag={vi.fn()}
		/>,
	);
	expect(value.interact).toHaveBeenCalledTimes(2);
	expect(value.interact).toHaveBeenLastCalledWith(true);
	view.rerender(
		<DesktopCompanionSurface
			controls={{ ...value, state: { ...value.state, paused: true } }}
			agentState="idle"
			connected
			toggle={vi.fn()}
			startDrag={vi.fn()}
		/>,
	);
	expect(value.interact).toHaveBeenCalledTimes(2);
});

it("pauses native movement while the assistant controls the computer and exposes the safety status", () => {
	const value = controls();
	render(
		<DesktopCompanionSurface
			controls={value}
			agentState="working"
			connected
			inControl
			yolo
			toggle={vi.fn()}
			startDrag={vi.fn()}
		/>,
	);
	expect(value.interact).toHaveBeenLastCalledWith(true);
	expect(screen.getByRole("button")).toHaveAttribute("data-motion", "false");
	expect(screen.getByRole("button")).toHaveAccessibleName(/Controlando tu equipo.*Modo directo activo/);
	expect(screen.getByRole("button")).toHaveAttribute("data-animated", "true");
});

it("releases an outstanding native interaction when unmounted", () => {
	const { button, value, view } = setup();
	fireEvent.mouseEnter(button);
	view.unmount();
	expect(value.interact).toHaveBeenLastCalledWith(false);
	expect(vi.getTimerCount()).toBe(0);
});

it("keeps the separate launcher static with no preference reads, network calls, or timers", () => {
	const toggle = vi.fn(),
		fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	const storage = vi.spyOn(Storage.prototype, "getItem");
	render(<DesktopCompanionLauncher toggle={toggle} />);
	const launcher = screen.getByRole("button", { name: "Abrir conversación con Capri" });
	expect(launcher.querySelector("[data-pose='face']")).not.toBeNull();
	fireEvent.click(launcher);
	expect(toggle).toHaveBeenCalledOnce();
	expect(storage).not.toHaveBeenCalled();
	expect(fetcher).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});

it("keeps pinned gestures and scenes alive under hover/focus, and offers a native context menu", () => {
	const { button, value } = setup(controls({ pinned: true, paused: true }));
	fireEvent.mouseEnter(button);
	fireEvent.focus(button);
	expect(button).toHaveAttribute("data-motion", "false");
	expect(button).toHaveAttribute("data-animated", "true");
	act(() => vi.advanceTimersByTime(12_000));
	expect(button).toHaveAttribute("data-pose", "idle");
	fireEvent.contextMenu(button);
	expect(value.menu).toHaveBeenCalledOnce();
	fireEvent.keyDown(button, { key: "F10", shiftKey: true });
	expect(value.menu).toHaveBeenCalledTimes(2);
});
