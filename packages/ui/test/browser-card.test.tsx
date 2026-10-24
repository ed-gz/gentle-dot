import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BrowserCard } from "../src/components/BrowserCard.tsx";
import type { BrowserInstallation, BrowserStatus, OrchestrationClient } from "../src/orchestration.ts";

const inactive: BrowserStatus = {
	available: true,
	active: false,
	running: false,
	mode: "headless",
	tabs: [],
	desktopControl: "native-app",
};
const active: BrowserStatus = {
	...inactive,
	active: true,
	running: true,
	expiresAt: new Date(Date.now() + 1800_000).toISOString(),
	tabs: [{ id: "tab1", title: "Prueba local", url: "https://example.test/" }],
};
function client(): OrchestrationClient &
	Required<Pick<OrchestrationClient, "browserStatus" | "browserAction">> {
	return {
		snapshot: vi.fn(),
		act: vi.fn(),
		inspect: vi.fn(),
		browserStatus: vi.fn(async () => inactive),
		browserAction: vi.fn(async () => active),
	};
}

describe("human browser access", () => {
	it("requires deliberate consent and offers optional expiration and a visible login window", async () => {
		const api = client();
		render(<BrowserCard client={api} />);
		await screen.findByText("Listo para activar");
		await userEvent.click(screen.getByRole("button", { name: "Ver navegador" }));
		const start = screen.getByRole("button", { name: "Activar navegador" });
		expect(start).toBeDisabled();
		await userEvent.click(screen.getByText("Limitar duración"));
		await userEvent.selectOptions(screen.getByLabelText("Desactivar automáticamente"), "480");
		await userEvent.click(screen.getByLabelText("Mostrar una ventana en el equipo para iniciar sesión"));
		expect(api.browserAction).not.toHaveBeenCalled();
		await userEvent.click(screen.getByLabelText("Permitir que Dot use este navegador."));
		await userEvent.click(start);
		expect(api.browserAction).toHaveBeenCalledExactlyOnceWith(
			{
				action: "start",
				minutes: 480,
				window: true,
			},
			expect.any(AbortSignal),
		);
	});

	it("keeps stop available during launch and ignores a late launch result after stopping", async () => {
		const api = client();
		let finish!: (value: BrowserStatus) => void;
		vi.mocked(api.browserAction).mockImplementation(async (action) =>
			action.action === "start"
				? new Promise<BrowserStatus>((resolve) => {
						finish = resolve;
					})
				: inactive,
		);
		render(<BrowserCard client={api} />);
		await screen.findByText("Listo para activar");
		await userEvent.click(screen.getByRole("button", { name: "Ver navegador" }));
		await userEvent.click(screen.getByLabelText("Permitir que Dot use este navegador."));
		await userEvent.click(screen.getByRole("button", { name: "Activar navegador" }));
		await screen.findByText("Abriendo navegador…");
		await userEvent.click(screen.getByRole("button", { name: "Detener navegador y revocar acceso" }));
		expect(api.browserAction).toHaveBeenLastCalledWith({ action: "stop" }, expect.any(AbortSignal));
		await act(async () => {
			finish(active);
		});
		expect(screen.getByText("Listo para activar")).toBeInTheDocument();
		expect(screen.queryByText(/Activo hasta/)).not.toBeInTheDocument();
	});

	it("shows a requested page capture and text without opening a website in the phone", async () => {
		const api = client();
		vi.mocked(api.browserStatus).mockResolvedValue(active);
		vi.mocked(api.browserAction).mockResolvedValue({
			tabId: "tab1",
			snapshotId: "snap1",
			title: "Prueba local",
			url: "https://example.test/",
			text: "Texto de la página de prueba",
			image: { mime: "image/jpeg", data: "abcd" },
		});
		render(<BrowserCard client={api} />);
		await screen.findByText(/Activo hasta/);
		await userEvent.click(screen.getByRole("button", { name: "Ver navegador" }));
		await userEvent.click(screen.getByRole("button", { name: "Ver página: Prueba local" }));
		expect(api.browserAction).toHaveBeenCalledExactlyOnceWith(
			{
				action: "snapshot",
				tabId: "tab1",
				screenshot: true,
			},
			expect.any(AbortSignal),
		);
		expect(await screen.findByAltText("Vista de Prueba local")).toHaveAttribute(
			"src",
			"data:image/jpeg;base64,abcd",
		);
		expect(screen.getByText("Texto de la página de prueba")).toBeInTheDocument();
	});

	it("preserves a launch error, does not retry a grant and allows a deliberate retry", async () => {
		const api = client();
		vi.mocked(api.browserAction).mockRejectedValue(new Error("No hay sesión gráfica"));
		render(<BrowserCard client={api} />);
		await screen.findByText("Listo para activar");
		await userEvent.click(screen.getByRole("button", { name: "Ver navegador" }));
		await userEvent.click(screen.getByLabelText("Permitir que Dot use este navegador."));
		await userEvent.click(screen.getByRole("button", { name: "Activar navegador" }));
		await waitFor(() => expect(api.browserStatus).toHaveBeenCalledTimes(2));
		expect(screen.getByRole("alert")).toHaveTextContent("No hay sesión gráfica");
		expect(api.browserAction).toHaveBeenCalledOnce();
		expect(screen.getByRole("button", { name: "Activar navegador" })).toBeEnabled();
	});
});

