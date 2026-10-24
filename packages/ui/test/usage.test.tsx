import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsagePanel } from "../src/components/UsagePanel.tsx";
import { createUsageClient, parseUsage, type UsageSnapshot } from "../src/usage.ts";

const snapshot = (): UsageSnapshot => ({
	providers: [
		{
			id: "codex",
			label: "Codex",
			status: "ok",
			plan: "Pro",
			checkedAt: "2026-10-11T05:00:00Z",
			windows: [
				{
					id: "primary",
					label: "Ventana de 5 horas",
					usedPercent: 24,
					remainingPercent: 76,
					resetAt: "2030-10-11T08:00:00Z",
					windowDurationMins: 300,
				},
				{ id: "secondary", label: "Semanal", usedPercent: 82.5, remainingPercent: 17.5 },
			],
		},
		{
			id: "claude",
			label: "Claude",
			status: "unauthenticated",
			checkedAt: "2026-10-11T05:00:00Z",
			error: "Conecta Claude en tu equipo para consultar el consumo.",
			windows: [],
		},
	],
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("subscription usage transport", () => {
	it("rejects unknown, duplicate and malformed providers and percentages without inventing zeros", () => {
		expect(parseUsage(snapshot())).toEqual(snapshot());
		for (const bad of [
			undefined,
			{},
			{ providers: [] },
			{ ...snapshot(), refreshAt: "invalid" },
			{ providers: [snapshot().providers[0], snapshot().providers[0]] },
		])
			expect(() => parseUsage(bad)).toThrow(/no válidos/);
		for (const window of [
			{ usedPercent: null },
			{ usedPercent: 200 },
			{ remainingPercent: 0 },
			{ resetAt: "invalid" },
			{ windowDurationMins: -1 },
		]) {
			const data = snapshot();
			Object.assign(data.providers[0]?.windows[0] ?? {}, window);
			expect(() => parseUsage(data)).toThrow(/no válidos/);
		}
	});

	it("validates optional credit balances without inventing a missing balance", () => {
		for (const credits of [{ balance: 12.5 }, { unlimited: true }, { hasCredits: false }]) {
			const data = snapshot();
			Object.assign(data.providers[0] ?? {}, { credits });
			expect(parseUsage(data).providers[0]?.credits).toEqual(credits);
		}
		for (const credits of [
			null,
			{ balance: -1 },
			{ balance: Infinity },
			{ balance: "12" },
			{ unlimited: "true" },
			{ hasCredits: 1 },
		]) {
			const data = snapshot();
			Object.assign(data.providers[0] ?? {}, { credits });
			expect(() => parseUsage(data)).toThrow(/no válidos/);
		}
	});

	it("validates optional reset inventory and refuses malformed counts or dates", () => {
		const data = snapshot();
		const resetCredits = {
			availableCount: 1,
			credits: [{ state: "available", expiresAt: "2030-01-01T00:00:00Z" }],
		};
		Object.assign(data.providers[0] ?? {}, { resetCredits });
		expect(parseUsage(data).providers[0]?.resetCredits).toEqual(resetCredits);
		for (const invalid of [
			null,
			{ availableCount: -1, credits: [] },
			{ availableCount: 1.5, credits: [] },
			{ availableCount: 1, credits: [{ state: "unknown" }] },
			{ availableCount: 1, credits: [{ state: "available", expiresAt: "bad" }] },
			{ availableCount: 65, credits: Array.from({ length: 65 }, () => ({ state: "available" })) },
		]) {
			Object.assign(data.providers[0] ?? {}, { resetCredits: invalid });
			expect(() => parseUsage(data)).toThrow(/no válidos/);
		}
	});

	it("uses authenticated same-computer GET, rejects redirects and gives useful access errors", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot()), { status: 200 }));
		vi.stubGlobal("fetch", fetcher);
		const client = createUsageClient({ url: "wss://computer.test.ts.net/ws", token: "private-phone-key" });
		await expect(client.read()).resolves.toEqual(snapshot());
		expect(fetcher).toHaveBeenCalledWith(
			"https://computer.test.ts.net/api/mobile/usage",
			expect.objectContaining({
				headers: { Authorization: "Bearer private-phone-key" },
				credentials: "omit",
				redirect: "error",
				cache: "no-store",
			}),
		);
		fetcher.mockResolvedValue(new Response("", { status: 401 }));
		await expect(client.read()).rejects.toThrow(/autorizado/);
		fetcher.mockResolvedValue(new Response("", { status: 503 }));
		await expect(client.read()).rejects.toThrow(/local/);
	});
});

