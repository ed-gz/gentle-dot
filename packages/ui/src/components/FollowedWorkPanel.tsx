import { useEffect, useRef, useState } from "react";
import type { OrchestrationClient } from "../orchestration.ts";
import type { FollowedWork, FollowedWorkAction, FollowedWorkSnapshot } from "../workflows.ts";
import "../followed-work.css";

const labels: Record<FollowedWork["state"], string> = {
	waiting: "Siguiendo agentes",
	running: "Dot está continuando",
	paused: "En pausa",
	completed: "Finalizado",
	cancelled: "Seguimiento cerrado",
	expired: "Seguimiento vencido",
	failed: "Necesita revisión",
};
const active = (work: FollowedWork) => work.state === "waiting" || work.state === "running";
const date = (value: string) =>
	new Date(value).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});

/** Status only while this screen is visible; no browser timer is responsible for continuing work. */
export function FollowedWorkPanel({
	client,
	connected,
}: {
	client: OrchestrationClient;
	connected: boolean;
}) {
	const [snapshot, setSnapshot] = useState<FollowedWorkSnapshot>();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState<string>();
	const [receipt, setReceipt] = useState<string>();
	const [revision, setRevision] = useState(0);
	const current = useRef(client);
	current.current = client;
	const mounted = useRef(true);
	const mutating = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: A different connection must not retain another computer's tasks.
	useEffect(() => {
		setSnapshot(undefined);
		setError(undefined);
		setReceipt(undefined);
	}, [client]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: A successful control action restarts the status request immediately.
	useEffect(() => {
		if (!connected || !client.followedWork) return;
		let live = true;
		let controller: AbortController | undefined;
		let timer: ReturnType<typeof setTimeout>;
		let loading = false;
		const poll = async () => {
			if (!live || loading || document.visibilityState === "hidden") return;
			clearTimeout(timer);
			loading = true;
			controller = new AbortController();
			try {
				const next = await client.followedWork?.(controller.signal);
				if (live && !controller.signal.aborted) {
					setSnapshot(next);
					setError(undefined);
				}
			} catch (problem) {
				if (live && !controller.signal.aborted)
					setError(problem instanceof Error ? problem.message : "No se pudo consultar el seguimiento.");
			} finally {
				loading = false;
				if (live) timer = setTimeout(() => void poll(), 8000);
			}
		};
		const visible = () => {
			if (document.visibilityState === "visible") void poll();
			else {
				clearTimeout(timer);
				controller?.abort();
			}
		};
		void poll();
		document.addEventListener("visibilitychange", visible);
		return () => {
			live = false;
			clearTimeout(timer);
			controller?.abort();
			document.removeEventListener("visibilitychange", visible);
		};
	}, [client, connected, revision]);
	const act = async (action: FollowedWorkAction) => {
		if (mutating.current || !client.controlFollowedWork || !connected) return;
		mutating.current = true;
		setBusy(action.workflowId);
		setReceipt(undefined);
		try {
			await client.controlFollowedWork(action);
			if (mounted.current && current.current === client) {
				setReceipt(
					action.action === "resume"
						? "Seguimiento reanudado."
						: action.action === "pause"
							? "Seguimiento en pausa."
							: "Seguimiento finalizado.",
				);
				setError(undefined);
				setRevision((value) => value + 1);
			}
		} catch (problem) {
			if (mounted.current && current.current === client)
				setError(
					problem instanceof Error
						? problem.message
						: "No se pudo confirmar el cambio. Actualiza antes de reintentar.",
				);
		} finally {
			mutating.current = false;
			if (mounted.current) setBusy(undefined);
		}
	};
	if (!client.followedWork || !client.controlFollowedWork) return null;
	const works = snapshot?.workflows ?? [];
	const running = works.filter(active);
	const ongoing = works.filter((w) => active(w) || w.state === "paused" || w.state === "failed");
	const past = works
		.filter((w) => w.state === "completed" || w.state === "expired" || w.state === "cancelled")
		.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
		.slice(0, 3);
	return (
		<details className="followed-work">
			<summary>
				<span className="followed-work-mark" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
						<path d="M8 5h8a4 4 0 0 1 0 8H8a4 4 0 0 0 0 8" />
						<path d="m5 2 3 3-3 3m14 2-3 3 3 3" />
					</svg>
				</span>
				<span>
					<strong>Seguimiento de Dot</strong>
					<span className="followed-work-caption">
						{!connected
							? "Sin conexión"
							: error || snapshot?.error
								? "Requiere revisión"
								: !snapshot
									? "Consultando…"
									: running.length
										? `${running.length} en curso`
										: ongoing.length
											? "Requiere atención"
											: "Disponible cuando lo necesites"}
					</span>
				</span>
				<span className="followed-work-chevron" aria-hidden="true">
					⌄
				</span>
			</summary>
			<div className="followed-work-body">
				{error ? (
					<p className="orchestration-error" role="alert">
						{error}
					</p>
				) : null}
				{!connected ? <p className="muted">Conecta con tu equipo para consultar el estado actual.</p> : null}
				{receipt ? (
					<p className="orchestration-receipt" role="status">
						{receipt}
					</p>
				) : null}
				{snapshot && !works.length ? (
					<p className="muted">
						Dile a Dot: «Coordina estos agentes hasta terminar el plan». Aquí podrás seguir el avance y
						pausarlo.
					</p>
				) : null}
				{snapshot?.error ? <p className="orchestration-error">{snapshot.error}</p> : null}
				{ongoing.map((work) => (
					<WorkCard
						key={work.id}
						work={work}
						disabled={!!busy || !connected || !!error || !!snapshot?.error}
						busy={busy === work.id}
						act={act}
					/>
				))}
				{past.length ? (
					<details className="followed-work-history">
						<summary>Finalizados recientemente · {past.length}</summary>
						{past.map((work) => (
							<WorkCard key={work.id} work={work} disabled busy={false} act={act} />
						))}
					</details>
				) : null}
				{ongoing.length ? (
					<p className="followed-work-footnote">
						Dot continúa este objetivo y resuelve solicitudes dentro de su alcance. Puedes pausarlo.
					</p>
				) : null}
				{ongoing.length ? (
					<p className="followed-work-footnote">
						Pausar el seguimiento deja en curso las tareas que ya recibieron los agentes. Puedes detenerlas
						desde su conversación.
					</p>
				) : null}
			</div>
		</details>
	);
}
function WorkCard({
	work,
	disabled,
	busy,
	act,
}: {
	work: FollowedWork;
	disabled: boolean;
	busy: boolean;
	act: (action: FollowedWorkAction) => Promise<void>;
}) {
	const resumable =
		(work.state === "paused" || work.state === "failed") &&
		(work.maxRuns === undefined || work.runs < work.maxRuns) &&
		(work.expiresAt === undefined || Date.parse(work.expiresAt) > Date.now());
	const actionable = active(work) || work.state === "paused" || work.state === "failed";
	return (
		<article className="followed-work-card" aria-label={work.objective}>
			<span className={`followed-work-state followed-work-state-${work.state}`}>{labels[work.state]}</span>
			<p className="followed-work-objective">{work.objective}</p>
			{work.lastMessage ? <p className="followed-work-note">{work.lastMessage}</p> : null}
			<div className="followed-work-meta">
				<span>
					{work.sessions.length} {work.sessions.length === 1 ? "agente" : "agentes"}
				</span>
			</div>
			<details className="followed-work-details">
				<summary>Ver detalles</summary>
				<p>{work.objective}</p>
				{work.expiresAt ? <p>Límite acordado: {date(work.expiresAt)}</p> : null}
				{work.maxRuns !== undefined ? (
					<p>
						Continuaciones acordadas: {work.runs} de {work.maxRuns}
					</p>
				) : null}
				<ul>
					{work.sessions.map((session) => (
						<li key={`${session.paneId}:${session.sessionId}`}>{session.label || "Sesión vinculada"}</li>
					))}
				</ul>
			</details>
			{actionable ? (
				<div className="followed-work-actions">
					{active(work) || resumable ? (
						<button
							type="button"
							disabled={disabled}
							onClick={() => void act({ action: resumable ? "resume" : "pause", workflowId: work.id })}
						>
							{busy ? "Guardando…" : resumable ? "Reanudar seguimiento" : "Pausar seguimiento"}
						</button>
					) : null}
					<button
						type="button"
						disabled={disabled}
						onClick={() => void act({ action: "stop", workflowId: work.id })}
					>
						Finalizar seguimiento
					</button>
				</div>
			) : null}
		</article>
	);
}
