import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPermissionCard } from "../src/components/AgentPermissionCard.tsx";
import type { AgentApproval } from "../src/orchestration.ts";

afterEach(() => vi.useRealTimers());

const base: AgentApproval = {
	id: "question-exact",
	paneId: "pane",
	sessionId: "session",
	title: "Elegir una ruta",
	message: "Detalle íntegro de la solicitud.",
	action: "question",
	createdAt: new Date().toISOString(),
	expiresAt: new Date(Date.now() + 60_000).toISOString(),
	answerable: true,
};
function setup(approval: AgentApproval) {
	const act = vi.fn(async () => true);
	const view = render(
		<AgentPermissionCard
			approval={approval}
			controls={{ act, busy: false, refresh: vi.fn() }}
			disabled={false}
		/>,
	);
	return { act, view };
}
const answer = { action: "answer", paneId: "pane", sessionId: "session", requestId: "question-exact" };
function submitQuestion() {
	const form = screen.getByRole("button", { name: "Enviar respuesta" }).closest("form");
	if (!form) throw new Error("Missing question form");
	fireEvent.submit(form);
}

describe("human agent questions", () => {
	it("retains multi-select choices when adding custom text in either order", async () => {
		const { act } = setup({ ...base, kind: "questionnaire", questions: [{
			id: "scope", question: "Alcance", multiSelect: true, options: [{ label: "Servidor" }, { label: "Interfaz" }],
		}] });
		await userEvent.click(screen.getByRole("checkbox", { name: "Servidor" }));
		await userEvent.click(screen.getByRole("checkbox", { name: "Otra respuesta" }));
		await userEvent.type(screen.getByRole("textbox", { name: "Tu respuesta" }), "Y documentación");
		await userEvent.click(screen.getByRole("checkbox", { name: "Interfaz" }));
		expect(screen.getByRole("checkbox", { name: "Servidor" })).toBeChecked();
		expect(screen.getByRole("checkbox", { name: "Otra respuesta" })).toBeChecked();
		await userEvent.click(screen.getByRole("button", { name: "Enviar respuesta" }));
		expect(act).toHaveBeenCalledExactlyOnceWith({ ...answer, answers: [{ questionId: "scope", optionIndices: [0, 1], text: "Y documentación" }] });
	});
	it.each(["", "  editado\n$literal  "])(
		"edits the original multiline document literally (%j)",
		async (text) => {
			const { act } = setup({ ...base, kind: "editor", message: "  primera\nsegunda  " });
			const editor = screen.getByRole("textbox", { name: "Tu respuesta" });
			expect(editor).toHaveValue("  primera\nsegunda  ");
			expect(act).not.toHaveBeenCalled();
			fireEvent.change(editor, { target: { value: text } });
			await userEvent.click(screen.getByRole("button", { name: "Enviar respuesta" }));
			expect(act).toHaveBeenCalledExactlyOnceWith({ ...answer, text });
		},
	);
	it("allows an explicitly empty standard input, matching the native answer contract", async () => {
		const { act } = setup({ ...base, kind: "input" });
		await userEvent.click(screen.getByRole("button", { name: "Enviar respuesta" }));
		expect(act).toHaveBeenCalledExactlyOnceWith({ ...answer, text: "" });
	});
	it("identifies arbitrary terminal UI as unsupported without dispatching generic acceptance", () => {
		const { act } = setup({ ...base, kind: "custom" });
		expect(screen.getByText(/Interfaz de terminal no compatible/)).toBeVisible();
		expect(screen.getByText(/terminal original.*Detener/)).toBeVisible();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(act).not.toHaveBeenCalled();
	});
	it("keeps the original unavailable request visible with an explicit refresh action", async () => {
		const { act } = setup({ ...base, kind: "custom", answerable: false, unavailableReason: "terminal_only" });
		expect(screen.getByText(base.message)).toBeVisible();
		expect(screen.getByRole("button", { name: "Actualizar solicitud" })).toBeEnabled();
		expect(screen.queryByRole("button", { name: "Permitir" })).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Actualizar solicitud" }));
		expect(act).not.toHaveBeenCalled();
	});
	it.each(["input", "editor"] as const)(
		"does not dispatch %s responses when unavailable, expired, busy or disabled",
		(kind) => {
			const { act, view } = setup({ ...base, kind, answerable: false });
			submitQuestion();
			fireEvent.click(screen.getByRole("button", { name: "Cancelar pregunta" }));
			expect(act).not.toHaveBeenCalled();
			view.rerender(
				<AgentPermissionCard
					approval={{ ...base, kind, expiresAt: "2000-01-01T00:00:00Z" }}
					controls={{ act, busy: false, refresh: vi.fn() }}
					disabled={false}
				/>,
			);
			submitQuestion();
			expect(act).not.toHaveBeenCalled();
			for (const state of [
				{ busy: true, disabled: false },
				{ busy: false, disabled: true },
			]) {
				view.rerender(
					<AgentPermissionCard
						approval={{ ...base, kind }}
						controls={{ act, busy: state.busy, refresh: vi.fn() }}
						disabled={state.disabled}
					/>,
				);
				submitQuestion();
				fireEvent.click(screen.getByRole("button", { name: "Cancelar pregunta" }));
				expect(act).not.toHaveBeenCalled();
			}
		},
	);
	it("submits a single choice in one tap using its exact id, never its label", async () => {
		const { act } = setup({
			...base,
			kind: "select",
			options: [
				{ id: "exact-alpha", label: "Sí, continúa" },
				{ id: "exact-beta", label: "Revisar primero" },
			],
		});
		expect(screen.queryByRole("button", { name: "Permiso nocturno" })).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("radio", { name: "Sí, continúa" }));
		expect(act).toHaveBeenCalledExactlyOnceWith({ ...answer, optionId: "exact-alpha" });
	});
	it("preserves entered text and locks a confirmed answer until refreshed", async () => {
		const { act } = setup({ ...base, kind: "input", placeholder: "Ruta completa" });
		const input = screen.getByRole("textbox", { name: "Tu respuesta" });
		fireEvent.change(input, { target: { value: " /work/proyecto con espacios\nsegunda línea " } });
		expect(act).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Enviar respuesta" }));
		expect(act).toHaveBeenCalledWith({ ...answer, text: " /work/proyecto con espacios\nsegunda línea " });
		await userEvent.click(screen.getByRole("button", { name: "Cancelar pregunta" }));
		expect(act).toHaveBeenCalledOnce();
		expect(screen.getByText("Respuesta enviada")).toBeVisible();
	});
	it("shows complete questionnaire choices and submits exact indices or explicit free text", async () => {
		const { act } = setup({
			...base,
			kind: "questionnaire",
			questions: [
				{
					id: "scope",
					question: "¿Qué revisar?",
					multiSelect: true,
					options: [
						{ label: "Servidor", description: "Comprobar rutas", preview: "GET /status\nPOST /jobs" },
						{ label: "Interfaz" },
					],
				},
				{
					id: "next",
					question: "¿Qué sigue?",
					multiSelect: false,
					options: [{ label: "Preparar PR" }, { label: "Descansar" }],
				},
			],
		});
		const first = screen.getByRole("group", { name: "¿Qué revisar?" });
		expect(within(first).getByText("GET /status POST /jobs")).toBeVisible();
		await userEvent.click(within(first).getByRole("checkbox", { name: /Servidor/ }));
		await userEvent.click(within(first).getByRole("checkbox", { name: "Interfaz" }));
		expect(screen.queryByRole("group", { name: "¿Qué sigue?" })).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Siguiente" }));
		expect(screen.getByText("2 de 2")).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "Atrás" }));
		expect(screen.getByRole("checkbox", { name: /Servidor/ })).toBeChecked();
		expect(screen.getByRole("checkbox", { name: "Interfaz" })).toBeChecked();
		await userEvent.click(screen.getByRole("button", { name: "Siguiente" }));
		const second = screen.getByRole("group", { name: "¿Qué sigue?" });
		await userEvent.click(within(second).getByRole("radio", { name: "Otra respuesta" }));
		await userEvent.type(
			within(second).getByRole("textbox", { name: "Tu respuesta" }),
			"Explícame los cambios",
		);
		expect(act).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Enviar respuesta" }));
		expect(act).toHaveBeenCalledExactlyOnceWith({
			...answer,
			answers: [
				{ questionId: "scope", optionIndices: [0, 1] },
				{ questionId: "next", text: "Explícame los cambios" },
			],
		});
	});
	it.each([true, false, undefined])(
		"keeps confirmation specific regardless of legacy grant eligibility (%s)",
		async (policyEligible) => {
			const { act } = setup({
				...base,
				kind: "confirm",
				...(policyEligible === undefined ? {} : { policyEligible }),
			});
			expect(screen.getByRole("button", { name: "Permitir" })).toBeEnabled();
			expect(screen.queryByRole("button", { name: "Permiso nocturno" })).not.toBeInTheDocument();
			expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
			expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
			expect(act).not.toHaveBeenCalled();
			await userEvent.click(screen.getByRole("button", { name: "Permitir" }));
			expect(act).toHaveBeenCalledExactlyOnceWith({ ...answer, approved: true });
		},
	);
	it("keeps old connection questions local and explains that reconnecting cannot answer the current request", () => {
		setup({
			...base,
			kind: "select",
			answerable: false,
			unavailableReason: "legacy_connection",
			options: [{ id: "yes", label: "Continuar" }],
		});
		expect(screen.getByText(/Conexión anterior:/)).toBeVisible();
		expect(screen.getByRole("radio", { name: "Continuar" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Enviar respuesta" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Cancelar pregunta" })).toBeDisabled();
	});
});

