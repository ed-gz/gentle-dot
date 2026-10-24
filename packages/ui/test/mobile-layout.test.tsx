import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import type { OrchestrationClient } from "../src/orchestration.ts";
import { type DotState, initialState, reduce } from "../src/store.ts";
import type { UsageClient, UsageSnapshot } from "../src/usage.ts";
import { defaultUsageBadges, USAGE_BADGE_KEY } from "../src/useUsageBadges.ts";
import type { WatchersClient } from "../src/watchers.ts";

const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeAll(() => {
	// jsdom does not implement the native dialog methods. Real focus/keyboard behavior is covered by APK-shell E2E.
	Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
		configurable: true,
		value(this: HTMLDialogElement) {
			this.open = true;
		},
	});
	Object.defineProperty(HTMLDialogElement.prototype, "close", {
		configurable: true,
		value(this: HTMLDialogElement) {
			this.open = false;
		},
	});
});
afterAll(() => {
	if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShow);
	else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
	if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
	else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});
afterEach(() => {
	vi.useRealTimers();
	delete window.__GENTLE_MOBILE__;
	localStorage.clear();
});

const connected: DotState = { ...initialState, connection: "open", agentState: "idle" };
function setup(state = connected, api?: OrchestrationClient, watchers?: WatchersClient, usage?: UsageClient) {
	const send = vi.fn();
	function Phone() {
		const [current, dispatch] = useReducer(reduce, state);
		return (
			<ChatSurface
				variant="web"
				state={current}
				send={send}
				dispatch={dispatch}
				dismiss={() => {}}
				mobileControls={<button type="button">Activar avisos</button>}
				{...(api ? { orchestration: api } : {})}
				{...(watchers ? { watchers } : {})}
				{...(usage ? { usage } : {})}
			/>
		);
	}
	render(<Phone />);
	return send;
}

