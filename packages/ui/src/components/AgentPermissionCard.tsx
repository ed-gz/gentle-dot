import { useEffect, useId, useRef, useState } from "react";
import type { AgentAnswer, AgentApproval, AgentQuestion } from "../orchestration.ts";
import type { OrchestrationControls } from "../useOrchestration.ts";
import "../agent-permissions.css";
import { requestExpired, useRequestExpiry } from "../useRequestExpiry.ts";

export function AgentPermissionCard({
	approval,
	controls,
	disabled,
	label,
}: {
	approval: AgentApproval;
	controls: OrchestrationControls;
	disabled: boolean;
	label?: string;
}) {
	const expired = useRequestExpiry(approval.expiresAt, true);
	const kind = approval.kind ?? "confirm";
	const supported = ["confirm", "select", "input", "editor", "questionnaire"].includes(kind);
	const key = JSON.stringify([
		approval.paneId,
		approval.sessionId,
		approval.id,
		approval.title,
		approval.message,
		approval.kind,
		approval.options,
		approval.questions,
		approval.questionRevision,
		needsExplicitSubmission(approval),
	]);
	const current = useRef({ key, action: controls.act });
	current.current = { key, action: controls.act };
	const sending = useRef(false);
	const [pending, setPending] = useState(false);
	const [answered, setAnswered] = useState<string>();
	const [error, setError] = useState<{ key: string; message: string }>();
	const locked =
		disabled || controls.busy || pending || answered === key || !approval.answerable || expired || !supported;
	const answer = async (value: AgentAnswer) => {
		if (locked || sending.current || requestExpired(approval.expiresAt, true)) return false;
		sending.current = true;
		setPending(true);
		setError(undefined);
		const action = controls.act;
		try {
			const accepted = await action({
				action: "answer",
				paneId: approval.paneId,
				sessionId: approval.sessionId,
				requestId: approval.id,
				...(controls.requiresReviewedApproval ? { reviewedApproval: approval } : {}),
				...value,
			});
			if (current.current.key === key && current.current.action === action) {
				if (accepted) setAnswered(key);
				else setError({ key, message: "No se pudo confirmar tu respuesta. Actualiza la solicitud antes de reintentar." });
			}
			return accepted;
		} catch (problem) {
			if (current.current.key === key && current.current.action === action)
				setError({
					key,
					message: problem instanceof Error ? problem.message : "No se pudo confirmar tu respuesta. Actualiza el estado antes de volver a intentar.",
				});
			return false;
		} finally {
			sending.current = false;
			setPending(false);
		}
	};
	return (
		<article className="card agent-approval">
			<p className="eyebrow">{label || "Permiso del agente"}</p>
			<h4>{approval.title}</h4>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: The complete approval preview must be scrollable with a keyboard. */}
			<section className="agent-permission-detail" tabIndex={0} aria-label="Detalle de la solicitud">
				<pre>{approval.message}</pre>
			</section>
			{controls.requiresReviewedApproval && !approval.questionRevision ? <p className="muted">La laptop usa un contrato anterior y no puede verificar el contenido al momento de responder.</p> : null}
			<p className="muted" role="status">
				{answered === key
					? "Respuesta enviada"
					: pending
						? "Enviando respuesta…"
						: expired
							? "Esta solicitud venció"
							: approval.expiresAt
								? `Vence ${formatDate(approval.expiresAt)}`
								: "Pendiente de tu respuesta"}
			</p>
			{error?.key === key ? (
				<p className="orchestration-error" role="alert">
					{controls.error || error.message}
				</p>
			) : null}
			{!approval.answerable ? (
				<div role="status">
				<p className="orchestration-error">
					{approval.unavailableReason === "legacy_connection"
						? "Conexión anterior: esta pregunta requiere actualizar la conexión cuando la sesión quede libre. Responde la solicitud actual en el equipo."
						: "Responde esta solicitud en la terminal original. Esta sesión no admite permisos remotos."}
				</p>
				<button type="button" disabled={disabled || controls.busy} onClick={() => void controls.refresh()}>
					Actualizar solicitud
				</button>
				</div>
			) : null}
			{kind === "confirm" ? (
				<div className="agent-actions">
					<button
						type="button"
						className="primary"
						disabled={locked}
						onClick={() => void answer({ approved: true })}
					>
						Permitir
					</button>
					<button type="button" disabled={locked} onClick={() => void answer({ approved: false })}>
						Rechazar
					</button>
				</div>
			) : supported ? (
				<QuestionForm key={key} approval={approval} locked={locked} answer={answer} />
			) : (
				<p className="muted">
					Interfaz de terminal no compatible con respuestas remotas. Responde o cancela en la terminal
					original; si necesitas interrumpir el trabajo, usa Detener en la sesión. No se enviará ninguna
					aceptación automática.
				</p>
			)}
		</article>
	);
}

