import type { Ask } from "@gentle-dot/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { AskCard } from "../src/components/AskCard.tsx";
import { type DotState, initialState } from "../src/store.ts";

const h = vi.hoisted(() => ({
	tauri: true,
	state: undefined as unknown as DotState,
	invoke: vi.fn(),
	send: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
	isTauri: () => h.tauri,
	invoke: (command: string, args?: unknown) => h.invoke(command, args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("../src/desktop.ts", async (original) => ({
	...(await original<typeof import("../src/desktop.ts")>()),
	onDesktopEvent: async () => () => {},
}));
vi.mock("../src/useDot.ts", () => ({
	useDot: () => ({ state: h.state, send: h.send, dismiss: () => {}, dispatch: () => {} }),
}));

const ask: Ask = {
	requestId: "app-exact-request",
	method: "app",
	title: "Permitir acceso al navegador",
	message: "Abrir el navegador dedicado.\n\nSitio: https://example.test\nAlcance: esta solicitud.",
};
const commands = () => h.invoke.mock.calls.filter(([command]) => command === "connector_command");

beforeEach(() => {
	h.tauri = true;
	h.send = vi.fn();
	h.state = {
		...initialState,
		connection: "open",
		agentState: "needs_you",
		clientId: "desktop-window",
		asks: [ask],
	};
	h.invoke = vi.fn(async (command: string) => (command === "connection_info" ? new Promise(() => {}) : null));
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/");
	window.sessionStorage.clear();
});

async function app(surface = "panel") {
	window.history.replaceState(null, "", `/?surface=${surface}`);
	return render(<App connection={{ url: "ws://localhost:2345/ws", token: "fixture-key" }} />);
}

describe("desktop approval route", () => {
	it.each([
		[true, "Permitir"],
		[false, "Rechazar"],
	] as const)("acknowledges %s through the private app channel only", async (approved, button) => {
		await app();
		expect(screen.getByRole("region", { name: "Detalles de la solicitud" }).textContent).toBe(ask.message);
		await userEvent.click(screen.getByRole("button", { name: button }));
		expect(commands()).toEqual([
			[
				"connector_command",
				{
					clientId: "desktop-window",
					message: { type: "app_approval_reply", requestId: "app-exact-request", approved },
				},
			],
		]);
		const permission = screen.getByRole("region", { name: "Permiso de Gentle Dot" });
		expect(within(permission).getByRole("status")).toHaveTextContent(
			approved ? "Permiso concedido." : "Permiso rechazado.",
		);
		expect(screen.getByRole("button", { name: "Permitir" })).toBeDisabled();
		expect(h.send).not.toHaveBeenCalled();
	});

	it.each(["web", "panel"])("a browser cannot answer through the %s surface", async (surface) => {
		h.tauri = false;
		await app(surface);
		expect(screen.getByText(ask.title)).toBeVisible();
		expect(screen.queryByRole("button", { name: "Permitir" })).not.toBeInTheDocument();
		expect(commands()).toEqual([]);
		expect(h.send).not.toHaveBeenCalled();
	});

	it("disables the card when the desktop connection is lost", async () => {
		h.state = { ...h.state, connection: "closed" };
		await app();
		expect(screen.getByRole("button", { name: "Permitir" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Rechazar" })).toBeDisabled();
		expect(commands()).toEqual([]);
	});

	it("shows a native channel rejection in the card and never falls back to WebSocket", async () => {
		h.invoke.mockImplementation(async (command: string) => {
			if (command === "connector_command") throw "La solicitud ya fue respondida desde el teléfono.";
			return null;
		});
		await app();
		await userEvent.click(screen.getByRole("button", { name: "Permitir" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"La solicitud ya fue respondida desde el teléfono.",
		);
		expect(screen.queryByText("Permiso concedido.")).not.toBeInTheDocument();
		expect(commands()).toHaveLength(1);
		expect(h.send).not.toHaveBeenCalled();
	});
});

describe("approval card lifecycle", () => {
	it("blocks repeated clicks until acknowledgement and preserves the complete preview", async () => {
		let resolve!: () => void;
		const answer = vi.fn(
			() =>
				new Promise<void>((done) => {
					resolve = done;
				}),
		);
		const send = vi.fn();
		const message = `Acción solicitada\n\n${"Detalle completo\n".repeat(500)}`;
		render(<AskCard ask={{ ...ask, message }} send={send} answerAppApproval={answer} />);
		const allow = screen.getByRole("button", { name: "Permitir" });
		fireEvent.click(allow);
		fireEvent.click(allow);
		fireEvent.click(screen.getByRole("button", { name: "Rechazar" }));
		expect(answer).toHaveBeenCalledExactlyOnceWith(ask.requestId, true);
		expect(screen.getByRole("region", { name: "Permiso de Gentle Dot" })).toHaveAttribute(
			"aria-busy",
			"true",
		);
		expect(screen.getByRole("status")).toHaveTextContent("Enviando respuesta…");
		expect(screen.getByRole("region", { name: "Detalles de la solicitud" }).textContent).toBe(message);
		await act(async () => resolve());
		expect(screen.getByRole("status")).toHaveTextContent("Permiso concedido.");
		expect(allow).toBeDisabled();
		expect(send).not.toHaveBeenCalled();
	});

	it("expires without sending and does not reset the deadline on rerenders", () => {
		vi.useFakeTimers();
		const answer = vi.fn(async () => {});
		const current = { ...ask, expiresAt: new Date(Date.now() + 1_000).toISOString() };
		const props = { ask: current, send: vi.fn(), answerAppApproval: answer };
		const view = render(<AskCard {...props} />);
		expect(screen.getByRole("button", { name: "Permitir" })).toBeEnabled();
		act(() => vi.advanceTimersByTime(600));
		view.rerender(<AskCard {...props} />);
		act(() => vi.advanceTimersByTime(401));
		expect(screen.getByRole("status")).toHaveTextContent("Esta solicitud ya venció.");
		fireEvent.click(screen.getByRole("button", { name: "Permitir" }));
		expect(answer).not.toHaveBeenCalled();
		expect(props.send).not.toHaveBeenCalled();
	});

	it("never applies a late answer to the next permission card", async () => {
		let reject!: (reason: Error) => void;
		const answer = vi.fn(
			() =>
				new Promise<void>((_done, fail) => {
					reject = fail;
				}),
		);
		const send = vi.fn();
		const view = render(<AskCard ask={ask} send={send} answerAppApproval={answer} />);
		fireEvent.click(screen.getByRole("button", { name: "Permitir" }));
		view.rerender(
			<AskCard
				ask={{ ...ask, requestId: "next-request", title: "Nueva solicitud" }}
				send={send}
				answerAppApproval={answer}
			/>,
		);
		await act(async () => reject(new Error("La solicitud anterior venció.")));
		expect(screen.getByText("Nueva solicitud")).toBeVisible();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole("button", { name: "Permitir" })).toBeEnabled());
		expect(answer).toHaveBeenCalledOnce();
	});
});
