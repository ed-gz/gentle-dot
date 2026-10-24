import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { PhoneSettings } from "../src/components/SettingsGroups.tsx";
import { initialState } from "../src/store.ts";

vi.mock("../../../apps/mobile/src/native.ts", () => ({
	nativeAndroid: true,
	GentleMobile: { monitorState: vi.fn(async () => ({ connected: true, notificationsEnabled: true })) },
	readNotificationPreferences: vi.fn(async () => ({ inApp: true, dotReplies: true, permissions: true, agentCompleted: true, agentAttention: true, sound: true })),
	saveNotificationPreferences: vi.fn(async value => value),
}));

// Load the shell fixture at runtime: it belongs to a separate TypeScript project.
const shellSettingsPath = `${process.cwd()}/apps/mobile/src/NotificationSettings.tsx`;
const { NotificationSettings } = await import(shellSettingsPath);

it("places phone overlay controls in Capri, not Avisos", async () => {
	render(<ChatSurface variant="web" state={{ ...initialState, connection: "open" }} send={vi.fn()} dispatch={vi.fn()} dismiss={vi.fn()}
		mobileControls={<PhoneSettings capri={<button type="button">Sobre otras apps</button>} avisos={<button type="button">Mis avisos</button>} equipo={<button type="button">Desvincular teléfono</button>} />} />);
	await userEvent.click(screen.getByRole("button", { name: "Ajustes" }));
	const capri = screen.getByText("Capri", { selector: "summary" }).closest("details")!;
	const avisos = screen.getByText("Avisos", { selector: "summary" }).closest("details")!;
	await userEvent.click(within(capri).getByText("Capri", { selector: "summary" }));
	expect(within(capri).getByRole("button", { name: "Sobre otras apps" })).toBeVisible();
	expect(within(avisos).queryByText("Sobre otras apps")).not.toBeInTheDocument();
});

it("shows essential notifications with remaining switches behind Más opciones", async () => {
	const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({ enabled: false }) } as Response);
	render(<NotificationSettings connection={{ url: "https://example.test", token: "test", deviceId: "phone" }} monitoring monitorBusy={false} onToggleMonitor={vi.fn()} />);
	expect(await screen.findByRole("switch", { name: "Solicitudes de permiso" })).toBeVisible();
	expect(screen.getByRole("switch", { name: "Sonido" })).not.toBeVisible();
	await userEvent.click(screen.getByText("Más opciones", { selector: "summary" }));
	expect(screen.getByRole("switch", { name: "Sonido" })).toBeVisible();
	fetcher.mockRestore();
});
