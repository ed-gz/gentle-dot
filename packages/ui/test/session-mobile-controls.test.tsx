import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { OrchestrationPanel } from "../src/components/OrchestrationPanel.tsx";
import type { AgentConversation, OrchestrationClient, OrchestrationSnapshot } from "../src/orchestration.ts";
import type { OrchestrationControls } from "../src/useOrchestration.ts";

function fixture() {
	const snapshot: OrchestrationSnapshot = {
		available: true,
		policies: [],
		events: [],
		sessions: [
			{
				paneId: "pane",
				sessionId: "session",
				terminalId: "terminal",
				workspaceId: "workspace",
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
		approvals: [
			{
				id: "ask",
				paneId: "pane",
				sessionId: "session",
				title: "¿Publicar los cambios?",
				message: "Requiere tu autorización.",
				action: "push",
				createdAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
				answerable: true,
			},
		],
	};
	const conversation: AgentConversation = {
		sessionId: "session",
		status: "working",
		question: null,
		metadata: { version: 1, model: { id: "model", name: "Modelo de prueba", provider: "fixture" } },
		messages: [
			{
				id: "answer",
				role: "assistant",
				content: [{ type: "text", text: "La conversación sigue disponible." }],
			},
		],
		work: {
			version: 1,
			truncated: false,
			plan: {
				source: "live",
				completed: 1,
				total: 2,
				tasks: [{ id: "task", title: "Comprobar la interfaz", status: "in_progress" }],
			},
			commands: [{ id: "command", tool: "bash", label: "pnpm test", status: "running", source: "live" }],
			agents: [{ id: "past", agent: "Finalizado", source: "history", status: "completed" }],
		},
	};
	const controls: OrchestrationControls = {
		snapshot,
		busy: false,
		refresh: vi.fn(),
		act: vi.fn(async () => true),
	};
	const client: OrchestrationClient = {
		snapshot: vi.fn(),
		act: vi.fn(),
		inspect: vi.fn(async () => conversation),
	};
	return { client, controls, conversation };
}

async function openSession() {
	await userEvent.click(screen.getByRole("button", { name: "Proyecto · Trabajando" }));
	await screen.findByText("La conversación sigue disponible.");
}

it("starts mobile details collapsed without hiding the conversation or a pending permission", async () => {
	const { client, controls } = fixture();
	render(<OrchestrationPanel mobile client={client} controls={controls} />);
	await openSession();
	const details = screen.getByRole("button", { name: /Detalles y actividad/ });
	expect(details).toHaveAttribute("aria-expanded", "false");
	expect(details).toHaveAccessibleDescription("Plan 1/2 · 1 herramienta");
	expect(screen.queryByRole("button", { name: /Ver información de la sesión/ })).toBeNull();
	expect(screen.getByText("¿Publicar los cambios?")).toBeVisible();
	expect(screen.getByText("La conversación sigue disponible.")).toBeVisible();
	await userEvent.click(details);
	expect(screen.getByRole("button", { name: /Ver información de la sesión/ })).toBeVisible();
	expect(screen.getByRole("region", { name: "Plan de trabajo" })).toBeVisible();
	expect(screen.getByRole("button", { name: "Ambiente de terminal" })).toBeVisible();
	expect(controls.act).not.toHaveBeenCalled();
});

it("changes delivery inside the screen without sending or losing the draft, then sends the chosen mode", async () => {
	const { client, controls } = fixture();
	render(<OrchestrationPanel mobile client={client} controls={controls} />);
	await openSession();
	const draft = screen.getByLabelText("Continuar esta sesión");
	await userEvent.type(draft, "Revisa después las pruebas");
	expect(screen.queryByRole("combobox", { name: "Entrega del mensaje" })).toBeNull();
	await userEvent.click(screen.getByRole("button", { name: "Entrega del mensaje: En la próxima pausa" }));
	expect(screen.getByRole("button", { name: "En la próxima pausa" })).toHaveAttribute("aria-pressed", "true");
	await userEvent.click(screen.getByRole("button", { name: "Al terminar" }));
	expect(screen.getByRole("button", { name: "Entrega del mensaje: Al terminar" })).toHaveFocus();
	expect(screen.queryByRole("group", { name: "Cuándo recibirá tu mensaje" })).toBeNull();
	expect(draft).toHaveValue("Revisa después las pruebas");
	expect(controls.act).not.toHaveBeenCalled();
	await userEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
	await waitFor(() =>
		expect(controls.act).toHaveBeenCalledExactlyOnceWith({
			action: "prompt",
			paneId: "pane",
			sessionId: "session",
			text: "Revisa después las pruebas",
			clientMessageId: expect.any(String),
			deliverAs: "followUp",
		}),
	);
	expect(
		await screen.findByText("Recibido por la conexión; esperando confirmación de la sesión."),
	).toBeVisible();
	expect(screen.queryByText("Recibido por la sesión")).toBeNull();
});

it("closes the open mobile controls with Escape or native Back before leaving the session", async () => {
	const { client, controls } = fixture();
	render(<OrchestrationPanel mobile client={client} controls={controls} />);
	await openSession();
	const draft = screen.getByLabelText("Continuar esta sesión");
	await userEvent.type(draft, "Conservar borrador");
	const details = screen.getByRole("button", { name: /Detalles y actividad/ });
	await userEvent.click(details);
	await userEvent.keyboard("{Escape}");
	expect(details).toHaveAttribute("aria-expanded", "false");
	expect(details).toHaveFocus();
	await userEvent.click(details);
	const delivery = screen.getByRole("button", { name: /Entrega del mensaje:/ });
	await userEvent.click(delivery);
	expect(details).toHaveAttribute("aria-expanded", "false");
	const back = new Event("gentledot-back", { cancelable: true });
	fireEvent(window, back);
	expect(back.defaultPrevented).toBe(true);
	expect(delivery).toHaveAttribute("aria-expanded", "false");
	expect(delivery).toHaveFocus();
	expect(draft).toHaveValue("Conservar borrador");
	fireEvent(window, new Event("gentledot-back", { cancelable: true }));
	expect(screen.getByRole("button", { name: "Proyecto · Trabajando" })).toBeVisible();
	await openSession();
	expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("Conservar borrador");
	expect(controls.act).not.toHaveBeenCalled();
});

it("returns to collapsed mobile controls after hiding the session and marks stale activity honestly", async () => {
	const { client, controls } = fixture();
	const view = render(<OrchestrationPanel mobile client={client} controls={controls} />);
	await openSession();
	await userEvent.click(screen.getByRole("button", { name: /Detalles y actividad/ }));
	view.rerender(<OrchestrationPanel mobile active={false} client={client} controls={controls} />);
	view.rerender(
		<OrchestrationPanel mobile client={client} controls={{ ...controls, error: "Sin conexión" }} />,
	);
	const details = screen.getByRole("button", { name: /Detalles y actividad/ });
	expect(details).toHaveAttribute("aria-expanded", "false");
	expect(details).toHaveAccessibleDescription("Sin actualizar");
	expect(screen.getByRole("button", { name: "Enviar instrucción" })).toBeDisabled();
});

it("retains the expanded control shelf and original delivery select on desktop", async () => {
	const { client, controls } = fixture();
	render(<OrchestrationPanel client={client} controls={controls} />);
	await openSession();
	expect(screen.queryByRole("button", { name: /Detalles y actividad/ })).toBeNull();
	expect(screen.getByRole("button", { name: /Ver información de la sesión/ })).toBeVisible();
	expect(screen.getByRole("region", { name: "Plan de trabajo" })).toBeVisible();
	expect(screen.getByRole("combobox", { name: "Entrega del mensaje" })).toBeVisible();
});