it("keeps browser access until revoked by default and never invents an expiry time", async () => {
	const api = client();
	vi.mocked(api.browserStatus)
		.mockResolvedValueOnce(inactive)
		.mockResolvedValue({ ...inactive, active: true, running: true });
	vi.mocked(api.browserAction).mockResolvedValue({ ...inactive, active: true, running: true });
	render(<BrowserCard client={api} />);
	await screen.findByText("Listo para activar");
	await userEvent.click(screen.getByRole("button", { name: "Ver navegador" }));
	await userEvent.click(screen.getByLabelText("Permitir que Dot use este navegador."));
	await userEvent.click(screen.getByRole("button", { name: "Activar navegador" }));
	expect(api.browserAction).toHaveBeenCalledExactlyOnceWith(
		{ action: "start", window: false },
		expect.any(AbortSignal),
	);
	expect(await screen.findByText("Acceso activado")).toBeVisible();
	expect(screen.queryByText(/Invalid Date|nocturno|noche/)).toBeNull();
});

it("offers installation only when the computer supports it and never collects a system password", async () => {
	const api = client();
	vi.mocked(api.browserStatus).mockResolvedValue({ ...inactive, available: false, canRequestInstall: true });
	let finish!: (result: BrowserInstallation) => void;
	vi.mocked(api.browserAction).mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const view = render(<BrowserCard client={api} />);
	await screen.findByText("No disponible");
	await userEvent.click(screen.getByRole("button", { name: "Ver navegador" }));
	expect(api.browserAction).not.toHaveBeenCalled();
	await userEvent.dblClick(screen.getByRole("button", { name: "Instalar Chromium en el equipo" }));
	expect(api.browserAction).toHaveBeenCalledExactlyOnceWith(
		{ action: "install_browser", reason: "Quiero habilitar el navegador de Gentle Dot." },
		expect.any(AbortSignal),
	);
	expect(screen.getByText(/La contraseña se escribe únicamente en el diálogo del sistema/)).toBeVisible();
	expect(view.container.querySelector('input[type="password"]')).toBeNull();
	expect(screen.queryByRole("button", { name: "Instalar Chromium en el equipo" })).toBeNull();
	await act(async () =>
		finish({ requestId: "install-1", status: "denied", message: "El sistema no autorizó la instalación." }),
	);
	expect(screen.getByText("El sistema no autorizó la instalación.")).toBeVisible();
	expect(api.browserAction).toHaveBeenCalledOnce();
});