it.each(["input", "editor"] as const)(
	"sends %s cancellation explicitly without treating it as approval",
	async (kind) => {
		const { act: respond } = setup({ ...base, kind });
		await userEvent.click(screen.getByRole("button", { name: "Cancelar pregunta" }));
		expect(respond).toHaveBeenCalledExactlyOnceWith({ ...answer, cancelled: true });
	},
);

it("supports native Pi questions without a deadline and does not infer a default choice", async () => {
	const { act: respond } = setup({
		...base,
		expiresAt: "",
		kind: "questionnaire",
		questions: [
			{
				id: "q",
				question: "¿Publicar los cambios revisados?",
				multiSelect: false,
				options: [{ label: "Publicar" }, { label: "Revisar" }],
			},
		],
	});
	expect(screen.getByText("Pendiente de tu respuesta")).toBeVisible();
	expect(screen.queryByText(/Invalid Date|venció/)).not.toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Enviar respuesta" })).toBeDisabled();
	await userEvent.click(screen.getByRole("radio", { name: "Publicar" }));
	expect(respond).not.toHaveBeenCalled();
	await userEvent.click(screen.getByRole("button", { name: "Enviar respuesta" }));
	expect(respond).toHaveBeenCalledExactlyOnceWith({
		...answer,
		answers: [{ questionId: "q", optionIndices: [0] }],
	});
});

