import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { OrchestrationPanel } from "../src/components/OrchestrationPanel.tsx";
import type { AgentConversation, OrchestrationClient, OrchestrationSnapshot } from "../src/orchestration.ts";
import type { OrchestrationControls } from "../src/useOrchestration.ts";

const snapshot: OrchestrationSnapshot = {
	available: true,
	approvals: [],
	policies: [],
	events: [],
	sessions: [
		{
			paneId: "pane",
			sessionId: "session",
			terminalId: "term",
			workspaceId: "work",
			label: "Proyecto",
			state: "working",
			connected: true,
			managed: true,
			capabilities: {
				inspect: true,
				prompt: true,
				abort: true,
				approvals: true,
				deliveryReceipts: true,
				deliveryModes: ["steer", "followUp"],
			},
		},
	],
};
const page: AgentConversation = { sessionId: "session", status: "working", messages: [], question: null };

it("restores a pending native delivery when opening the conversation without a local draft", async () => {
	const controls: OrchestrationControls = { snapshot, busy: false, refresh: vi.fn(), act: vi.fn() };
	const client: OrchestrationClient = { snapshot: vi.fn(), act: vi.fn(), inspect: vi.fn(async () => ({
		...page, deliveries: [{ id: "restored-delivery", preview: "Mensaje enviado antes de abrir", status: "queued" as const, deliverAs: "followUp" as const, acceptedAt: new Date().toISOString() }],
	})) };
	render(<OrchestrationPanel client={client} controls={controls} />);
	await userEvent.click(screen.getByRole("button", { name: "Proyecto · Trabajando" }));
	expect(await screen.findByText("Mensaje enviado antes de abrir")).toBeVisible();
	expect(screen.getByText("En cola; la sesión todavía no ha recibido el mensaje.")).toBeVisible();
	expect(controls.act).not.toHaveBeenCalled();
});

it("shows sending, accepted, queued and consumed separately while the user retains control over delivery timing", async () => {
	let accept!: (result: boolean) => void;
	const controls: OrchestrationControls = {
		snapshot,
		busy: false,
		refresh: vi.fn(),
		act: vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					accept = resolve;
				}),
		),
	};
	const client: OrchestrationClient = { snapshot: vi.fn(), act: vi.fn(), inspect: vi.fn(async () => page) };
	render(<OrchestrationPanel client={client} controls={controls} />);
	await userEvent.click(screen.getByRole("button", { name: "Proyecto · Trabajando" }));
	fireEvent.change(screen.getByLabelText("Continuar esta sesión"), {
		target: { value: "Revisa primero la compilación" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
	expect(await screen.findByText("Enviando al equipo…")).toBeVisible();
	expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("Revisa primero la compilación");
	const sent = vi.mocked(controls.act).mock.calls[0]![0];
	expect(sent).toMatchObject({ action: "prompt", deliverAs: "steer", clientMessageId: expect.any(String) });
	if (sent.action !== "prompt") throw new Error("Expected prompt");
	await act(async () => accept(true));
	expect(
		await screen.findByText("Recibido por la conexión; esperando confirmación de la sesión."),
	).toBeVisible();
	expect(screen.queryByText("Recibido por la sesión")).toBeNull();
	expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("");
	const delivery = {
		id: sent.clientMessageId!,
		status: "queued" as const,
		deliverAs: "steer" as const,
		acceptedAt: new Date().toISOString(),
	};
	vi.mocked(client.inspect).mockResolvedValue({ ...page, deliveries: [delivery] });
	fireEvent(document, new Event("visibilitychange"));
	expect(await screen.findByText("En cola; la sesión todavía no ha recibido el mensaje.")).toBeVisible();
	vi.mocked(client.inspect).mockResolvedValue({
		...page,
		deliveries: [{ ...delivery, status: "delivered" }],
	});
	fireEvent(document, new Event("visibilitychange"));
	expect(await screen.findByText("Recibido por la sesión")).toBeVisible();
	await userEvent.selectOptions(screen.getByLabelText("Entrega del mensaje"), "followUp");
	fireEvent.change(screen.getByLabelText("Continuar esta sesión"), {
		target: { value: "Después revisa pruebas" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
	await waitFor(() => expect(controls.act).toHaveBeenCalledTimes(2));
	expect(vi.mocked(controls.act).mock.calls[1]![0]).toMatchObject({ deliverAs: "followUp" });
});

it("retains failed acknowledgement and reuses its ID only for an explicit retry of the same payload", async () => {
	const controls: OrchestrationControls = {
		snapshot,
		busy: false,
		refresh: vi.fn(),
		act: vi.fn(async () => false),
	};
	const client: OrchestrationClient = { snapshot: vi.fn(), act: vi.fn(), inspect: vi.fn(async () => page) };
	render(<OrchestrationPanel client={client} controls={controls} />);
	await userEvent.click(screen.getByRole("button", { name: "Proyecto · Trabajando" }));
	fireEvent.change(screen.getByLabelText("Continuar esta sesión"), {
		target: { value: "Mensaje para reintentar" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
	expect(await screen.findByText("Sin confirmación. Revisa el historial antes de reintentar.")).toBeVisible();
	expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("Mensaje para reintentar");
	fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
	await waitFor(() => expect(controls.act).toHaveBeenCalledTimes(2));
	expect(vi.mocked(controls.act).mock.calls[0]).toEqual(vi.mocked(controls.act).mock.calls[1]);
});
