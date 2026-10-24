import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WatchersPanel, WatchersSettings } from "../src/components/WatchersPanel.tsx";
import {
	createWatchersClient,
	parseWatchers,
	type WatchersClient,
	type WatchersSnapshot,
} from "../src/watchers.ts";

const snapshot = (): WatchersSnapshot => ({
	watches: [
		{
			id: "email-watch",
			source: { kind: "email", connectorId: "work-mail" },
			instruction: "Avísame de los correos que requieren respuesta",
			state: "active",
			pending: 0,
			createdAt: "2026-10-11T05:00:00Z",
			updatedAt: "2026-10-11T05:00:00Z",
			lastCheckedAt: "2026-10-11T05:10:00Z",
		},
	],
	pending: 0,
});
const client = (data = snapshot()): WatchersClient => ({
	read: vi.fn(async () => data),
	control: vi.fn(async () => {}),
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("watcher status transport", () => {
	it("rejects malformed status instead of inventing an empty or active watch", () => {
		expect(parseWatchers(snapshot())).toEqual(snapshot());
		const watch = snapshot().watches[0];
		for (const value of [
			undefined,
			{},
			{ watches: [], pending: -1 },
			{ ...snapshot(), watches: [watch, watch] },
			{ ...snapshot(), sources: [{ id: "gmail", label: "Gmail", kind: "email", available: "yes" }] },
			{ ...snapshot(), sessions: [{ paneId: "p", sessionId: "s" }] },
			...[
				{ state: "working" },
				{ createdAt: "bad" },
				{ nextPollAt: "bad" },
				{ pending: -2 },
				{ intervalMs: 30_000 },
				{ source: { kind: "gmail" } },
				{ source: { kind: "agents", sessions: [{}] } },
			].map((bad) => ({ ...snapshot(), watches: [{ ...watch, ...bad }] })),
		])
			expect(() => parseWatchers(value)).toThrow(/estado/);
		expect(parseWatchers({ watches: [], pending: 0 })).toEqual({ watches: [], pending: 0 });
	});

	it("authenticates on the same computer and posts only the explicit watch action", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot())));
		vi.stubGlobal("fetch", fetcher);
		const api = createWatchersClient({ url: "wss://computer.test.ts.net/ws", token: "phone-key" });
		await expect(api.read()).resolves.toEqual(snapshot());
		expect(fetcher).toHaveBeenCalledWith(
			"https://computer.test.ts.net/api/mobile/watchers",
			expect.objectContaining({
				headers: { Authorization: "Bearer phone-key" },
				cache: "no-store",
				redirect: "error",
				credentials: "omit",
			}),
		);
		for (const action of ["pause", "resume", "delete"] as const) {
			await api.control({ action, watchId: "email-watch" });
			expect(fetcher).toHaveBeenLastCalledWith(
				expect.any(String),
				expect.objectContaining({ method: "POST", body: JSON.stringify({ action, watchId: "email-watch" }) }),
			);
		}
		fetcher.mockResolvedValue(new Response("", { status: 403 }));
		await expect(api.read()).rejects.toThrow(/autorizado/);
		fetcher.mockResolvedValue(new Response("", { status: 503 }));
		await expect(api.read()).rejects.toThrow(/disponible/);
	});
});