describe("subscription usage panel", () => {
	it("separates used from remaining and never draws a zero meter for an unavailable account", async () => {
		render(<UsagePanel client={{ read: async () => snapshot() }} />);
		const codex = await screen.findByRole("article", { name: "Consumo de Codex" });
		expect(within(codex).getByRole("progressbar", { name: /76% disponible/ })).toHaveAttribute("value", "76");
		expect(within(codex).getByRole("progressbar", { name: /76% disponible/ })).toBeTruthy();
		expect(within(codex).getAllByRole("progressbar")).toHaveLength(2);
		const claude = screen.getByRole("article", { name: "Consumo de Claude" });
		expect(within(claude).getByText("Sin conectar")).toBeTruthy();
		expect(within(claude).queryByRole("progressbar")).toBeNull();
	});

	it("keeps remaining, used, exact reset and optional credits distinct", async () => {
		const data = snapshot();
		Object.assign(data.providers[0] ?? {}, { credits: { balance: 12.5, hasCredits: true } });
		render(<UsagePanel client={{ read: async () => data }} />);
		const codex = await screen.findByRole("article", { name: "Consumo de Codex" });
		expect(within(codex).getByText("24% usado")).toBeVisible();
		expect(within(codex).getByText("12,5")).toBeVisible();
		expect(codex.querySelector(".usage-reset-date")).toBeVisible();
		expect(codex.querySelector(".usage-reset-date")).toHaveAttribute("datetime", "2030-10-11T08:00:00Z");
		expect(
			within(screen.getByRole("article", { name: "Consumo de Claude" })).queryByText("Créditos adicionales"),
		).toBeNull();
	});

	it("keeps banked resets separate from credits and no longer advertises an expired reset", async () => {
		const data = snapshot();
		Object.assign(data.providers[0] ?? {}, {
			credits: { balance: 12.5 },
			resetCredits: {
				availableCount: 3,
				credits: [
					{ state: "available", expiresAt: "2030-01-01T00:00:00Z" },
					{ state: "available", expiresAt: "2030-01-01T00:00:00Z" },
					{ state: "available", expiresAt: "2020-01-01T00:00:00Z" },
				],
			},
		});
		render(<UsagePanel client={{ read: async () => data }} />);
		const summary = await screen.findByText("Reinicios disponibles");
		expect(summary).toHaveTextContent("2");
		expect(screen.getByText("12,5")).toBeVisible();
		await userEvent.click(summary);
		expect(screen.getByText("2 × Disponible")).toBeVisible();
		expect(screen.getByText("Caducado")).toBeVisible();
	});

	it("marks old readings and expired windows without claiming remaining quota is current", async () => {
		const data = snapshot();
		Object.assign(data.providers[0] ?? {}, { stale: true, status: "error", error: "No se pudo actualizar." });
		Object.assign(data.providers[0]?.windows[0] ?? {}, { resetAt: "2020-01-01T00:00:00Z" });
		render(<UsagePanel client={{ read: async () => data }} />);
		expect(await screen.findByText("Datos anteriores")).toBeTruthy();
		expect(screen.getByRole("progressbar", { name: /76% disponible en la última lectura/ })).toBeTruthy();
		expect(screen.getByText("Ventana terminada")).toBeTruthy();
	});

	it("allows retry after failure and aborts an in-flight read when leaving the view", async () => {
		let signal: AbortSignal | undefined;
		const read = vi
			.fn()
			.mockRejectedValueOnce(new Error("Sin conexión con el equipo"))
			.mockImplementation((value?: AbortSignal) => {
				signal = value;
				return Promise.resolve(snapshot());
			});
		const view = render(<UsagePanel client={{ read }} />);
		expect(await screen.findByRole("alert")).toHaveTextContent("Sin conexión");
		await userEvent.click(screen.getByRole("button", { name: "Actualizar consumo" }));
		expect(await screen.findByRole("article", { name: "Consumo de Codex" })).toBeTruthy();
		view.unmount();
		expect(signal?.aborted).toBe(true);
	});

	it("keeps a retained reading visibly stale throughout a slow retry", async () => {
		let finish: (value: UsageSnapshot) => void = () => {};
		const read = vi
			.fn()
			.mockResolvedValueOnce(snapshot())
			.mockRejectedValueOnce(new Error("Sin conexión"))
			.mockImplementationOnce(
				() =>
					new Promise<UsageSnapshot>((resolve) => {
						finish = resolve;
					}),
			);
		render(<UsagePanel client={{ read }} />);
		await screen.findByRole("article", { name: "Consumo de Codex" });
		await userEvent.click(screen.getByRole("button", { name: "Actualizar consumo" }));
		await screen.findByRole("alert");
		await userEvent.click(screen.getByRole("button", { name: "Actualizar consumo" }));
		expect(screen.getByRole("button", { name: "Actualizar consumo" })).toBeDisabled();
		expect(
			within(screen.getByRole("article", { name: "Consumo de Codex" })).getByText("Datos anteriores"),
		).toBeVisible();
		expect(screen.getByRole("progressbar", { name: /76% disponible en la última lectura/ })).toBeTruthy();
		await act(async () => finish(snapshot()));
		expect(screen.queryByText("Datos anteriores")).toBeNull();
	});

	it("polls only while the open view is visible and stops on unmount", async () => {
		vi.useFakeTimers();
		const visibility = vi.spyOn(document, "visibilityState", "get");
		visibility.mockReturnValue("visible");
		const read = vi.fn(async () => snapshot());
		const view = render(<UsagePanel client={{ read }} />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(read).toHaveBeenCalledTimes(2);
		visibility.mockReturnValue("hidden");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(120_000);
		});
		expect(read).toHaveBeenCalledTimes(2);
		visibility.mockReturnValue("visible");
		await act(async () => {
			fireEvent(document, new Event("visibilitychange"));
		});
		expect(read).toHaveBeenCalledTimes(3);
		view.unmount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(120_000);
		});
		expect(read).toHaveBeenCalledTimes(3);
	});

	it("clears the previous account when switching connection and ignores its late reply", async () => {
		let resolveOld: (value: UsageSnapshot) => void = () => {};
		const old = {
			read: () =>
				new Promise<UsageSnapshot>((resolve) => {
					resolveOld = resolve;
				}),
		};
		const next = snapshot();
		Object.assign(next.providers[0] ?? {}, { plan: "Team" });
		const view = render(<UsagePanel client={old} />);
		view.rerender(<UsagePanel client={{ read: async () => next }} />);
		await waitFor(() => expect(screen.getByText("Team")).toBeTruthy());
		await act(async () => resolveOld(snapshot()));
		expect(screen.queryByText("Pro")).toBeNull();
	});
	it("shows relative resets, reserves unknown reset dates and folds secondary details", async () => {
		vi.setSystemTime(new Date("2026-10-11T06:00:00Z"));
		const data = snapshot();
		Object.assign(data.providers[0]?.windows[0] ?? {}, { resetAt: "2026-10-11T08:15:00Z" });
		data.providers[0]?.windows.push({ id: "extra", label: "Revisión", usedPercent: 5, remainingPercent: 95 });
		render(<UsagePanel client={{ read: async () => data }} />);
		expect(await screen.findByText("En 2 h 15 min")).toBeVisible();
		expect(screen.getAllByText("No informado")[0]).toBeVisible();
		expect(screen.getByText("Revisión").closest("details")).not.toHaveAttribute("open");
		await userEvent.click(screen.getByText("Otros límites (1)"));
		expect(screen.getByText("Revisión").closest("details")).toHaveAttribute("open");
		expect(screen.getByText("24% usado")).toBeVisible();
		expect(screen.getAllByText("Última lectura:")).toHaveLength(2);
		vi.useRealTimers();
	});

	it("respects the server cache deadline and refreshes once it expires while visible", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-11T06:00:00Z"));
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		const read = vi.fn(async () => ({
			...snapshot(),
			refreshAt: new Date(Date.now() + 60_000).toISOString(),
		}));
		render(<UsagePanel client={{ read }} />);
		await act(async () => {});
		expect(screen.getByRole("button", { name: "Actualizar consumo" })).toBeDisabled();
		expect(screen.getByText("Nueva consulta en 60s")).toBeTruthy();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(59_000);
		});
		expect(read).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Nueva consulta en 1s")).toBeTruthy();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(read).toHaveBeenCalledTimes(2);
		expect(screen.getByText("Nueva consulta en 60s")).toBeTruthy();
	});
});
