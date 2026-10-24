import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { initialState } from "../src/store.ts";

afterEach(() => {
	delete window.__GENTLE_MOBILE__;
	localStorage.clear();
});

describe("Android dictation", () => {
	it("always leaves native speech in an editable draft, even if automatic sending was remembered", async () => {
		localStorage.setItem("gentle-dot-voice-send", "1");
		const transcribe = vi.fn(async () => ({ text: "Continúa el plan preparado" }));
		window.__GENTLE_MOBILE__ = { transcribe };
		const send = vi.fn();
		render(
			<ChatSurface
				variant="web"
				state={{ ...initialState, connection: "open", agentState: "idle" }}
				send={send}
				dismiss={() => {}}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Talk" }));
		await waitFor(() =>
			expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Continúa el plan preparado"),
		);
		expect(transcribe).toHaveBeenCalledWith({ language: expect.any(String) });
		expect(send).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Send" }));
		expect(send).toHaveBeenCalledWith({
			type: "send",
			text: "Continúa el plan preparado",
			requestId: expect.any(String),
		});
	});

	it("keeps typed text when native speech is cancelled or fails", async () => {
		window.__GENTLE_MOBILE__ = {
			transcribe: vi.fn(async () => {
				throw new Error("Dictation cancelled.");
			}),
		};
		const send = vi.fn();
		render(
			<ChatSurface
				variant="web"
				state={{ ...initialState, connection: "open", agentState: "idle" }}
				send={send}
				dismiss={() => {}}
			/>,
		);
		await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Already typed");
		await userEvent.click(screen.getByRole("button", { name: "Talk" }));
		expect(await screen.findByText("Dictation cancelled.")).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Already typed");
		expect(send).not.toHaveBeenCalled();
	});

	it("uses Android Back to return from Agents to the preserved chat draft", async () => {
		window.__GENTLE_MOBILE__ = { transcribe: vi.fn() };
		render(
			<ChatSurface
				variant="web"
				state={{ ...initialState, connection: "open", agentState: "idle" }}
				send={vi.fn()}
				dismiss={() => {}}
				mobileControls={<button type="button">Avisos del teléfono</button>}
				orchestration={{
					snapshot: vi.fn(async () => ({
						available: true,
						sessions: [],
						approvals: [],
						policies: [],
						events: [],
					})),
					act: vi.fn(),
					inspect: vi.fn(),
				}}
			/>,
		);
		await userEvent.type(screen.getByRole("textbox", { name: "Mensaje" }), "Keep this");
		await userEvent.click(screen.getByRole("button", { name: "Sesiones" }));
		expect(await screen.findByRole("region", { name: "Agentes del equipo" })).toBeInTheDocument();
		const back = new Event("gentledot-back", { cancelable: true });
		act(() => {
			window.dispatchEvent(back);
		});
		expect(back.defaultPrevented).toBe(true);
		expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveValue("Keep this");
	});

	it("tells a revoked phone to pair again", () => {
		window.__GENTLE_MOBILE__ = { transcribe: vi.fn() };
		render(
			<ChatSurface
				variant="web"
				state={{ ...initialState, connection: "unauthorized" }}
				send={vi.fn()}
				dismiss={() => {}}
			/>,
		);
		expect(screen.getByText(/escanea un nuevo QR de vinculación/)).toBeInTheDocument();
	});
});
