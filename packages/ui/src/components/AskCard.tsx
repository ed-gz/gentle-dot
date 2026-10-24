import type { Ask, PinStatus } from "@gentle-dot/protocol";
import { useEffect, useRef, useState } from "react";
import { requestExpired, useRequestExpiry } from "../useRequestExpiry.ts";
import { PinForm } from "./PinForm.tsx";
import type { AnswerAppApproval, Send } from "./types.ts";

/** `pin`: the web PIN on a server (S25.8), for approvals allowed with it. */
export function AskCard({
	ask,
	send,
	pin,
	answerAppApproval,
	disabled = false,
}: {
	ask: Ask;
	send: Send;
	pin?: PinStatus;
	answerAppApproval?: AnswerAppApproval;
	disabled?: boolean;
}) {
	const [value, setValue] = useState(ask.prefill ?? "");
	const answer = (fields: { value?: string; confirmed?: boolean; cancelled?: boolean }) =>
		send({ type: "ui_response", requestId: ask.requestId, ...fields });

	if (ask.method === "app") {
		return <AppAskCard key={ask.requestId} ask={ask} answer={answerAppApproval} disabled={disabled} />;
	}

	// On a server, an approval is allowed with the web PIN (S25.8); declining needs none.
	if (ask.method === "pin") {
		return (
			<section className="ask-card" aria-label="The assistant needs your answer">
				<p className="eyebrow">Needs your answer</p>
				<p className="ask-title">{ask.title}</p>
				{ask.message ? (
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
					<section className="ask-message" aria-label="Details" tabIndex={0}>
						{ask.message}
					</section>
				) : null}
				<PinForm
					pin={pin ?? { set: true }}
					action="Allow"
					onPin={(value, created) => {
						if (created) send({ type: "pin_set", pin: value });
						send({ type: "pin_approve", requestId: ask.requestId, pin: value });
					}}
				>
					<button type="button" onClick={() => answer({ confirmed: false })}>
						Deny
					</button>
				</PinForm>
			</section>
		);
	}

	return (
		<section className="ask-card" aria-label="The assistant needs your answer">
			<p className="eyebrow">Needs your answer</p>
			<p className="ask-title">{ask.title}</p>
			{/* The whole text the user approves; long previews scroll inside the card. */}
			{ask.message ? (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
				<section className="ask-message" aria-label="Details" tabIndex={0}>
					{ask.message}
				</section>
			) : null}
			{ask.method === "select" ? (
				<div className="ask-options">
					{(ask.options ?? []).map((option) => (
						<button key={option} type="button" onClick={() => answer({ value: option })}>
							{option}
						</button>
					))}
				</div>
			) : null}
			{ask.method === "confirm" ? (
				<div className="ask-options">
					<button type="button" className="primary" onClick={() => answer({ confirmed: true })}>
						Yes
					</button>
					<button type="button" onClick={() => answer({ confirmed: false })}>
						No
					</button>
				</div>
			) : null}
			{ask.method === "input" || ask.method === "editor" ? (
				<form
					className="ask-form"
					onSubmit={(event) => {
						event.preventDefault();
						answer({ value });
					}}
				>
					{ask.method === "editor" ? (
						<textarea
							aria-label={ask.title}
							rows={6}
							value={value}
							onChange={(event) => setValue(event.target.value)}
						/>
					) : (
						<input
							aria-label={ask.title}
							placeholder={ask.placeholder ?? ""}
							value={value}
							onChange={(event) => setValue(event.target.value)}
						/>
					)}
					<button type="submit" className="primary">
						Send answer
					</button>
				</form>
			) : null}
			<button type="button" className="ask-skip" onClick={() => answer({ cancelled: true })}>
				Skip
			</button>
		</section>
	);
}

function AppAskCard({
	ask,
	answer,
	disabled,
}: {
	ask: Ask;
	answer?: AnswerAppApproval | undefined;
	disabled: boolean;
}) {
	const [pending, setPending] = useState(false);
	const [resolved, setResolved] = useState<boolean>();
	const [error, setError] = useState<string>();
	const submitting = useRef(false);
	const mounted = useRef(true);
	const expiresAt = ask.expiresAt ?? "";
	const expired = useRequestExpiry(expiresAt, true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const respond = async (approved: boolean) => {
		if (
			!answer ||
			disabled ||
			submitting.current ||
			resolved !== undefined ||
			requestExpired(expiresAt, true)
		)
			return;
		submitting.current = true;
		setPending(true);
		setError(undefined);
		try {
			await answer(ask.requestId, approved);
			if (mounted.current) setResolved(approved);
		} catch (problem) {
			if (mounted.current)
				setError(
					problem instanceof Error
						? problem.message
						: typeof problem === "string"
							? problem
							: "No se pudo confirmar tu respuesta. Revisa la solicitud antes de volver a intentarlo.",
				);
		} finally {
			submitting.current = false;
			if (mounted.current) setPending(false);
		}
	};
	return (
		<section className="ask-card ask-app-approval" aria-label="Permiso de Gentle Dot" aria-busy={pending}>
			<p className="eyebrow">Necesita tu permiso</p>
			<p className="ask-title">{ask.title}</p>
			{ask.message ? (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: The complete approval preview must remain keyboard-scrollable.
				<section className="ask-message" aria-label="Detalles de la solicitud" tabIndex={0}>
					{ask.message}
				</section>
			) : null}
			{answer ? (
				<>
					{error ? (
						<p className="ask-approval-error" role="alert">
							{error}
						</p>
					) : null}
					{pending || resolved !== undefined || expired || disabled ? (
						<p className="connector-note" role="status">
							{pending
								? "Enviando respuesta…"
								: resolved !== undefined
									? resolved
										? "Permiso concedido."
										: "Permiso rechazado."
									: expired
										? "Esta solicitud ya venció."
										: "Reconectando con tu equipo…"}
						</p>
					) : null}
					<div className="ask-options">
						<button
							type="button"
							className="primary"
							disabled={disabled || pending || expired || resolved !== undefined}
							onClick={() => void respond(true)}
						>
							Permitir
						</button>
						<button
							type="button"
							disabled={disabled || pending || expired || resolved !== undefined}
							onClick={() => void respond(false)}
						>
							Rechazar
						</button>
					</div>
				</>
			) : (
				<p className="connector-note">Responde desde la aplicación de escritorio o el teléfono vinculado.</p>
			)}
		</section>
	);
}