function formatDate(value: string): string {
	return new Date(value).toLocaleString("es-MX", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** Conservative UX brake, not an authorization decision. Older adapters embed effects in labels. */
function needsExplicitSubmission(approval: AgentApproval): boolean {
	const permission = Reflect.get(approval, "workflowPermission");
	return approval.requiresConfirmation === true || "consentBinding" in approval ||
		permission?.category === "native-review-consent" ||
		/(?:review|rdd)[-_ ]consent/i.test(approval.action) ||
		approval.message.includes("gentle-ai.review-integration.consent/") ||
		Boolean(approval.options?.some(option => option.description || option.effect || option.consequence ||
			/(?:effect|consequence|efecto|consecuencia)\s*:/i.test(option.label)));
}

function QuestionForm({
	approval,
	locked,
	answer,
}: {
	approval: AgentApproval;
	locked: boolean;
	answer: (value: AgentAnswer) => Promise<boolean>;
}) {
	const [optionId, setOptionId] = useState<string>();
	const explicitSubmission = needsExplicitSubmission(approval);
	const [step, setStep] = useState(0);
	const form = useRef<HTMLFormElement>(null);
	const previousStep = useRef(step);
	useEffect(() => {
		if (previousStep.current !== step) form.current?.querySelector<HTMLElement>("fieldset")?.focus();
		previousStep.current = step;
	}, [step]);
	const [text, setText] = useState(approval.kind === "editor" ? approval.message : "");
	const [responses, setResponses] = useState<
		Record<string, { indices: number[]; custom: boolean; text: string }>
	>({});
	const id = useId();
	const questions = approval.questions ?? [];
	const currentQuestion = questions[step];
	const response = currentQuestion ? responses[currentQuestion.id] : undefined;
	const stepValid = Boolean(response && (response.custom ? response.text.trim() : response.indices.length));
	const more = approval.kind === "questionnaire" && step < questions.length - 1;
	const valid =
		approval.kind === "select"
			? approval.options?.some((option) => option.id === optionId)
			: approval.kind === "input" || approval.kind === "editor"
				? true
				: questions.length > 0 &&
					questions.every((question) => {
						const response = responses[question.id];
						return (
							response && (response.custom ? response.text.trim().length > 0 : response.indices.length > 0)
						);
					});
	return (
		<form
			ref={form}
			className="agent-permission-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (locked) return;
				if (more) { if (stepValid) setStep(step + 1); return; }
				if (!valid) return;
				if (approval.kind === "select" && optionId !== undefined) void answer({ optionId });
				else if (approval.kind === "input" || approval.kind === "editor") void answer({ text });
				else if (approval.kind === "questionnaire")
					void answer({
						answers: questions.map((question) => {
							const response = responses[question.id];
							return response?.custom
								? { questionId: question.id, text: response.text, ...(question.multiSelect ? { optionIndices: response.indices } : {}) }
								: { questionId: question.id, optionIndices: response?.indices ?? [] };
						}),
					});
			}}
		>
			{approval.kind === "select" ? (
				<fieldset disabled={locked}>
					<legend>Elige una opción</legend>
					{approval.options?.map((option) => (
						<label key={option.id} className="agent-permission-option">
							<input
								type="radio"
								name={`${id}-option`}
								value={option.id}
								checked={optionId === option.id}
								onChange={() => {
									setOptionId(option.id);
									if (!locked && !explicitSubmission) void answer({ optionId: option.id });
								}}
							/>
							<span>{option.label}
								{option.description ? <small>{option.description}</small> : null}
								{option.effect ? <small>{option.effect}</small> : null}
								{option.consequence ? <small>{option.consequence}</small> : null}
							</span>
						</label>
					))}
				</fieldset>
			) : null}
			{approval.kind === "input" || approval.kind === "editor" ? (
				<label htmlFor={`${id}-text`}>
					Tu respuesta
					<textarea
						id={`${id}-text`}
						value={text}
						onChange={(event) => setText(event.target.value)}
						placeholder={approval.placeholder}
						maxLength={approval.kind === "editor" ? 65_536 : 8192}
						disabled={locked}
					/>
				</label>
			) : null}
			{approval.kind === "questionnaire"
				? questions.slice(step, step + 1).map((question) => (
						<QuestionChoices
							key={question.id}
							question={question}
							locked={locked}
							value={responses[question.id] ?? { indices: [], custom: false, text: "" }}
							onChange={(value) => setResponses((previous) => ({ ...previous, [question.id]: value }))}
						/>
					))
				: null}
			{approval.kind === "questionnaire" ? <p className="question-progress" role="status">{step + 1} de {questions.length}</p> : null}
			<div className="agent-actions">
				{step > 0 ? <button type="button" disabled={locked} onClick={() => setStep(step - 1)}>Atrás</button> : null}
				<button type="submit" className="primary" aria-label={more ? "Siguiente" : "Enviar respuesta"} disabled={locked || (more ? !stepValid : !valid)}>
					{more ? "Siguiente" : "Enviar"}
				</button>
				<button
					type="button"
					aria-label="Cancelar pregunta"
					disabled={locked}
					onClick={() => void answer({ cancelled: true })}
				>
					Cancelar
				</button>
			</div>
		</form>
	);
}

