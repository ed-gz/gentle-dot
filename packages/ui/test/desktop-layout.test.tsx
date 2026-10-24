import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import type { OrchestrationClient } from "../src/orchestration.ts";
import { initialState } from "../src/store.ts";
import { openDesktopOptions } from "./desktop-options.ts";

const connected = { ...initialState, connection: "open", agentState: "idle" } as const;
const deviceControls = <button type="button">Avisos del teléfono</button>;

function sessionClient(): OrchestrationClient {
	return {
		snapshot: vi.fn(async () => ({ available: true, sessions: [], approvals: [], policies: [], events: [] })),
		inspect: vi.fn(),
		act: vi.fn(),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	delete window.__GENTLE_MOBILE__;
	localStorage.clear();
});

describe("desktop chat layout", () => {
	it.each([
		["panel", 375],
		["panel", 1280],
		["web", 375],
		["web", 1280],
	] as const)("opens %s at %ipx directly in Dot without a session screen or polling", (variant, width) => {
		vi.stubGlobal("innerWidth", width);
		const api = sessionClient();
		const { container } = render(
			<ChatSurface
				variant={variant}
				state={connected}
				send={vi.fn()}
				dismiss={vi.fn()}
				orchestration={api}
				settings
			/>,
		);
		expect(screen.getByRole("heading", { name: "Gentle Dot" })).toBeVisible();
		expect(screen.getByRole("textbox", { name: "Message" })).toBeVisible();
		openDesktopOptions();
		expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled();
		openDesktopOptions();
		expect(screen.getByRole("button", { name: "Accounts" })).toBeEnabled();
		expect(screen.queryByRole("button", { name: /^(Chat|Agentes|Sesiones)$/ })).not.toBeInTheDocument();
		expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
		expect(container.querySelector(".sessions-screen")).toBeNull();
		expect(container.querySelector(".chat-mobile")).toBeNull();
		expect(screen.queryByRole("button",{name:"Acompañante"})).not.toBeInTheDocument();
		expect(container.querySelector(".companion-toolbar")).toBeNull();
		expect(api.snapshot).not.toHaveBeenCalled();
	});

	it("restores the preserved chat immediately when an earlier session view becomes desktop", async () => {
		const api = sessionClient();
		const props = { state: connected, send: vi.fn(), dismiss: vi.fn(), orchestration: api };
		const { rerender, container } = render(
			<ChatSurface {...props} variant="web" mobileControls={deviceControls} />,
		);
		await userEvent.type(screen.getByRole("textbox", { name: "Mensaje" }), "Sigue con mi objetivo");
		await userEvent.click(screen.getByRole("button", { name: "Sesiones" }));
		expect(await screen.findByRole("region", { name: "Agentes del equipo" })).toBeVisible();
		await waitFor(() => expect(api.snapshot).toHaveBeenCalled());
		const signal = vi.mocked(api.snapshot).mock.calls.at(-1)?.[0];

		rerender(<ChatSurface {...props} variant="panel" />);
		expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Sigue con mi objetivo");
		expect(container.querySelector(".sessions-screen")).toBeNull();
		expect(signal?.aborted).toBe(true);
		const back = new Event("gentledot-back", { cancelable: true });
		act(() => window.dispatchEvent(back));
		expect(back.defaultPrevented).toBe(false);

		// The old screen selection cannot resurface if the same component later returns to the phone.
		rerender(<ChatSurface {...props} variant="web" mobileControls={deviceControls} />);
		expect(screen.getByRole("button", { name: "Dot" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveValue("Sigue con mi objetivo");
	});

	it("keeps the phone navigation at desktop-sized widths when the Android shell is present", async () => {
		vi.stubGlobal("innerWidth", 1280);
		window.__GENTLE_MOBILE__ = { transcribe: vi.fn() };
		const api = sessionClient();
		render(
			<ChatSurface
				variant="web"
				state={connected}
				send={vi.fn()}
				dismiss={vi.fn()}
				orchestration={api}
				mobileControls={deviceControls}
			/>,
		);
		expect(screen.getByRole("navigation", { name: "Navegación principal" })).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "Sesiones" }));
		expect(await screen.findByRole("region", { name: "Agentes del equipo" })).toBeVisible();
	});
});
