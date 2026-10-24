import { type ReactNode, useEffect, useRef, useState } from "react";
import { useRequestPresentation } from "../useRequestPresentation.ts";
import "../request-presentation.css";

export function RequestPresentationSetting() {
	const [mode, setMode] = useRequestPresentation();
	return (
		<fieldset className="request-mode">
			<legend>Permisos y preguntas</legend>
			<label>
				<input type="radio" name="request-mode" checked={mode === "inline"} onChange={() => setMode("inline")} />
				Dentro de cada conversación
			</label>
			<label>
				<input type="radio" name="request-mode" checked={mode === "popup"} onChange={() => setMode("popup")} />
				Ventana emergente con respuestas
			</label>
		</fieldset>
	);
}

/** Presentation only: callers retain all source, identity, expiry and response guards. */
export function RequestPresentation({
	ids,
	children,
	active = true,
	title = "Solicitudes pendientes",
	enabled = true,
}: {
	ids: string[];
	children: ReactNode;
	active?: boolean;
	title?: string;
	enabled?: boolean;
}) {
	const [mode] = useRequestPresentation();
	const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
	const [foreground, setForeground] = useState(document.visibilityState !== "hidden");
	const dialog = useRef<HTMLDialogElement>(null);
	const close = useRef<HTMLButtonElement>(null);
	const reopen = useRef<HTMLButtonElement>(null);
	const currentIds = useRef(ids);
	currentIds.current = ids;
	const visible = active && foreground;
	const popup = enabled && mode === "popup";
	const open = visible && popup && ids.some((id) => !dismissed.has(id));
	const dismiss = () => setDismissed(new Set(currentIds.current));

	useEffect(() => {
		const update = () => setForeground(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);

	useEffect(() => {
		if (!open || !dialog.current) return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		const element = dialog.current;
		element.showModal();
		// Never focus an approval by default.
		close.current?.focus();
		const back = (event: Event) => {
			if (event.defaultPrevented) return;
			event.preventDefault();
			setDismissed(new Set(currentIds.current));
		};
		window.addEventListener("gentledot-back", back, true);
		return () => {
			window.removeEventListener("gentledot-back", back, true);
			if (element.open) element.close();
			if (previous?.isConnected && !previous.closest("[hidden]")) previous.focus({ preventScroll: true });
			else reopen.current?.focus({ preventScroll: true });
		};
	}, [open]);

	if (!visible || !ids.length) return null;
	if (!popup) return <>{children}</>;
	return (
		<section className="request-presentation" aria-label={title}>
			<button type="button" ref={reopen} onClick={() => setDismissed(new Set())}>
				Ver solicitudes pendientes ({ids.length})
			</button>
			{open ? (
				<dialog
					className="request-dialog"
					ref={dialog}
					aria-label={title}
					onCancel={(event) => { event.preventDefault(); dismiss(); }}
				>
					<header>
						<h3>{title}</h3>
						<button ref={close} type="button" onClick={dismiss}>Cerrar sin responder</button>
					</header>
					{children}
				</dialog>
			) : null}
		</section>
	);
}