it("disables expired requests at their deadline without needing another snapshot", async () => {
	vi.useFakeTimers();
	const { act: respond } = setup({ ...base, expiresAt: new Date(Date.now() + 1000).toISOString() });
	expect(screen.getByRole("button", { name: "Permitir" })).toBeEnabled();
	await act(() => vi.advanceTimersByTimeAsync(1001));
	expect(screen.getByRole("button", { name: "Permitir" })).toBeDisabled();
	expect(screen.getByText("Esta solicitud venció")).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Permitir" }));
	expect(respond).not.toHaveBeenCalled();
});

it("blocks duplicate responses while sending and after acknowledgement", async () => {
	let finish!: (accepted: boolean) => void;
	const respond = vi.fn(
		() =>
			new Promise<boolean>((resolve) => {
				finish = resolve;
			}),
	);
	render(
		<AgentPermissionCard
			approval={base}
			controls={{ act: respond, busy: false, refresh: vi.fn() }}
			disabled={false}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Permitir" }));
	fireEvent.click(screen.getByRole("button", { name: "Rechazar" }));
	expect(respond).toHaveBeenCalledOnce();
	expect(screen.getByText("Enviando respuesta…")).toBeVisible();
	await act(async () => finish(true));
	expect(screen.getByText("Respuesta enviada")).toBeVisible();
	expect(screen.getByRole("button", { name: "Rechazar" })).toBeDisabled();
});

it('passes the exact reviewed approval to clients that require a local guard', async () => {
 const act = vi.fn(async () => true); const approval = { ...base, kind: 'confirm' as const, message: 'Contenido exacto' };
 render(<AgentPermissionCard approval={approval} controls={{act,busy:false,refresh:vi.fn(),requiresReviewedApproval:true}} disabled={false}/>);
 await userEvent.click(screen.getByRole('button', {name:'Permitir'}));
 expect(act).toHaveBeenCalledExactlyOnceWith({...answer,approved:true,reviewedApproval:approval});
});

it('explains that older hosts cannot bind the reviewed content atomically', () => {
 const act=vi.fn(async()=>true);const controls={act,busy:false,refresh:vi.fn(),requiresReviewedApproval:true};
 const view=render(<AgentPermissionCard approval={{...base,kind:'confirm'}} controls={controls} disabled={false}/>);
 expect(screen.getByText(/contrato anterior/)).toBeVisible();
 view.rerender(<AgentPermissionCard approval={{...base,kind:'confirm',questionRevision:'a'.repeat(64)}} controls={controls} disabled={false}/>);
 expect(screen.queryByText(/contrato anterior/)).toBeNull();
});