describe("watcher settings", () => {
	it("keeps desktop settings folded and does not fetch until the user opens them", async () => {
		const api = client();
		render(<WatchersSettings client={api} connected />);
		expect(api.read).not.toHaveBeenCalled();
		await userEvent.click(screen.getByText("Dot 24/7"));
		expect(await screen.findByText("En espera")).toBeVisible();
		expect(api.control).not.toHaveBeenCalled();
		await userEvent.click(screen.getByText("Dot 24/7"));
		await waitFor(() => expect(screen.queryByRole("region", { name: "Dot 24/7" })).toBeNull());
	});

	it("distinguishes source errors, paused watches and pending events without claiming active work", async () => {
		const data = snapshot();
		const base = data.watches[0];
		if (!base) throw new Error("fixture");
		data.watches.push(
			{
				...base,
				id: "agents",
				source: { kind: "agents" },
				instruction: "Sigue mis agentes",
				state: "paused",
			},
			{ ...base, id: "pending", instruction: "Revisa novedades", pending: 2 },
		);
		base.lastError = "Revisa la conexión de correo";
		render(<WatchersPanel client={client(data)} />);
		expect(await screen.findByText("Revisar conexión")).toBeVisible();
		expect(screen.getByText("Pausado")).toBeVisible();
		expect(screen.getByText("Novedades pendientes")).toBeVisible();
		expect(screen.queryByText("Trabajando…")).toBeNull();
		expect(screen.getAllByText("Última comprobación")[0]).not.toBeVisible();
		await userEvent.click(screen.getAllByText("Ver detalles")[0] as HTMLElement);
		expect(screen.getAllByText("work-mail")[0]).toBeVisible();
	});

	it("pauses, resumes and deletes only after explicit confirmation, then rereads server state", async () => {
		let data = snapshot();
		const api: WatchersClient = {
			read: vi.fn(async () => structuredClone(data)),
			control: vi.fn(async ({ action }) => {
				if (action === "delete") data = { watches: [], pending: 0 };
				else if (data.watches[0]) data.watches[0].state = action === "pause" ? "paused" : "active";
			}),
		};
		render(<WatchersPanel client={api} />);
		await userEvent.click(await screen.findByRole("button", { name: "Pausar" }));
		expect(await screen.findByText("Pausado")).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "Reanudar" }));
		expect(await screen.findByText("En espera")).toBeVisible();
		await userEvent.click(screen.getByText("Ver detalles"));
		await userEvent.click(screen.getByRole("button", { name: "Eliminar tarea" }));
		expect(api.control).toHaveBeenCalledTimes(2);
		await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
		expect(api.control).toHaveBeenCalledTimes(2);
		await userEvent.click(screen.getByRole("button", { name: "Eliminar tarea" }));
		await userEvent.click(screen.getByRole("button", { name: "Sí, eliminar tarea" }));
		await screen.findByText(/Aún no hay tareas/);
		expect(api.control).toHaveBeenLastCalledWith(
			{ action: "delete", watchId: "email-watch" },
			expect.any(AbortSignal),
		);
		expect(api.read).toHaveBeenCalledTimes(4);
	});

	it("marks failed changes as unconfirmed and retries status before allowing another action", async () => {
		const api = client();
		vi.mocked(api.control).mockRejectedValue(new Error("No se pudo confirmar el cambio"));
		render(<WatchersPanel client={api} />);
		await userEvent.click(await screen.findByRole("button", { name: "Pausar" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("El estado puede haber cambiado");
		expect(screen.getByText("Estado no actualizado")).toBeVisible();
		expect(screen.getByRole("button", { name: "Pausar" })).toBeDisabled();
		await userEvent.click(screen.getByRole("button", { name: "Actualizar" }));
		expect(await screen.findByText("En espera")).toBeVisible();
		expect(screen.getByRole("button", { name: "Pausar" })).toBeEnabled();
	});

	it("polls only while mounted, connected and visible, aborting hidden requests", async () => {
		vi.useFakeTimers();
		const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		const api = client();
		const view = render(<WatchersPanel client={api} />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20_000);
		});
		expect(api.read).toHaveBeenCalledTimes(2);
		const signal = vi.mocked(api.read).mock.calls[1]?.[0];
		visibility.mockReturnValue("hidden");
		act(() => fireEvent(document, new Event("visibilitychange")));
		expect(signal?.aborted).toBe(true);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(api.read).toHaveBeenCalledTimes(2);
		visibility.mockReturnValue("visible");
		await act(async () => {
			fireEvent(document, new Event("visibilitychange"));
		});
		expect(api.read).toHaveBeenCalledTimes(3);
		view.rerender(<WatchersPanel client={api} connected={false} />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(40_000);
		});
		expect(api.read).toHaveBeenCalledTimes(3);
		expect(screen.getByRole("button", { name: "Pausar" })).toBeDisabled();
		view.unmount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(40_000);
		});
		expect(api.read).toHaveBeenCalledTimes(3);
	});

	it("does not leak a previous computer's late response or mutation into the next connection", async () => {
		let done = () => {};
		const old = client();
		vi.mocked(old.control).mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					done = resolve;
				}),
		);
		const view = render(<WatchersPanel client={old} />);
		await userEvent.click(await screen.findByRole("button", { name: "Pausar" }));
		const oldSignal = vi.mocked(old.control).mock.calls[0]?.[1];
		const next = snapshot();
		if (next.watches[0]) next.watches[0].instruction = "Otro equipo";
		const nextClient = client(next);
		view.rerender(<WatchersPanel client={nextClient} />);
		const nextCard = await screen.findByRole("article", { name: "Otro equipo" });
		expect(oldSignal?.aborted).toBe(true);
		await act(async () => done());
		expect(screen.queryByRole("article", { name: /correos/ })).toBeNull();
		expect(within(nextCard).getByRole("button", { name: "Pausar" })).toBeEnabled();
		expect(old.read).toHaveBeenCalledTimes(1);
	});
});

