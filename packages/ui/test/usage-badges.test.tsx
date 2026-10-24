import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { UsageBadges, priorityWindow } from "../src/components/UsageBadges.tsx";
import { UsageBadgeSettings } from "../src/components/UsageBadgeSettings.tsx";
import { initialState } from "../src/store.ts";
import type { ProviderUsage, UsageClient, UsageSnapshot, UsageWindow } from "../src/usage.ts";
import { defaultUsageBadges, parseUsageBadgePreferences, USAGE_BADGE_KEY } from "../src/useUsageBadges.ts";

const five = (): UsageWindow => ({ id: "primary_window", label: "5 horas", usedPercent: 24, remainingPercent: 76, windowDurationMins: 300 });
const weekly = (): UsageWindow => ({ id: "secondary_window", label: "Semana", usedPercent: 81, remainingPercent: 19, windowDurationMins: 10080 });
const provider = (patch: Partial<ProviderUsage> = {}): ProviderUsage => ({
	id: "codex", label: "Codex", status: "ok", checkedAt: new Date().toISOString(), windows: [weekly(), five()], ...patch,
});
const clientFor = (...providers: ProviderUsage[]): UsageClient => ({ read: vi.fn(async () => ({ providers })) });

beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("shows only 5h used percentage when weekly also exists", async () => {
	render(<UsageBadges client={clientFor(provider())} />);
	const badge = await screen.findByRole("img", { name: "Codex, 5 horas: 24% usado" });
	expect(badge).toHaveTextContent("24%");
	expect(badge.querySelector("img")).toHaveAttribute("aria-hidden", "true");
	expect(badge.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
	expect(screen.queryByText("81%")).not.toBeInTheDocument();
});

it("falls back to weekly, supports both providers, and uses used not remaining percent", async () => {
	render(<UsageBadges client={clientFor(provider({ windows: [weekly()] }), provider({ id: "claude", label: "Claude", windows: [{ ...five(), id: "five_hour", windowDurationMins: undefined, usedPercent: 67.5, remainingPercent: 32.5 }] }))} />);
	expect(await screen.findByRole("img", { name: "Codex, Semana: 81% usado" })).toHaveTextContent("81%");
	expect(screen.getByRole("img", { name: "Claude, 5 horas: 67,5% usado" })).toHaveTextContent("67,5%");
	expect(screen.queryByText("32,5%")).not.toBeInTheDocument();
});

it("recognizes Claude weekly IDs and prefers general quota over model-specific windows", () => {
	const settings = defaultUsageBadges();
	const general = { ...weekly(), id: "seven_day", windowDurationMins: undefined };
	expect(priorityWindow(provider({ id: "claude", windows: [{ ...weekly(), id: "seven_day_sonnet" }, general] }), settings)).toBe(general);
	settings.providers.codex.priority = "weekly";
	expect(priorityWindow(provider(), settings)?.id).toBe("secondary_window");
	settings.providers.codex.weekly = false;
	expect(priorityWindow(provider(), settings)?.id).toBe("primary_window");
});

it.each([
	["stale provider", { stale: true }],
	["failed provider with cached data", { status: "error" as const }],
	["elapsed reset", { windows: [{ ...five(), resetAt: "2000-01-01T00:00:00Z" }] }],
])("labels %s as an earlier reading, not current zero", async (_name, patch) => {
	render(<UsageBadges client={clientFor(provider(patch))} />);
	expect(await screen.findByRole("img", { name: "Codex, 5 horas: 24% usado · lectura anterior" })).toHaveTextContent("24%*");
	expect(screen.queryByText("0%")).not.toBeInTheDocument();
});

it.each([
	["empty", []],
	["unknown duration", [{ ...five(), id: "unknown", windowDurationMins: 42 }]],
	["missing percentage", [{ ...five(), usedPercent: undefined }]],
	["non-finite percentage", [{ ...five(), usedPercent: NaN }]],
])("shows unavailable for %s windows without fabricating 0", async (_name, windows) => {
	render(<UsageBadges client={clientFor(provider({ windows: windows as UsageWindow[] }))} />);
	const badge = await screen.findByRole("img", { name: /Codex, .*: no disponible/ });
	expect(badge).toHaveTextContent("—");
	expect(screen.queryByText("0%")).not.toBeInTheDocument();
});

it("does not show disconnected providers or invent them for an empty response", async () => {
	const client = clientFor(provider({ status: "unauthenticated", windows: [] }));
	render(<UsageBadges client={client} />);
	await waitFor(() => expect(client.read).toHaveBeenCalled());
	expect(screen.queryByRole("img")).not.toBeInTheDocument();
	expect(screen.queryByText("0%")).not.toBeInTheDocument();
});

it("keeps actual zero distinct from unknown", async () => {
	render(<UsageBadges client={clientFor(provider({ windows: [{ ...five(), usedPercent: 0, remainingPercent: 100 }] }))} />);
	expect(await screen.findByRole("img", { name: "Codex, 5 horas: 0% usado" })).toHaveTextContent("0%");
});

it("reports transport failure without rendering error contents or made-up percentages", async () => {
	render(<UsageBadges client={{ read: async () => { throw new Error("private internal detail"); } }} />);
	expect(await screen.findByRole("status")).toHaveTextContent("Consumo no disponible");
	expect(screen.queryByText(/private|0%/)).not.toBeInTheDocument();
});

it("refreshes at the server cooldown, retains prior reading on error and aborts on unmount", async () => {
	vi.useFakeTimers();
	let signal: AbortSignal | undefined;
	const read = vi.fn(async (nextSignal?: AbortSignal): Promise<UsageSnapshot> => {
		signal = nextSignal;
		if (read.mock.calls.length > 1) throw new Error("offline");
		return { providers: [provider()], refreshAt: new Date(Date.now() + 120_000).toISOString() };
	});
	const view = render(<UsageBadges client={{ read }} />);
	await act(async () => {});
	expect(read).toHaveBeenCalledTimes(1);
	await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
	expect(read).toHaveBeenCalledTimes(1);
	await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
	expect(read).toHaveBeenCalledTimes(2);
	expect(screen.getByRole("img", { name: /lectura anterior/ })).toHaveTextContent("24%*");
	view.unmount();
	expect(signal?.aborted).toBe(true);
});

describe("local configuration", () => {
	it("keeps labeled settings without the static usage instructions", () => {
		render(<UsageBadgeSettings />);
		fireEvent.click(screen.getByText("Porcentajes de consumo"));
		expect(screen.getByLabelText("Mostrar porcentajes de consumo")).toBeEnabled();
		expect(screen.getByLabelText("Prioridad de Codex")).toBeEnabled();
		expect(screen.getByLabelText("Ventana semanal de Claude")).toBeEnabled();
		expect(screen.queryByText(/Porcentaje usado junto al acceso a consumo/)).not.toBeInTheDocument();
	});
	it.each([null, "{", "null", "[]", '{"version":2}', '{"version":1,"visible":"false"}', '{"version":1,"visible":false,"providers":{}}'])("safely defaults malformed preferences %s", (raw) => {
		expect(parseUsageBadgePreferences(raw)).toEqual(defaultUsageBadges());
	});

	it("persists provider/window priority and visibility, hides badges without hiding details", async () => {
		const client = clientFor(provider(), provider({ id: "claude", label: "Claude" }));
		const view = render(<><UsageBadgeSettings /><UsageBadges client={client} /><button>Ver consumo</button></>);
		fireEvent.click(screen.getByText("Porcentajes de consumo"));
		await screen.findByRole("img", { name: "Codex, 5 horas: 24% usado" });
		fireEvent.change(screen.getByLabelText("Prioridad de Codex"), { target: { value: "weekly" } });
		expect(screen.getByRole("img", { name: "Codex, Semana: 81% usado" })).toBeInTheDocument();
		fireEvent.click(screen.getByLabelText("Ventana semanal de Codex"));
		expect(screen.getByRole("img", { name: "Codex, 5 horas: 24% usado" })).toBeInTheDocument();
		fireEvent.click(screen.getByLabelText("Mostrar Claude"));
		expect(screen.queryByRole("img", { name: /^Claude,/ })).not.toBeInTheDocument();
		const saved = parseUsageBadgePreferences(localStorage.getItem(USAGE_BADGE_KEY));
		expect(saved.providers.codex).toMatchObject({ priority: "weekly", weekly: false });
		expect(saved.providers.claude.visible).toBe(false);
		view.unmount();
		render(<><UsageBadgeSettings /><UsageBadges client={client} /><button>Ver consumo</button></>);
		fireEvent.click(screen.getByText("Porcentajes de consumo"));
		expect(screen.getByLabelText("Prioridad de Codex")).toHaveValue("weekly");
		fireEvent.click(screen.getByLabelText("Mostrar porcentajes de consumo"));
		expect(screen.queryByLabelText("Consumo resumido")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Ver consumo" })).toBeEnabled();
		expect(parseUsageBadgePreferences(localStorage.getItem(USAGE_BADGE_KEY)).visible).toBe(false);
	});

	it("does not fetch when hidden and reacts to other windows' preferences", async () => {
		const preferences = defaultUsageBadges();
		preferences.visible = false;
		localStorage.setItem(USAGE_BADGE_KEY, JSON.stringify(preferences));
		const client = clientFor(provider());
		render(<UsageBadges client={client} />);
		expect(client.read).not.toHaveBeenCalled();
		act(() => {
			localStorage.setItem(USAGE_BADGE_KEY, JSON.stringify(defaultUsageBadges()));
			window.dispatchEvent(new StorageEvent("storage", { key: USAGE_BADGE_KEY }));
		});
		expect(await screen.findByRole("img", { name: /Codex,/ })).toBeInTheDocument();
	});
});

it.each([true, false])("places badges immediately left of working details in mobile=%s", async (mobile) => {
	render(<ChatSurface variant="web" state={{ ...initialState, connection: "open", agentState: "idle" }} send={() => true} dismiss={() => {}} usage={clientFor(provider())} {...(mobile ? { mobileControls: <span>Teléfono</span> } : {})} />);
	const badge = await screen.findByRole("img", { name: "Codex, 5 horas: 24% usado" });
	const shortcut = screen.getByRole("button", { name: "Ver consumo" });
	expect(badge.parentElement?.nextElementSibling).toBe(shortcut);
	fireEvent.click(shortcut);
	expect(await screen.findByRole("region", { name: "Uso de suscripciones" })).toBeInTheDocument();
	expect(await screen.findByText("24% usado")).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Volver a Dot" }));
	await waitFor(() => expect(screen.queryByRole("region", { name: "Uso de suscripciones" })).not.toBeInTheDocument());
});
