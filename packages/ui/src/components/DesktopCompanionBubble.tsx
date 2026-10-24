import { useLayoutEffect } from "react";
import { notificationPresentation, spokenCompanionCue } from "../companion-notification.ts";
import type { DesktopCompanionControls } from "../desktop-companion.ts";
import "../desktop-companion.css";

/** Its own transparent native window; never embeds a second character or connects to chat. */
export function DesktopCompanionBubble({ controls }: { controls: DesktopCompanionControls }) {
	const context = controls.state.context;
	const cue = spokenCompanionCue(context);
	const visible = controls.state.enabled && !!cue;
	const notificationId = cue?.id === context?.notification?.id ? cue?.id : undefined;
	const actionable = cue?.kind === "question" && !!cue.paneId && !!cue.sessionId && !!controls.openContext;
	const presentation = cue ? notificationPresentation(cue) : undefined;
	const summary =
		cue?.kind === "question"
			? (cue.summary ?? "Hay una pregunta para ti.")
			: (presentation?.summary ?? "Aquí sigo contigo.");
	const body = cue?.kind === "question" ? undefined : presentation?.body;
	const ready = controls.contextReady;
	useLayoutEffect(() => {
		if (!visible || !notificationId || !ready) return;
		let second: number | undefined;
		const first = requestAnimationFrame(() => {
			second = requestAnimationFrame(() => {
				void ready(notificationId).catch(() => {});
			});
		});
		return () => {
			cancelAnimationFrame(first);
			if (second !== undefined) cancelAnimationFrame(second);
		};
	}, [visible, notificationId, ready]);
	return (
		<aside
			className="desktop-companion-bubble"
			data-visible={visible}
			data-actionable={actionable}
			data-attributed={!!cue?.source && cue.kind === "notification"}
			aria-hidden={!visible}
			aria-label="Capri"
		>
			<div className="desktop-companion-speech" role="status" aria-live="polite" aria-atomic="true">
				{actionable ? (
					<button
						type="button"
						className="desktop-companion-bubble-message"
						aria-label={`Abrir sesión en Herdr: ${summary}`}
						tabIndex={visible ? 0 : -1}
						onClick={() => void controls.openContext?.()}
					>
						<span className="desktop-companion-bubble-summary">{summary}</span>
						<span className="desktop-companion-bubble-link" aria-hidden="true">
							↗
						</span>
					</button>
				) : (
					<div className="desktop-companion-bubble-message" data-has-body={!!body}>
						<span className="desktop-companion-bubble-summary">{summary}</span>
						{body ? (
							presentation?.quoted ? (
								<blockquote className="desktop-companion-bubble-detail">«{body}»</blockquote>
							) : (
								<span className="desktop-companion-bubble-detail">{body}</span>
							)
						) : null}
					</div>
				)}
				<button
					type="button"
					className="desktop-companion-bubble-close"
					aria-label="Cerrar aviso de Capri"
					tabIndex={visible ? 0 : -1}
					onClick={() => void controls.dismissContext?.(cue?.id)}
				>
					×
				</button>
			</div>
		</aside>
	);
}