describe("compact phone layout", () => {
	it("places settings left, Dot in the middle and sessions right before the conversation", () => {
		const api: OrchestrationClient = {
			snapshot: vi.fn(async () => ({
				available: true,
				sessions: [],
				approvals: [],
				policies: [],
				events: [],
			})),
			act: vi.fn(),
			inspect: vi.fn(),
		};
		setup(connected, api);
		const navigation = screen.getByRole("navigation", { name: "Navegación principal" });
		expect(
			within(navigation)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["Ajustes", "Dot", "Sesiones"]);
		expect(navigation.parentElement?.firstElementChild).toBe(navigation);
		expect(navigation).toHaveClass("mobile-top-nav");
		expect(within(navigation).getByRole("button", { name: "Dot" }).querySelector("svg")).toHaveAttribute(
			"viewBox",
			"0 0 24 24",
		);
	});

	it.each([
		["button", true],
		["Android Back", true],
		["button", false],
		["Android Back", false],
	] as const)(
		"opens details manually and restores the draft using %s, badges enabled=%s",
		async (back, badgesEnabled) => {
			if (!badgesEnabled) {
				localStorage.setItem(USAGE_BADGE_KEY, JSON.stringify({ ...defaultUsageBadges(), visible: false }));
			}
			const signals: Array<AbortSignal | undefined> = [];
			const usage: UsageClient = {
				read: vi.fn(async (signal) => {
					signals.push(signal);
					return { providers: [] };
				}),
			};
			setup(connected, undefined, undefined, usage);
			await userEvent.type(screen.getByRole("textbox", { name: "Mensaje" }), "Conserva este borrador");
			const compactReads = badgesEnabled ? 1 : 0;
			expect(usage.read).toHaveBeenCalledTimes(compactReads);
			expect(screen.queryByRole("region", { name: "Uso de suscripciones" })).not.toBeInTheDocument();
			const compactSignal = badgesEnabled ? signals[0] : undefined;
			if (badgesEnabled) expect(compactSignal?.aborted).toBe(false);
			await userEvent.click(screen.getByRole("button", { name: "Ver consumo" }));
			expect(await screen.findByRole("main", { name: "Consumo" })).toBeVisible();
			await waitFor(() => expect(usage.read).toHaveBeenCalledTimes(compactReads + 1));
			const detailsSignal = signals[compactReads];
			expect(detailsSignal).toBeDefined();
			expect(detailsSignal).not.toBe(compactSignal);
			expect(detailsSignal?.aborted).toBe(false);
			if (back === "button") await userEvent.click(screen.getByRole("button", { name: "Volver a Dot" }));
			else act(() => window.dispatchEvent(new Event("gentledot-back", { cancelable: true })));
			expect(detailsSignal?.aborted).toBe(true);
			if (badgesEnabled) expect(compactSignal?.aborted).toBe(false);
			expect(screen.queryByRole("main", { name: "Ajustes" })).not.toBeInTheDocument();
			expect(screen.queryByRole("region", { name: "Uso de suscripciones" })).not.toBeInTheDocument();
			expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveValue("Conserva este borrador");
		},
	);

	it("does not poll compact quota with badges disabled, but still opens details on demand", async () => {
		localStorage.setItem(USAGE_BADGE_KEY, JSON.stringify({ ...defaultUsageBadges(), visible: false }));
		vi.useFakeTimers();
		const usage: UsageClient = { read: vi.fn(async () => ({ providers: [] })) };
		setup(connected, undefined, undefined, usage);
		await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
		expect(usage.read).not.toHaveBeenCalled();
		expect(screen.queryByLabelText("Consumo resumido")).not.toBeInTheDocument();
		expect(screen.queryByRole("region", { name: "Uso de suscripciones" })).not.toBeInTheDocument();
		vi.useRealTimers();
		await userEvent.click(screen.getByRole("button", { name: "Ver consumo" }));
		expect(await screen.findByRole("region", { name: "Uso de suscripciones" })).toBeVisible();
		await waitFor(() => expect(usage.read).toHaveBeenCalledTimes(1));
	});

	it("returns consumption opened from settings to settings, not to the chat", async () => {
		const usage: UsageClient = { read: vi.fn(async () => ({ providers: [] })) };
		setup(connected, undefined, undefined, usage);
		await userEvent.click(screen.getByRole("button", { name: "Ajustes" }));
		await userEvent.click(screen.getByRole("button", { name: "Consumo" }));
		expect(await screen.findByRole("main", { name: "Consumo" })).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "Volver a ajustes" }));
		expect(screen.getByRole("main", { name: "Ajustes" })).toBeVisible();
	});

	it.each([true, false])("closes details on tab switch and aborts only its pending read, badges enabled=%s", async (badgesEnabled) => {
		if (!badgesEnabled) {
			localStorage.setItem(USAGE_BADGE_KEY, JSON.stringify({ ...defaultUsageBadges(), visible: false }));
		}
		const signals: Array<AbortSignal | undefined> = [];
		const usage: UsageClient = {
			read: vi.fn((signal) => {
				signals.push(signal);
				return new Promise<UsageSnapshot>(() => {});
			}),
		};
		setup(connected, undefined, undefined, usage);
		const compactReads = badgesEnabled ? 1 : 0;
		expect(usage.read).toHaveBeenCalledTimes(compactReads);
		expect(screen.queryByRole("main", { name: "Consumo" })).not.toBeInTheDocument();
		const compactSignal = badgesEnabled ? signals[0] : undefined;
		await userEvent.click(screen.getByRole("button", { name: "Ver consumo" }));
		await waitFor(() => expect(usage.read).toHaveBeenCalledTimes(compactReads + 1));
		const detailsSignal = signals[compactReads];
		expect(detailsSignal).toBeDefined();
		expect(detailsSignal).not.toBe(compactSignal);
		expect(detailsSignal?.aborted).toBe(false);
		await userEvent.click(screen.getByRole("button", { name: /^Dot$/ }));
		expect(detailsSignal?.aborted).toBe(true);
		if (badgesEnabled) expect(compactSignal?.aborted).toBe(false);
		await userEvent.click(screen.getByRole("button", { name: "Ajustes" }));
		expect(screen.getByRole("main", { name: "Ajustes" })).toBeVisible();
		expect(screen.queryByRole("main", { name: "Consumo" })).not.toBeInTheDocument();
		expect(usage.read).toHaveBeenCalledTimes(compactReads + 1);
	});

	it("opens watcher status only on demand and restores tools then the draft with Android Back", async () => {
		const watchers: WatchersClient = {
			read: vi.fn(async () => ({ watches: [], pending: 0 })),
			control: vi.fn(async () => {}),
		};
		setup(connected, undefined, watchers);
		await userEvent.type(screen.getByRole("textbox", { name: "Mensaje" }), "Mi borrador");
		expect(watchers.read).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Ajustes" }));
		expect(watchers.read).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Dot 24/7" }));
		expect(await screen.findByText(/Aún no hay tareas automáticas/)).toBeVisible();
		expect(screen.getByRole("main", { name: "Dot 24/7" })).toBeTruthy();
		act(() => window.dispatchEvent(new Event("gentledot-back", { cancelable: true })));
		expect(screen.getByRole("main", { name: "Ajustes" })).toBeTruthy();
		act(() => window.dispatchEvent(new Event("gentledot-back", { cancelable: true })));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveValue("Mi borrador");
		expect(watchers.control).not.toHaveBeenCalled();
	});
	it("keeps device, account, model and voice tools behind one labelled menu", async () => {
		window.__GENTLE_MOBILE__ = { transcribe: vi.fn() };
		setup();
		expect(screen.queryByRole("heading", { name: "Gentle Dot" })).toBeNull();
		expect(screen.getByRole("navigation", { name: "Navegación principal" })).toBeVisible();
		expect(screen.queryByRole("button", { name: "Activar avisos" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Cuentas de IA" })).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Ajustes" }));
		const menu = screen.getByRole("main", { name: "Ajustes" });
		expect(menu).toBeVisible();
		expect(within(menu).getByText("Avisos y teléfono").closest("details")).not.toHaveAttribute("open");
		await userEvent.click(within(menu).getByText("Avisos y teléfono"));
		expect(within(menu).getByRole("button", { name: "Activar avisos" })).toBeInTheDocument();
		expect(within(menu).getByRole("button", { name: "Cuentas de IA" })).toBeInTheDocument();
		expect(within(menu).getByRole("button", { name: /Respuestas en voz alta/ })).toBeInTheDocument();
		expect(within(menu).getByRole("region", { name: "Modelo de IA" })).toBeInTheDocument();
		fireEvent(window, new Event("gentledot-back", { cancelable: true }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it.each([
		["Cuentas de IA", "Cuentas", "auth_list"],
		["Perfiles", "Perfiles", "profiles_list"],
		["Conexiones", "Conexiones", "connectors_list"],
	])("opens %s from the sheet and restores the draft with Android Back", async (label, region, type) => {
		const send = setup();
		await userEvent.type(screen.getByRole("textbox", { name: "Mensaje" }), "Continúa el plan");
		await userEvent.click(screen.getByRole("button", { name: "Ajustes" }));
		await userEvent.click(screen.getByRole("button", { name: label }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(screen.getByRole("region", { name: region })).toBeInTheDocument();
		expect(screen.queryByRole("textbox", { name: "Mensaje" })).not.toBeInTheDocument();
		expect(send).toHaveBeenCalledExactlyOnceWith({ type });
		const back = new Event("gentledot-back", { cancelable: true });
		act(() => window.dispatchEvent(back));
		expect(back.defaultPrevented).toBe(true);
		expect(screen.getByRole("main", { name: "Ajustes" })).toBeVisible();
		act(() => window.dispatchEvent(new Event("gentledot-back", { cancelable: true })));
		expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveValue("Continúa el plan");
	});

	it("closes the sheet before leaving the current screen on Android Back", async () => {
		setup();
		await userEvent.type(screen.getByRole("textbox", { name: "Mensaje" }), "Borrador");
		await userEvent.click(screen.getByRole("button", { name: "Ajustes" }));
		const back = new Event("gentledot-back", { cancelable: true });
		act(() => window.dispatchEvent(back));
		expect(back.defaultPrevented).toBe(true);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveValue("Borrador");
	});

	it("shows connection access on a phone without offering unavailable desktop changes", () => {
		setup({
			...connected,
			connectors: {
				...connected.connectors,
				open: true,
				list: [
					{
						id: "github",
						name: "GitHub",
						added: true,
						enabled: true,
						status: "connected",
						mode: "read_only",
						reads: "Repositorios y cambios",
						sends: "Publicar cambios con permiso",
					},
				],
			},
		});
		expect(screen.getByRole("heading", { name: "Conexiones" })).toBeInTheDocument();
		expect(screen.getByText("GitHub")).toBeInTheDocument();
		expect(screen.getByText("Acceso: solo lectura.")).toBeInTheDocument();
		expect(screen.getByText("Para cambiar conexiones, abre Gentle Dot en tu equipo.")).toBeInTheDocument();
		expect(within(screen.getByRole("region", { name: "Conexiones" })).getAllByRole("button")).toHaveLength(1);
		expect(screen.getByRole("button", { name: "Cerrar conexiones" })).toBeEnabled();
		expect(screen.queryByRole("radio")).not.toBeInTheDocument();
	});

	it("shows Dot permission controls in the conversation and answers only the trusted HTTP request", async () => {
		window.__GENTLE_MOBILE__ = { transcribe: vi.fn() };
		const api: OrchestrationClient = {
			snapshot: vi.fn(async () => ({
				available: true,
				sessions: [],
				approvals: [],
				policies: [],
				events: [],
			})),
			act: vi.fn(),
			inspect: vi.fn(),
			dotApprovals: vi.fn(async () => ({
				allowed: true,
				approvals: [
					{
						id: "trusted-request",
						title: "Crear un evento",
						message: "Calendario: trabajo\nNombre: Revisión del proyecto",
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
					},
				],
			})),
			answerDotApproval: vi.fn(async () => {}),
		};
		const send = setup(
			{
				...connected,
				asks: [{ requestId: "ws-request", method: "app", title: "Confirmar acción" }],
			},
			api,
		);
		expect(await screen.findByRole("heading", { name: "Crear un evento" })).toBeInTheDocument();
		expect(screen.queryByRole("region", { name: "Permiso de Gentle Dot" })).not.toBeInTheDocument();
		expect(screen.queryByText("Confirmar acción")).not.toBeInTheDocument();
		expect(api.answerDotApproval).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Dot" })).toHaveAttribute("aria-pressed", "true");
		await userEvent.click(screen.getByRole("button", { name: "Aprobar permiso de Dot" }));
		expect(api.answerDotApproval).toHaveBeenCalledExactlyOnceWith("trusted-request", true);
		expect(send).not.toHaveBeenCalled();
	});
});
