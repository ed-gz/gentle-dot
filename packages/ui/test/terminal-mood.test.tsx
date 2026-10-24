import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalMoodControl } from "../src/components/TerminalMoodControl.tsx";
import { type TerminalMoodClient, type TerminalMoodState, TerminalMoodError } from "../src/terminal-mood.ts";

const state: TerminalMoodState = { available: true, paneId: "pi:one", scope: "window", mood: null,
	canRestore: false, windowId: 7, affectedPaneIds: ["pi:one"], sharedWindow: false, requiresSharedConfirmation: false };
function client(initial = state): TerminalMoodClient {
	return { status: vi.fn(async () => initial), apply: vi.fn(async (paneId, mood) => ({ ...initial, paneId,
		mood: mood === "restore" ? null : mood, canRestore: mood !== "restore", verified: true as const })) };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
async function expand() { await userEvent.click(screen.getByRole("button", { name: "Ambiente de terminal" })); }
afterEach(() => { vi.restoreAllMocks(); });

it("loads only when expanded, applies verified presets and restores without polling", async () => {
	const api = client(); const events = vi.spyOn(window, "dispatchEvent");
	render(<TerminalMoodControl client={api} paneId="pi:one" />);
	expect(api.status).not.toHaveBeenCalled(); await expand();
	await userEvent.click(await screen.findByRole("button", { name: "Hacker Verde eléctrico" }));
	await screen.findByText("Ambiente Hacker aplicado a la ventana.");
	expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "gentle-dot-terminal-mood", detail: { mood: "hacker", paneId: "pi:one" } }));
	expect(screen.getByRole("button", { name: "Hacker Verde eléctrico" })).toHaveAttribute("aria-pressed", "true");
	await userEvent.click(screen.getByRole("button", { name: "Restaurar colores originales" }));
	await screen.findByText("Colores originales restaurados.");
	expect(events).toHaveBeenLastCalledWith(expect.objectContaining({ detail: { mood: null, paneId: "pi:one" } }));
	expect(api.status).toHaveBeenCalledOnce();
	expect(screen.getByRole("button", { name: "Restaurar colores originales" })).toBeDisabled();
});

it("shows every affected pane and requires fresh explicit consent for each shared change", async () => {
	const api = client({ ...state, affectedPaneIds: ["pi:one", "pi:two"], sharedWindow: true, requiresSharedConfirmation: true });
	render(<TerminalMoodControl client={api} paneId="pi:one" paneLabels={{ "pi:one": "Proyecto", "pi:two": "Pruebas" }} />);
	await expand(); await screen.findByText("Sesiones detectadas: Proyecto · Pruebas");
	expect(screen.getByText(/cambiará los colores de todos sus paneles/)).toBeInTheDocument();
	const button = screen.getByRole("button", { name: "Afterlife Violeta y neón" }); expect(button).toBeDisabled();
	fireEvent.click(button); expect(api.apply).not.toHaveBeenCalled();
	await userEvent.click(screen.getByRole("checkbox", { name: /Acepto cambiar/ }));
	await userEvent.click(button); await screen.findByText("Ambiente Afterlife aplicado a la ventana.");
	expect(api.apply).toHaveBeenCalledExactlyOnceWith("pi:one", "afterlife", true, expect.any(AbortSignal));
	expect(screen.getByRole("checkbox")).not.toBeChecked(); expect(button).toBeDisabled();
});

it("refreshes a shared-window conflict and requires consent before a manual retry", async () => {
	const api = client(); const events = vi.spyOn(window, "dispatchEvent");
	vi.mocked(api.apply).mockRejectedValueOnce(new TerminalMoodError("La ventana ahora es compartida.", 409));
	vi.mocked(api.status).mockResolvedValueOnce(state).mockResolvedValue({ ...state, sharedWindow: true, requiresSharedConfirmation: true, affectedPaneIds: ["pi:one", "pi:two"] });
	render(<TerminalMoodControl client={api} paneId="pi:one" />); await expand();
	await userEvent.click(await screen.findByRole("button", { name: "Hacker Verde eléctrico" }));
	await screen.findByRole("checkbox"); expect(screen.getByRole("alert")).toHaveTextContent("La ventana ahora es compartida.");
	expect(api.apply).toHaveBeenCalledOnce(); expect(api.status).toHaveBeenCalledTimes(2);
	expect(events).not.toHaveBeenCalledWith(expect.objectContaining({ type: "gentle-dot-terminal-mood" }));
	expect(screen.getByRole("button", { name: "Hacker Verde eléctrico" })).toBeDisabled();
});