const setupSnapshot = (): WatchersSnapshot => ({
	watches: [],
	pending: 0,
	sources: [
		{ id: "agents", kind: "agents", label: "Sesiones", available: true },
		{ id: "gmail", kind: "email", label: "Gmail", available: false, configured: false },
	],
	sessions: [{ paneId: "pane-a", sessionId: "session-a", label: "Portal de clientes" }],
});

it("creates a scoped watch only after explicit selection and a human instruction", async () => {
	const api = { ...client(setupSnapshot()), setup: vi.fn(async () => setupSnapshot()) };
	render(<WatchersPanel client={api} />);
	await userEvent.click(await screen.findByRole("button", { name: "Añadir tarea" }));
	const activate = await screen.findByRole("button", { name: "Activar tarea" });
	expect(activate).toBeDisabled();
	expect(api.control).not.toHaveBeenCalled();
	await userEvent.click(await screen.findByRole("checkbox", { name: "Portal de clientes" }));
	await userEvent.type(
		screen.getByRole("textbox", { name: "Qué debe identificar Dot" }),
		"Resume el resultado y señala bloqueos",
	);
	await userEvent.click(activate);
	expect(api.control).toHaveBeenCalledWith(
		{
			action: "start",
			source: { kind: "agents", sessions: [{ paneId: "pane-a", sessionId: "session-a" }] },
			instruction: "Resume el resultado y señala bloqueos",
		},
		expect.any(AbortSignal),
	);
	await waitFor(() => expect(screen.queryByRole("form", { name: "Nueva tarea automática" })).toBeNull());
});

it("keeps unavailable email disabled and persists the selected cadence for a connected account", async () => {
	const data = setupSnapshot();
	const api = { ...client(data), setup: vi.fn(async () => structuredClone(data)) };
	const view = render(<WatchersPanel client={api} />);
	await userEvent.click(await screen.findByRole("button", { name: "Añadir tarea" }));
	await userEvent.click(await screen.findByRole("radio", { name: "Correo" }));
	expect(await screen.findByText(/Conecta Gmail en Conexiones/)).toBeVisible();
	await userEvent.type(
		screen.getByRole("textbox", { name: "Qué debe identificar Dot" }),
		"Detecta solicitudes urgentes",
	);
	expect(screen.getByRole("button", { name: "Activar tarea" })).toBeDisabled();
	expect(api.control).not.toHaveBeenCalled();
	view.unmount();
	if (data.sources?.[1]) data.sources[1] = { ...data.sources[1], available: true, configured: true };
	render(<WatchersPanel client={api} />);
	await userEvent.click(await screen.findByRole("button", { name: "Añadir tarea" }));
	await userEvent.click(await screen.findByRole("radio", { name: "Correo" }));
	await userEvent.selectOptions(screen.getByRole("combobox", { name: "Revisar correo" }), "900000");
	await userEvent.type(
		screen.getByRole("textbox", { name: "Qué debe identificar Dot" }),
		"Detecta solicitudes urgentes",
	);
	await userEvent.click(screen.getByRole("button", { name: "Activar tarea" }));
	expect(api.control).toHaveBeenCalledWith(
		{
			action: "start",
			source: { kind: "email", connectorId: "gmail" },
			intervalMs: 900_000,
			instruction: "Detecta solicitudes urgentes",
		},
		expect.any(AbortSignal),
	);
});

it("ignores a dismissed setup response without activating anything", async () => {
	let finish!: (value: WatchersSnapshot) => void;
	const api = {
		...client(setupSnapshot()),
		setup: vi.fn(
			() =>
				new Promise<WatchersSnapshot>((resolve) => {
					finish = resolve;
				}),
		),
	};
	render(<WatchersPanel client={api} />);
	await userEvent.click(await screen.findByRole("button", { name: "Añadir tarea" }));
	await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
	expect(api.setup.mock.calls[0]?.length).toBe(1);
	await act(async () => finish(setupSnapshot()));
	expect(screen.queryByRole("textbox")).toBeNull();
	expect(api.control).not.toHaveBeenCalled();
});

it("includes future sessions only when the user explicitly selects that scope", async () => {
	const api = { ...client(setupSnapshot()), setup: vi.fn(async () => setupSnapshot()) };
	render(<WatchersPanel client={api} />);
	await userEvent.click(await screen.findByRole("button", { name: "Añadir tarea" }));
	await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Sesiones que seguirá" }), "all");
	await userEvent.type(
		screen.getByRole("textbox", { name: "Qué debe identificar Dot" }),
		"Resume los bloqueos",
	);
	await userEvent.click(screen.getByRole("button", { name: "Activar tarea" }));
	expect(api.control).toHaveBeenCalledWith(
		{ action: "start", source: { kind: "agents" }, instruction: "Resume los bloqueos" },
		expect.any(AbortSignal),
	);
});