it("reports cancellation as requested until the actual computer result arrives", async () => {
	const api = client();
	const pending: BrowserInstallation = {
		requestId: "install-1",
		status: "pending",
		message: "Esperando autorización en el equipo.",
	};
	vi.mocked(api.browserStatus).mockResolvedValue({ ...inactive, available: false, canRequestInstall: true });
	let finish!: (result: BrowserInstallation) => void;
	vi.mocked(api.browserAction).mockImplementation(async (action) =>
		action.action === "install_browser"
			? new Promise((resolve) => {
					finish = resolve;
				})
			: { ...inactive, installation: pending },
	);
	render(<BrowserCard client={api} />);
	await screen.findByText("No disponible");
	await userEvent.click(screen.getByRole("button", { name: "Ver navegador" }));
	await userEvent.click(screen.getByRole("button", { name: "Instalar Chromium en el equipo" }));
	await userEvent.dblClick(screen.getByRole("button", { name: "Cancelar solicitud" }));
	expect(api.browserAction).toHaveBeenCalledTimes(2);
	expect(api.browserAction).toHaveBeenLastCalledWith({ action: "stop" });
	expect(screen.getByText(/Cancelación solicitada. Si la instalación ya comenzó/)).toBeVisible();
	expect(screen.getByRole("button", { name: "Cancelar solicitud" })).toBeDisabled();
	await act(async () =>
		finish({
			requestId: "install-1",
			status: "succeeded",
			message: "Chromium quedó instalado en el equipo.",
		}),
	);
	expect(screen.getByText("Chromium quedó instalado en el equipo.")).toBeVisible();
	expect(screen.queryByText(/Cancelación solicitada/)).toBeNull();
});

it("recovers a pending installation after reconnecting, without starting another request", async () => {
	const api = client();
	vi.mocked(api.browserStatus).mockResolvedValue({
		...inactive,
		available: false,
		canRequestInstall: true,
		installation: { requestId: "earlier", status: "pending", message: "Esperando al sistema." },
	});
	render(<BrowserCard client={api} />);
	await screen.findByRole("button", { name: "Cancelar solicitud" });
	await userEvent.click(screen.getByRole("button", { name: "Ver navegador" }));
	expect(screen.queryByRole("button", { name: "Instalar Chromium en el equipo" })).toBeNull();
	expect(api.browserAction).not.toHaveBeenCalled();
});

it("does not imply cancellation if the cancellation request fails", async () => {
	const api = client();
	vi.mocked(api.browserStatus).mockResolvedValue({
		...inactive,
		available: false,
		installation: { requestId: "earlier", status: "pending", message: "Esperando al sistema." },
	});
	vi.mocked(api.browserAction).mockRejectedValue(new Error("Se perdió la conexión con el equipo."));
	render(<BrowserCard client={api} />);
	await userEvent.click(await screen.findByRole("button", { name: "Cancelar solicitud" }));
	expect(screen.getByRole("alert")).toHaveTextContent("Se perdió la conexión");
	expect(screen.queryByText(/Cancelación solicitada/)).toBeNull();
	expect(screen.getByRole("button", { name: "Cancelar solicitud" })).toBeEnabled();
	expect(api.browserAction).toHaveBeenCalledOnce();
});

it("aborts pending authorization when leaving the view and ignores its late result on another computer", async () => {
	const api = client(),
		other = client();
	vi.mocked(api.browserStatus).mockResolvedValue({ ...inactive, available: false, canRequestInstall: true });
	let finish!: (result: BrowserInstallation) => void;
	vi.mocked(api.browserAction).mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const view = render(<BrowserCard client={api} />);
	await screen.findByText("No disponible");
	await userEvent.click(screen.getByRole("button", { name: "Ver navegador" }));
	await userEvent.click(screen.getByRole("button", { name: "Instalar Chromium en el equipo" }));
	const signal = vi.mocked(api.browserAction).mock.calls[0]?.[1];
	expect(signal?.aborted).toBe(false);
	view.rerender(<BrowserCard client={other} />);
	expect(signal?.aborted).toBe(true);
	await screen.findByText("Listo para activar");
	await act(async () =>
		finish({ requestId: "old", status: "succeeded", message: "Resultado del equipo anterior" }),
	);
	expect(screen.queryByText("Resultado del equipo anterior")).toBeNull();
	expect(other.browserAction).not.toHaveBeenCalled();
});
