import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OrchestrationPanel } from "../src/components/OrchestrationPanel.tsx";
import { SessionContext, SessionDetails, SessionMenu } from "../src/components/SessionDetails.tsx";
import type { AgentConversation, AgentSession, OrchestrationClient } from "../src/orchestration.ts";
import type { OrchestrationControls } from "../src/useOrchestration.ts";

const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeAll(() => {
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
const session: AgentSession = {
	paneId: "p1",
	sessionId: "s1",
	terminalId: "t1",
	workspaceId: "w1",
	label: "Revisión",
	state: "idle",
	connected: true,
	managed: true,
	provider: "herdr",
	cwd: "/work/project",
	capabilities: { inspect: true, prompt: true, abort: true, approvals: true, close: true, duplicate: true },
};
const conversation: AgentConversation = {
	sessionId: "s1",
	status: "idle",
	messages: [],
	question: null,
	metadata: {
		version: 1,
		model: { id: "gpt", name: "Modelo de prueba", provider: "Proveedor" },
		profile: { name: "Trabajo", source: "repo" },
		thinkingLevel: "high",
		context: { tokens: 12_000, contextWindow: 200_000, percent: 6 },
		tools: { active: ["bash", "read", "mcp_test"], available: 9 },
		skills: [{ name: "Testing", description: "Pruebas del proyecto" }],
		mcp: [
			{ name: "Solo configuración", status: "configured", tools: 0 },
			{ name: "Servidor disponible", status: "available", tools: 1 },
		],
	},
};
function controls(): OrchestrationControls {
	return {
		snapshot: { available: true, sessions: [session], policies: [], approvals: [], events: [] },
		busy: false,
		refresh: vi.fn(async () => {}),
		act: vi.fn(async () => true),
	};
}
async function openMenu() {
	await userEvent.click(screen.getByLabelText("Detalles de la sesión"));
}

describe("session information", () => {
	it("keeps technical information collapsed until requested", async () => {
		render(<SessionDetails session={session} conversation={conversation} stale={false} close={() => {}} />);
		const summary = screen.getByText("Detalles técnicos", { selector: "summary" });
		expect(summary.closest("details")).not.toHaveAttribute("open");
		expect(screen.getByRole("progressbar")).not.toBeVisible();
		await userEvent.click(summary);
		expect(screen.getByRole("progressbar")).toBeVisible();
	});
	it("offers recent folders and close directly from a session row", async () => {
		const control = controls();
		control.snapshot!.providers = [{ id: "herdr", available: true, canCreate: true }];
		const client: OrchestrationClient = { snapshot: vi.fn(), act: vi.fn(), inspect: vi.fn() };
		render(<OrchestrationPanel controls={control} client={client} />);
		await userEvent.click(screen.getByRole("button", { name: "Nueva sesión" }));
		await userEvent.click(screen.getByRole("button", { name: "/work/project" }));
		expect(screen.getByLabelText("Carpeta del proyecto en tu equipo")).toHaveValue("/work/project");
		await openMenu();
		await userEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
		expect(screen.getByRole("dialog", { name: /Cerrar/ })).toBeVisible();
		expect(control.act).not.toHaveBeenCalled();
	});
	it("opens model, reasoning, profile and MCP directly from the compact context strip", async () => {
		const control = controls();
		const client: OrchestrationClient = {
			snapshot: vi.fn(),
			act: vi.fn(),
			inspect: vi.fn(async () => conversation),
		};
		render(<OrchestrationPanel controls={control} client={client} />);
		await userEvent.click(screen.getByRole("button", { name: "Revisión · Disponible" }));
		const trigger = await screen.findByRole("button", {
			name: "Ver información de la sesión: Modelo de prueba, razonamiento Alto, 6% de contexto usado",
		});
		expect(trigger).toHaveTextContent("Modelo de pruebaAlto6%");
		await userEvent.type(screen.getByLabelText("Continuar esta sesión"), "Mi borrador");
		await userEvent.click(trigger);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("Modelo principal")).toBeVisible();
		expect(within(dialog).getByText("Trabajo")).toBeVisible();
		await userEvent.click(within(dialog).getByText("Detalles técnicos"));
		await userEvent.click(within(dialog).getByText("Conexiones MCP"));
		expect(within(dialog).getByText("Servidor disponible")).toBeVisible();
		fireEvent(window, new Event("gentledot-back", { cancelable: true }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		await waitFor(() => expect(trigger).toHaveFocus());
		expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("Mi borrador");
		expect(client.inspect).toHaveBeenCalledOnce();
		expect(control.act).not.toHaveBeenCalled();
	});

	it("keeps absent context unknown, identifies historical metadata and closes details when inactive", async () => {
		const view = render(
			<SessionContext
				session={session}
				conversation={{
					...conversation,
					metadata: { version: 1, source: "history", model: conversation.metadata?.model },
				}}
				active
				stale={false}
			/>,
		);
		const trigger = screen.getByRole("button", {
			name: /Modelo de prueba, Contexto sin lectura, última lectura/,
		});
		expect(trigger).toHaveTextContent("Contexto —");
		expect(trigger).not.toHaveTextContent("0%");
		await userEvent.click(trigger);
		expect(screen.getByText(/Última configuración registrada/)).toBeVisible();
		expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
		view.rerender(<SessionContext session={session} active={false} stale={false} />);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("labels only the explicitly selected session profile as active", () => {
		render(
			<SessionDetails
				session={session}
				conversation={{
					...conversation,
					metadata: { version: 1, profile: { name: "Revisor", source: "session" } },
				}}
				stale={false}
				close={() => {}}
			/>,
		);
		expect(screen.getByText("Perfil activo")).toBeVisible();
		expect(screen.getByText("Revisor")).toBeVisible();
	});
	it("shows measured context and configured profile without presenting configured MCP as connected", async () => {
		render(<SessionDetails session={session} conversation={conversation} stale={false} close={() => {}} />);
		expect(screen.getByRole("dialog", { name: "Información de la sesión" })).toBeVisible();
		expect(screen.getByText("Modelo de prueba")).toBeVisible();
		expect(screen.getByText("Perfil configurado")).toBeVisible();
		expect(screen.queryByText(/Perfil activo/)).not.toBeInTheDocument();
		await userEvent.click(screen.getByText("Detalles técnicos"));
		expect(screen.getByRole("progressbar", { name: "Contexto utilizado" })).toHaveAttribute("value", "6");
		await userEvent.click(screen.getByText("Conexiones MCP"));
		expect(screen.getByText("Configurado · 0 herramientas")).toBeVisible();
		expect(screen.getByText("Disponible · 1 herramienta")).toBeVisible();
		expect(screen.queryByText(/Conectado/)).not.toBeInTheDocument();
		await userEvent.click(screen.getByText(/^Herramientas/, { selector: "summary" }));
		expect(screen.getByText("3 habilitadas de 9 disponibles.")).toBeVisible();
	});
	it("preserves unknown context rather than reporting zero and rejects metadata from another session", () => {
		const view = render(
			<SessionDetails
				session={session}
				conversation={{
					...conversation,
					metadata: { version: 1, context: { tokens: null, contextWindow: 200_000, percent: null } },
				}}
				stale
				close={() => {}}
			/>,
		);
		fireEvent.click(screen.getByText("Detalles técnicos"));
		expect(screen.getByText("Sin lectura")).toBeVisible();
		expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
		expect(screen.getByText(/últimos datos recibidos/i)).toBeVisible();
		view.rerender(
			<SessionDetails
				session={session}
				conversation={{ ...conversation, sessionId: "other" }}
				stale={false}
				close={() => {}}
			/>,
		);
		expect(screen.queryByText("Modelo de prueba")).not.toBeInTheDocument();
		expect(screen.getByText(/no comparte información de modelo/)).toBeVisible();
	});
	it("offers reload only after a managed session returns a legacy inspection", () => {
		const legacy: AgentConversation = { sessionId: "s1", status: "idle", messages: [], question: null };
		const view = render(
			<SessionDetails session={session} conversation={legacy} stale={false} close={() => {}} />,
		);
		expect(screen.getByText(/Cuando termine, escribe \/reload/)).toBeVisible();
		expect(screen.queryByText("Perfil configurado")).not.toBeInTheDocument();
		view.rerender(
			<SessionDetails
				session={{ ...session, managed: false }}
				conversation={legacy}
				stale={false}
				close={() => {}}
			/>,
		);
		expect(screen.queryByText(/\/reload/)).not.toBeInTheDocument();
		expect(screen.getByText(/no comparte información de modelo/)).toBeVisible();
	});

	it("closes using Android Back and Escape without modifying a session", () => {
		const close = vi.fn();
		render(<SessionDetails session={session} stale={false} close={close} />);
		const back = new Event("gentledot-back", { cancelable: true });
		fireEvent(window, back);
		expect(back.defaultPrevented).toBe(true);
		expect(close).toHaveBeenCalledTimes(1);
		fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
		expect(close).toHaveBeenCalledTimes(2);
	});
});

describe("session menu actions", () => {
	it("requires explicit close confirmation and sends the exact identity only once while pending", async () => {
		const control = controls();
		let resolve: (value: boolean) => void = () => {};
		vi.mocked(control.act).mockImplementation(
			() =>
				new Promise<boolean>((done) => {
					resolve = done;
				}),
		);
		const closed = vi.fn();
		render(<SessionMenu session={session} controls={control} connected active onClosed={closed} />);
		await openMenu();
		await userEvent.click(screen.getByRole("button", { name: /^Cerrar sesión$/ }));
		expect(control.act).not.toHaveBeenCalled();
		const confirm = screen.getByRole("button", { name: "Sí, cerrar sesión" });
		fireEvent.click(confirm);
		fireEvent.click(confirm);
		expect(control.act).toHaveBeenCalledExactlyOnceWith({ action: "close", paneId: "p1", sessionId: "s1" });
		expect(screen.getByRole("button", { name: "Confirmando…" })).toBeDisabled();
		expect(closed).not.toHaveBeenCalled();
		await act(async () => resolve(true));
		expect(closed).toHaveBeenCalledTimes(1);
	});
	it("cancels without acting, confirms duplication separately, and does not carry permissions", async () => {
		const control = controls();
		render(<SessionMenu session={session} controls={control} connected active onClosed={() => {}} />);
		await openMenu();
		await userEvent.click(screen.getByRole("button", { name: "Duplicar sesión" }));
		expect(screen.getByText(/autorizaciones.*no se copiarán/)).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "Volver" }));
		expect(control.act).not.toHaveBeenCalled();
		await openMenu();
		await userEvent.click(screen.getByRole("button", { name: "Duplicar sesión" }));
		await userEvent.click(screen.getByRole("button", { name: "Crear copia" }));
		expect(control.act).toHaveBeenCalledExactlyOnceWith({
			action: "duplicate",
			paneId: "p1",
			sessionId: "s1",
		});
		expect(await screen.findByText(/Copia creada/)).toBeVisible();
	});
	it("hides unsupported controls and disables duplication during work", async () => {
		const control = controls();
		const view = render(
			<SessionMenu
				session={{ ...session, capabilities: { inspect: true, prompt: true, abort: true, approvals: true } }}
				controls={control}
				connected
				active
				onClosed={() => {}}
			/>,
		);
		await openMenu();
		expect(screen.queryByRole("button", { name: "Duplicar sesión" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Cerrar sesión" })).not.toBeInTheDocument();
		view.rerender(
			<SessionMenu
				session={{ ...session, state: "working" }}
				controls={control}
				connected
				active
				onClosed={() => {}}
			/>,
		);
		expect(screen.getByRole("button", { name: "Duplicar sesión" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Detener tarea" })).toBeEnabled();
		expect(control.act).not.toHaveBeenCalled();
	});
	it("does not reuse a confirmation after the authenticated action handler changes", async () => {
		const control = controls();
		const view = render(
			<SessionMenu session={session} controls={control} connected active onClosed={() => {}} />,
		);
		await openMenu();
		await userEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
		const replacement = controls();
		view.rerender(
			<SessionMenu session={session} controls={replacement} connected active onClosed={() => {}} />,
		);
		expect(screen.getByRole("button", { name: "Sí, cerrar sesión" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Sí, cerrar sesión" }));
		expect(control.act).not.toHaveBeenCalled();
		expect(replacement.act).not.toHaveBeenCalled();
	});
	it("retains a failed action for review without claiming that the session closed", async () => {
		const control = controls();
		vi.mocked(control.act).mockResolvedValue(false);
		const closed = vi.fn();
		render(<SessionMenu session={session} controls={control} connected active onClosed={closed} />);
		await openMenu();
		await userEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
		await userEvent.click(screen.getByRole("button", { name: "Sí, cerrar sesión" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/No se pudo confirmar/);
		expect(closed).not.toHaveBeenCalled();
	});
	it("Android Back closes the menu or details before leaving the conversation and preserves its draft", async () => {
		const control = controls();
		const client: OrchestrationClient = {
			snapshot: vi.fn(),
			act: vi.fn(),
			inspect: vi.fn(async () => conversation),
		};
		render(<OrchestrationPanel controls={control} client={client} />);
		await userEvent.click(screen.getByRole("button", { name: "Revisión · Disponible" }));
		await waitFor(() => expect(client.inspect).toHaveBeenCalledTimes(1));
		await userEvent.type(screen.getByLabelText("Continuar esta sesión"), "Borrador de esta sesión");
		await openMenu();
		fireEvent(window, new Event("gentledot-back", { cancelable: true }));
		expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("Borrador de esta sesión");
		expect(screen.getByLabelText("Detalles de la sesión").closest("details")).not.toHaveAttribute("open");
		await openMenu();
		await userEvent.click(screen.getByRole("button", { name: "Información de la sesión" }));
		expect(within(screen.getByRole("dialog")).getByText("Modelo de prueba")).toBeVisible();
		fireEvent(window, new Event("gentledot-back", { cancelable: true }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("Borrador de esta sesión");
		expect(control.act).not.toHaveBeenCalled();
	});
});