it.each(["host", "pane", "session"])("discards an old verified response after a %s change", async change => {
	const api = client(); const other = client(); const pending = deferred<TerminalMoodState & { verified: true }>();
	vi.mocked(api.apply).mockReturnValue(pending.promise); const events = vi.spyOn(window, "dispatchEvent");
	const view = render(<TerminalMoodControl client={api} paneId="pi:one" sessionId="s1" />); await expand();
	await userEvent.click(await screen.findByRole("button", { name: "Hacker Verde eléctrico" }));
	const signal = vi.mocked(api.apply).mock.calls[0]?.[3];
	view.rerender(<TerminalMoodControl client={change === "host" ? other : api} paneId={change === "pane" ? "pi:two" : "pi:one"} sessionId={change === "session" ? "s2" : "s1"} />);
	expect(signal?.aborted).toBe(true);
	await act(async () => pending.resolve({ ...state, mood: "hacker", verified: true }));
	expect(screen.getByRole("button", { name: "Ambiente de terminal" })).toHaveAttribute("aria-expanded", "false");
	expect(screen.queryByText(/aplicado a la ventana/)).not.toBeInTheDocument();
	expect(events).not.toHaveBeenCalledWith(expect.objectContaining({ type: "gentle-dot-terminal-mood" }));
});

it("discards old status after switching hosts and never carries shared consent over", async () => {
	const api = client(); const next = client(); const pending = deferred<TerminalMoodState>();
	vi.mocked(api.status).mockReturnValue(pending.promise);
	const view = render(<TerminalMoodControl client={api} paneId="pi:one" />); await expand();
	view.rerender(<TerminalMoodControl client={next} paneId="pi:one" />); await expand();
	await screen.findByText("Cambia los colores de esta ventana de terminal.");
	await act(async () => pending.resolve({ ...state, sharedWindow: true, requiresSharedConfirmation: true, affectedPaneIds: ["pi:one", "pi:two"] }));
	expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});

it("blocks duplicate mutations and refresh while a change is pending", async () => {
	const api = client(); const pending = deferred<TerminalMoodState & { verified: true }>(); vi.mocked(api.apply).mockReturnValue(pending.promise);
	render(<TerminalMoodControl client={api} paneId="pi:one" />); await expand();
	const button = await screen.findByRole("button", { name: "Hacker Verde eléctrico" });
	fireEvent.click(button); fireEvent.click(button);
	expect(api.apply).toHaveBeenCalledOnce(); expect(screen.getByRole("button", { name: "Actualizar ambiente" })).toBeDisabled();
	await act(async () => pending.resolve({ ...state, mood: "hacker", verified: true }));
	expect(screen.getByRole("button", { name: "Actualizar ambiente" })).toBeEnabled();
});

it("explains an unsupported legacy host and leaves no mutation controls", async () => {
	render(<TerminalMoodControl paneId="pi:one" />); await expand();
	await screen.findByText(/Actualiza Gentle Dot en tu equipo/);
	expect(screen.queryByRole("group", { name: "Elegir ambiente" })).not.toBeInTheDocument();
});

it("does not announce an unverified change and lets a manual status refresh recover", async () => {
	const api = client(); const events = vi.spyOn(window, "dispatchEvent");
	vi.mocked(api.apply).mockResolvedValue({ ...state, mood: "hacker", verified: false } as unknown as TerminalMoodState & { verified: true });
	render(<TerminalMoodControl client={api} paneId="pi:one" />); await expand();
	await userEvent.click(await screen.findByRole("button", { name: "Hacker Verde eléctrico" }));
	await screen.findByRole("alert"); expect(events).not.toHaveBeenCalledWith(expect.objectContaining({ type: "gentle-dot-terminal-mood" }));
	await userEvent.click(screen.getByRole("button", { name: "Actualizar ambiente" }));
	await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
	expect(await screen.findByRole("button", { name: "Hacker Verde eléctrico" })).toBeEnabled();
});
