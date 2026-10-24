import { useEffect, useId, useRef, useState } from "react";
import { type TerminalMood, type TerminalMoodClient, type TerminalMoodState, TerminalMoodError, unavailableTerminalMood } from "../terminal-mood.ts";
import "../terminal-mood.css";

const presets: { mood: TerminalMood; label: string; detail: string }[] = [
	{ mood: "hacker", label: "Hacker", detail: "Verde eléctrico" },
	{ mood: "afterlife", label: "Afterlife", detail: "Violeta y neón" },
	{ mood: "sunset", label: "Atardecer", detail: "Ámbar cálido" },
];
interface Props {
	client?: TerminalMoodClient;
	paneId: string;
	sessionId?: string;
	paneLabels?: Record<string, string>;
	active?: boolean;
}

export function TerminalMoodControl({ active = true, ...props }: Props) {
	const owner = useRef({ client: props.client, paneId: props.paneId, sessionId: props.sessionId, epoch: 0 });
	if (owner.current.client !== props.client || owner.current.paneId !== props.paneId || owner.current.sessionId !== props.sessionId)
		owner.current = { client: props.client, paneId: props.paneId, sessionId: props.sessionId, epoch: owner.current.epoch + 1 };
	// A host/session switch remounts the controls, dropping pending responses and shared-window consent.
	return active ? <SessionTerminalMood key={owner.current.epoch} {...props} /> : null;
}

function SessionTerminalMood({ client, paneId, paneLabels }: Omit<Props, "active">) {
	const [expanded, setExpanded] = useState(false);
	const [status, setStatus] = useState<TerminalMoodState>();
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [confirmed, setConfirmed] = useState(false);
	const [error, setError] = useState<string>();
	const [receipt, setReceipt] = useState<string>();
	const request = useRef<AbortController | undefined>(undefined);
	const applying = useRef(false);
	const id = useId();
	useEffect(() => () => request.current?.abort(), []);
	async function read(preserveError = false) {
		if (applying.current) return;
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setLoading(true); setConfirmed(false); setReceipt(undefined);
		if (!preserveError) setError(undefined);
		try {
			const next = client ? await client.status(paneId, controller.signal) : unavailableTerminalMood(paneId);
			if (!controller.signal.aborted) setStatus(next);
		} catch (problem) {
			if (!controller.signal.aborted) {
				setStatus(undefined);
				setError(problem instanceof Error ? problem.message : "No se pudo consultar el ambiente.");
			}
		} finally { if (!controller.signal.aborted) setLoading(false); }
	}
	async function apply(mood: TerminalMood | "restore") {
		const shared = status?.sharedWindow || status?.requiresSharedConfirmation;
		if (!client || !status?.available || loading || applying.current || (shared && !confirmed) || (mood === "restore" && !status.canRestore)) return;
		applying.current = true;
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setBusy(true); setError(undefined); setReceipt(undefined);
		let conflict = false;
		try {
			const next = await client.apply(paneId, mood, shared && confirmed ? true : undefined, controller.signal);
			if (controller.signal.aborted) return;
			if (next.verified !== true || next.paneId !== paneId) throw new Error("El equipo no confirmó el cambio de ambiente.");
			setStatus(next); setConfirmed(false);
			setReceipt(mood === "restore" ? "Colores originales restaurados." : `Ambiente ${presets.find(item => item.mood === mood)?.label} aplicado a la ventana.`);
			window.dispatchEvent(new CustomEvent("gentle-dot-terminal-mood", { detail: { mood: next.mood, paneId } }));
		} catch (problem) {
			if (!controller.signal.aborted) {
				setError(problem instanceof Error ? problem.message : "No se pudo confirmar el cambio de ambiente.");
				setConfirmed(false);
				conflict = problem instanceof TerminalMoodError && problem.status === 409;
				if (!conflict) setStatus(undefined);
			}
		} finally {
			if (!controller.signal.aborted) {
				applying.current = false; setBusy(false);
				if (conflict) void read(true);
			}
		}
	}
	const shared = status?.sharedWindow || status?.requiresSharedConfirmation;
	const disabled = busy || loading || !status?.available || Boolean(shared && !confirmed);
	return <section className="terminal-mood" aria-label="Ambiente de terminal">
		<button type="button" className="terminal-mood-trigger" aria-expanded={expanded} aria-controls={`${id}-settings`}
			onClick={() => { const next = !expanded; setExpanded(next); if (next && !busy) void read(); }}>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></svg>
			<span>Ambiente de terminal</span><span aria-hidden="true">{expanded ? "−" : "+"}</span>
		</button>
		{expanded ? <div id={`${id}-settings`} className="terminal-mood-settings" aria-busy={busy || loading}>
			{loading ? <p role="status">Comprobando la ventana…</p> : null}
			{status?.available ? <>
				<p className="terminal-mood-scope">{shared
					? "Ventana compartida: cambiará los colores de todos sus paneles."
					: "Cambia los colores de esta ventana de terminal."}</p>
				{shared ? <>
					<p className="terminal-mood-panels">Sesiones detectadas: {status.affectedPaneIds.map(pane => paneLabels?.[pane] || pane).join(" · ")}</p>
					<label className="terminal-mood-confirm"><input type="checkbox" checked={confirmed} disabled={busy || loading}
						onChange={event => setConfirmed(event.target.checked)} />Acepto cambiar toda esta ventana compartida.</label>
				</> : null}
				<div className="terminal-mood-presets" role="group" aria-label="Elegir ambiente">
					{presets.map(item => <button key={item.mood} type="button" data-mood={item.mood} aria-pressed={status.mood === item.mood}
						disabled={disabled} onClick={() => void apply(item.mood)}><span className="terminal-mood-swatch" aria-hidden="true" /><strong>{item.label}</strong>{" "}<span>{item.detail}</span></button>)}
				</div>
				<button type="button" disabled={disabled || !status.canRestore} onClick={() => void apply("restore")}>Restaurar colores originales</button>
			</> : status ? <p role="status">{status.reason || "Esta ventana todavía no está preparada para cambiar su ambiente."}</p> : null}
			{busy ? <p role="status">Aplicando a la ventana…</p> : null}
			{receipt ? <p role="status">{receipt}</p> : null}
			{error ? <p className="terminal-mood-error" role="alert">{error}</p> : null}
			<button type="button" className="terminal-mood-refresh" disabled={busy || loading} onClick={() => void read()}>Actualizar ambiente</button>
		</div> : null}
	</section>;
}