function QuestionChoices({
	question,
	locked,
	value,
	onChange,
}: {
	question: AgentQuestion;
	locked: boolean;
	value: { indices: number[]; custom: boolean; text: string };
	onChange: (value: { indices: number[]; custom: boolean; text: string }) => void;
}) {
	const id = useId();
	return (
		<fieldset disabled={locked} tabIndex={-1}>
			<legend>
				{question.header ? <small>{question.header}</small> : null}
				{question.question}
			</legend>
			{question.multiSelect ? <p className="muted">Puedes elegir varias opciones y añadir tu propia respuesta.</p> : null}
			{question.options.map((option, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: The protocol identifies immutable questionnaire options by their exact index.
				<label key={`${question.id}-${index}`} className="agent-permission-option">
					<input
						type={question.multiSelect ? "checkbox" : "radio"}
						name={id}
						checked={(question.multiSelect || !value.custom) && value.indices.includes(index)}
						onChange={(event) =>
							onChange({
								...value,
								custom: question.multiSelect ? value.custom : false,
								indices: question.multiSelect
									? event.target.checked
										? [...value.indices.filter((entry) => entry !== index), index].sort((a, b) => a - b)
										: value.indices.filter((entry) => entry !== index)
									: [index],
							})
						}
					/>
					<span>
						{option.label}
						{option.description ? <small>{option.description}</small> : null}
						{option.preview ? <span className="agent-permission-preview">{option.preview}</span> : null}
					</span>
				</label>
			))}
			<label className="agent-permission-option">
				<input
					type={question.multiSelect ? "checkbox" : "radio"}
					name={id}
					checked={value.custom}
					onChange={(event) => onChange({ ...value, custom: event.target.checked, indices: question.multiSelect ? value.indices : [] })}
				/>
				<span>Otra respuesta</span>
			</label>
			{value.custom ? (
				<label htmlFor={`${id}-other`}>
					Tu respuesta
					<textarea
						id={`${id}-other`}
						value={value.text}
						maxLength={16_384}
						onChange={(event) => onChange({ ...value, text: event.target.value })}
						required
					/>
				</label>
			) : null}
		</fieldset>
	);
}
