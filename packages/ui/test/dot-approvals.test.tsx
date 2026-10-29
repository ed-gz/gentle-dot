import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DotApprovalCards } from "../src/components/DotApprovalCards.tsx";
import type { OrchestrationClient } from "../src/orchestration.ts";

afterEach(() => {
	delete window.__GENTLE_MOBILE__;
	vi.restoreAllMocks();
	vi.useRealTimers();
});
const permission = {
	id: "exact-id",
	title: "Publicar cambios",
	message: "Resumen completo\nRepositorio: proyecto\nRama: feature\nMensaje: <script>no ejecutar</script>",
	expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
function client(): OrchestrationClient &
	Required<Pick<OrchestrationClient, "dotApprovals" | "answerDotApproval">> {
	return {
		snapshot: vi.fn(),
		act: vi.fn(),
		inspect: vi.fn(),
		dotApprovals: vi.fn(async () => ({ allowed: true, approvals: [permission] })),
		answerDotApproval: vi.fn(async () => {}),
	};
}

describe("Dot permissions on a trusted phone", () => {
	it("leaves background polling to Android and refreshes permissions immediately on return", async () => {
		vi.useFakeTimers();
		const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		const api = client();
		const { unmount } = render(<DotApprovalCards client={api} />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(api.dotApprovals).not.toHaveBeenCalled();
		visibility.mockReturnValue("visible");
		await act(async () => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(api.dotApprovals).toHaveBeenCalledOnce();
		visibility.mockReturnValue("hidden");
		await act(async () => {
			document.dispatchEvent(new Event("visibilitychange"));
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(api.dotApprovals).toHaveBeenCalledOnce();
		visibility.mockReturnValue("visible");
		await act(async () => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(api.dotApprovals).toHaveBeenCalledTimes(2);
		unmount();
	});

	it("renders full details as text and answers the exact request only after a human click", async () => {
		const api = client();
		render(<DotApprovalCards client={api} />);
		await screen.findByRole("heading", { name: "Publicar cambios" });
		expect(screen.getByText(/Resumen completo/).textContent).toBe(permission.message);
		expect(api.answerDotApproval).not.toHaveBeenCalled();
		expect(screen.queryByText("Permiso nocturno")).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Aprobar permiso de Dot" }));
		expect(api.answerDotApproval).toHaveBeenCalledExactlyOnceWith("exact-id", true);
	});

	it("passes the full reviewed card to a client that requires exact approval binding", async () => {
		const api = client();
		api.requiresReviewedApproval = true;
		render(<DotApprovalCards client={api} />);
		await userEvent.click(await screen.findByRole("button", { name: "Aprobar permiso de Dot" }));
		expect(api.answerDotApproval).toHaveBeenCalledExactlyOnceWith("exact-id", true, permission);
	});

	it("offers only refusal and points to the laptop when approval completeness is not guaranteed", async () => {
		const api = client(); api.requiresReviewedApproval = true; api.dotApprovalDeclineOnly = true;
		render(<DotApprovalCards client={api} />);
		expect(await screen.findByRole("button", {name:"Aprobar permiso de Dot"})).toBeDisabled();
		expect(screen.getByText(/revisa y responde en la laptop/)).toBeVisible();
		await userEvent.click(screen.getByRole("button", {name:"Rechazar permiso de Dot"}));
		expect(api.answerDotApproval).toHaveBeenCalledExactlyOnceWith("exact-id", false, permission);
	});

	it("allows rejection and blocks expired requests", async () => {
		const api = client();
		vi.mocked(api.dotApprovals).mockResolvedValue({
			allowed: true,
			approvals: [
				permission,
				{ ...permission, id: "old", title: "Vencido", expiresAt: new Date(0).toISOString() },
			],
		});
		render(<DotApprovalCards client={api} />);
		await screen.findByRole("heading", { name: "Publicar cambios" });
		const buttons = screen.getAllByRole("button", { name: "Rechazar permiso de Dot" });
		expect(buttons[1]).toBeDisabled();
		await userEvent.click(buttons[0] as HTMLElement);
		expect(api.answerDotApproval).toHaveBeenCalledExactlyOnceWith("exact-id", false);
	});

	it("explains re-pairing on Android when the device lacks approval authority", async () => {
		window.__GENTLE_MOBILE__ = { transcribe: vi.fn() };
		const api = client();
		vi.mocked(api.dotApprovals).mockResolvedValue({ allowed: false, approvals: [] });
		render(<DotApprovalCards client={api} />);
		expect(await screen.findByText(/vuelve a vincular este teléfono/)).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("hides phone-only permission controls on the desktop", async () => {
		const api = client();
		vi.mocked(api.dotApprovals).mockResolvedValue({ allowed: false, approvals: [] });
		render(<DotApprovalCards client={api} />);
		await waitFor(() => expect(api.dotApprovals).toHaveBeenCalledOnce());
		expect(screen.queryByRole("heading", { name: "Permisos de Gentle Dot" })).not.toBeInTheDocument();
	});

	it("does not retry a response after connection failure", async () => {
		const api = client();
		vi.mocked(api.answerDotApproval).mockRejectedValue(new Error("Sin conexión"));
		render(<DotApprovalCards client={api} />);
		await userEvent.click(await screen.findByRole("button", { name: "Aprobar permiso de Dot" }));
		await waitFor(() => expect(api.dotApprovals).toHaveBeenCalledTimes(2));
		expect(screen.getByRole("alert")).toHaveTextContent("Sin conexión");
		expect(api.answerDotApproval).toHaveBeenCalledOnce();
	});
});

it("never carries approval authority or responses into another computer", async () => {
	const first = client(),
		second = client();
	let finish!: () => void;
	vi.mocked(first.answerDotApproval).mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	vi.mocked(second.dotApprovals).mockResolvedValue({ allowed: false, approvals: [] });
	const view = render(<DotApprovalCards client={first} />);
	await userEvent.click(await screen.findByRole("button", { name: "Aprobar permiso de Dot" }));
	expect(screen.getByText("Enviando respuesta…")).toBeVisible();
	view.rerender(<DotApprovalCards client={second} />);
	expect(screen.queryByRole("button", { name: "Aprobar permiso de Dot" })).toBeNull();
	await act(async () => finish());
	await waitFor(() => expect(second.dotApprovals).toHaveBeenCalledOnce());
	expect(second.answerDotApproval).not.toHaveBeenCalled();
	expect(screen.queryByRole("heading", { name: "Publicar cambios" })).toBeNull();
});

it("blocks double taps immediately and does not accept a malformed or missing deadline", async () => {
	const api = client();
	let finish!: () => void;
	vi.mocked(api.answerDotApproval).mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	vi.mocked(api.dotApprovals).mockResolvedValue({
		allowed: true,
		approvals: [permission, { ...permission, id: "bad", title: "Sin vencimiento", expiresAt: "" }],
	});
	render(<DotApprovalCards client={api} />);
	const buttons = await screen.findAllByRole("button", { name: "Aprobar permiso de Dot" });
	expect(buttons[1]).toBeDisabled();
	fireEvent.click(buttons[0] as HTMLElement);
	fireEvent.click(buttons[0] as HTMLElement);
	expect(api.answerDotApproval).toHaveBeenCalledOnce();
	await act(async () => finish());
});

it("expires Dot permissions on time without waiting for the next server poll", async () => {
	vi.useFakeTimers();
	const api = client();
	vi.mocked(api.dotApprovals).mockResolvedValue({
		allowed: true,
		approvals: [{ ...permission, expiresAt: new Date(Date.now() + 1000).toISOString() }],
	});
	render(<DotApprovalCards client={api} />);
	await act(async () => {});
	expect(screen.getByRole("button", { name: "Aprobar permiso de Dot" })).toBeEnabled();
	await act(() => vi.advanceTimersByTimeAsync(1001));
	expect(screen.getByRole("button", { name: "Aprobar permiso de Dot" })).toBeDisabled();
	expect(api.dotApprovals).toHaveBeenCalledOnce();
	expect(api.answerDotApproval).not.toHaveBeenCalled();
});
