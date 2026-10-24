import type { AgentState } from "@gentle-dot/protocol";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sceneForActivity } from "../src/capri-scenes.ts";
import { CapriCompanion, CompanionSettings } from "../src/components/CapriCompanion.tsx";
import { COMPANION_KEY, useCompanion } from "../src/useCompanion.ts";

beforeEach(() => {
	vi.spyOn(document, "hidden", "get").mockReturnValue(false);
	localStorage.setItem(COMPANION_KEY, JSON.stringify({ mode: "capri", form: "body", company: "visits" }));
});
afterEach(() => {
	localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
function Stage({ state = "idle", connected = true }: { state?: AgentState; connected?: boolean }) {
	const controls = useCompanion();
	return <CapriCompanion controls={controls} state={state} connected={connected} sessions />;
}
const pose = () => document.querySelector(".capri-float .capri-sprite")?.getAttribute("data-pose");

it("invites Rebecca before they watch together and then share coffee", () => {
	vi.useFakeTimers();
	render(<Stage state="working" />);
	act(() => vi.advanceTimersByTime(36_000));
	expect(pose()).toBe("invite-rebecca");
	expect(screen.getByLabelText("Capri y Rebecca, tus acompañantes")).toHaveTextContent("Rebecca, ven");
	act(() => vi.advanceTimersByTime(12_000));
	expect(pose()).toBe("duo-watch");
	act(() => vi.advanceTimersByTime(12_000));
	expect(pose()).toBe("duo-coffee");
});

it("pauses scene cycling in a hidden app and resumes on return", () => {
	vi.useFakeTimers();
	const hidden = vi.spyOn(document, "hidden", "get");
	render(<Stage />);
	act(() => vi.advanceTimersByTime(36_000));
	expect(pose()).toBe("invite-rebecca");
	hidden.mockReturnValue(true);
	fireEvent(document, new Event("visibilitychange"));
	act(() => vi.advanceTimersByTime(60_000));
	expect(pose()).toBe("invite-rebecca");
	hidden.mockReturnValue(false);
	fireEvent(document, new Event("visibilitychange"));
	act(() => vi.advanceTimersByTime(12_000));
	expect(pose()).toBe("duo-watch");
});

it("disables autonomous scene changes and blinking for reduced motion", () => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
	render(<Stage />);
	act(() => vi.advanceTimersByTime(5000));
	const initial = pose();
	act(() => vi.advanceTimersByTime(60_000));
	expect(pose()).toBe(initial);
	expect(screen.getByLabelText("Capri, tu acompañante")).toHaveAttribute("data-motion", "false");
});

it("migrates a fixed pose to autonomy and keeps questions and connection status authoritative", () => {
	localStorage.setItem(COMPANION_KEY, JSON.stringify({ mode: "capri", form: "body", scene: "angry" }));
	const view = render(<Stage />);
	expect(pose()).toBe("greeting");
	view.rerender(<Stage state="needs_you" />);
	expect(pose()).toBe("alert");
	expect(screen.getByLabelText("Capri, tu acompañante")).toHaveTextContent("Hay una pregunta para ti");
	view.rerender(<Stage connected={false} />);
	expect(pose()).toBe("sleep");
	expect(screen.getByLabelText("Capri, tu acompañante")).toHaveTextContent("Esperando conexión");
});

it("typing and voice cannot replace a pending question or disconnected pose", () => {
	localStorage.setItem(COMPANION_KEY, JSON.stringify({ mode: "capri", form: "auto" }));
	function Fixture({ connected = true }: { connected?: boolean }) {
		const controls = useCompanion();
		return (
			<>
				<textarea aria-label="Borrador" />
				<CapriCompanion controls={controls} state="needs_you" connected={connected} speaking />
			</>
		);
	}
	const view = render(<Fixture />);
	fireEvent.input(screen.getByRole("textbox"), { target: { value: "No enviar" } });
	expect(pose()).toBe("alert");
	view.rerender(<Fixture connected={false} />);
	expect(pose()).toBe("sleep");
});

it("keeps a small typing pose when keyboard scrolling happens in the focused editor", () => {
	function Fixture() {
		const controls = useCompanion();
		return (
			<>
				<textarea aria-label="Borrador" />
				<CapriCompanion controls={controls} state="idle" connected sessions />
			</>
		);
	}
	render(<Fixture />);
	const editor = screen.getByRole("textbox");
	editor.focus();
	fireEvent.input(editor, { target: { value: "Estoy escribiendo" } });
	expect(pose()).toBe("eyes");
	fireEvent.scroll(document);
	expect(pose()).toBe("eyes");
	editor.blur();
	fireEvent.scroll(document);
	expect(pose()).toBe("reading");
});

it("chooses its own forms without exposing a pose gallery or manual selectors", () => {
	vi.useFakeTimers();
	localStorage.setItem(
		COMPANION_KEY,
		JSON.stringify({ mode: "capri", form: "body", scene: "crying", company: "rebecca" }),
	);
	function Settings() {
		const controls = useCompanion();
		return (
			<>
				<CompanionSettings controls={controls} />
				<CapriCompanion controls={controls} state="idle" connected sessions />
			</>
		);
	}
	render(<Settings />);
	expect(pose()).toBe("greeting");
	expect(screen.queryByRole("combobox", { name: "Forma" })).not.toBeInTheDocument();
	expect(screen.queryByRole("combobox", { name: "Posición" })).not.toBeInTheDocument();
	expect(screen.queryByRole("combobox", { name: "Compañía" })).not.toBeInTheDocument();
	expect(screen.queryByRole("button", { name: "Las formas de Capri" })).not.toBeInTheDocument();
	act(() => vi.advanceTimersByTime(36_000));
	expect(pose()).toBe("invite-rebecca");
	act(() => vi.advanceTimersByTime(60_000));
	expect(pose()).toBe("eyes");
	expect(screen.getByLabelText("Capri, tu acompañante")).toHaveAttribute("data-form", "glimpse");
});

it("uses verified terminal mood events only for a known local palette", () => {
	const { result } = renderHook(() => useCompanion());
	act(() =>
		window.dispatchEvent(
			new CustomEvent("gentle-dot-terminal-mood", { detail: { mood: "hacker", paneId: "w1:p1" } }),
		),
	);
	expect(result.current.settings.ambience).toBe("hacker");
	act(() =>
		window.dispatchEvent(new CustomEvent("gentle-dot-terminal-mood", { detail: { mood: "url(invalid)" } })),
	);
	expect(result.current.settings.ambience).toBe("hacker");
	act(() => window.dispatchEvent(new CustomEvent("gentle-dot-terminal-mood", { detail: { mood: null } })));
	expect(result.current.settings.ambience).toBe("default");
});

it("closing the floating controls with Escape does not also dismiss the desktop panel", () => {
	render(<Stage />);
	fireEvent.click(screen.getByRole("button", { name: "Mover a Capri" }));
	const dismissPanel = vi.fn();
	window.addEventListener("keydown", dismissPanel);
	try {
		const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		fireEvent(screen.getByRole("button", { name: "Cerrar controles de Capri" }), event);
		expect(screen.queryByRole("group", { name: "Controles de Capri" })).not.toBeInTheDocument();
		expect(event.defaultPrevented).toBe(true);
		expect(dismissPanel).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Mover a Capri" })).toHaveFocus();
	} finally {
		window.removeEventListener("keydown", dismissPanel);
	}
});

it("Escape closes Capri controls inside a modal without reaching the underlying dialog", () => {
	const dialog = document.createElement("dialog");
	dialog.open = true;
	const host = document.createElement("div");
	dialog.append(host);
	document.body.append(dialog);
	function Fixture() {
		const controls = useCompanion();
		return <CapriCompanion controls={controls} state="idle" connected portalHost={host} />;
	}
	const dismiss = vi.fn();
	window.addEventListener("keydown", dismiss);
	const view = render(<Fixture />);
	try {
		fireEvent.click(screen.getByRole("button", { name: "Mover a Capri" }));
		const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		fireEvent(screen.getByRole("button", { name: "Cerrar controles de Capri" }), event);
		expect(screen.queryByRole("group", { name: "Controles de Capri" })).not.toBeInTheDocument();
		expect(event.defaultPrevented).toBe(true);
		expect(dismiss).not.toHaveBeenCalled();
	} finally {
		view.unmount();
		window.removeEventListener("keydown", dismiss);
		dialog.remove();
	}
});

it("never shows detached pointing hands without a concrete target", () => {
	for (const sessions of [false, true])
		for (let phase = 0; phase < 120; phase++) {
			const scene = sceneForActivity({
				state: "idle",
				connected: true,
				attention: false,
				sessions,
				interaction: "rest",
				company: "visits",
				phase,
				scene: "auto",
				celebrate: false,
			});
			expect(scene.startsWith("point-")).toBe(false);
		}
});
