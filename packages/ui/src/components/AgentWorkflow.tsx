import { useLayoutEffect, useRef } from "react";
import type { AgentWork } from "../orchestration.ts";

const TASK_STATUS = { pending: "Pendiente", in_progress: "En curso", done: "Lista" };
const ACTIVE = new Set(["queued", "running", "waiting"]);

/** Only confirmed, current delegates belong beside the chat. History remains in the conversation. */
export function AgentWorkflow({
	work,
	stale = false,
	onInspect,
	capriMobile = false,
}: {
	capriMobile?: boolean;
	work?: AgentWork;
	stale?: boolean;
	onInspect?: () => void;
}) {
	const current = work?.version === 1 ? work : undefined;
	const agents = stale
		? []
		: (current?.agents.filter((agent) => agent.source === "live" && ACTIVE.has(agent.status)) ?? []);
	const plan = current?.plan;
	const commands = current?.commands ?? [];
	const step = !stale && plan?.source === "live" ? plan.tasks.find(task => task.status === "in_progress") : undefined;
	const stepIndex = step && plan ? plan.tasks.indexOf(step) + 1 : 0;
	const running = stale ? 0 : commands.filter(command => command.status === "running" && command.source === "live").length;
	const currentCommand = stale ? undefined : commands.findLast(command => command.status === "running" && command.source === "live");
	const shelf = useRef<HTMLDivElement>(null);
	const restoreFocus = useRef(false);
	// If the last delegate finishes while its disclosure has focus, keep keyboard focus nearby.
	useLayoutEffect(() => {
		if (!agents.length && restoreFocus.current) {
			const target =
				shelf.current?.querySelector<HTMLElement>(".agent-plan summary") ??
				shelf.current?.parentElement?.querySelector<HTMLElement>(".session-context-trigger");
			target?.focus();
			restoreFocus.current = false;
		}
	}, [agents.length]);
	return (
		<div ref={shelf} className="agent-work-shelf">
			{capriMobile && step && plan ? <section className="capri-current-step" aria-label="Paso actual">
				<small>PASO {stepIndex} DE {plan.total}</small>
				<strong>{step.title}</strong>
				{step.note ? <p>{step.note}</p> : null}
				<ul>{plan.tasks.filter(task => task.status === "done").map(task => <li key={task.id}><span aria-hidden="true">✓</span>{task.title}</li>)}</ul>
			</section> : null}
			{plan ? <AgentPlan plan={plan} stale={stale} onInspect={onInspect} /> : null}
			{commands.length ? (
				<details className="agent-workflow agent-command-workflow" onToggle={event => {
					if (event.target === event.currentTarget && event.currentTarget.open) onInspect?.();
				}}>
					<summary>
						<span className="agent-work-summary">{capriMobile ? `${commands.length} acciones registradas` : "Comandos y herramientas"}</span>
						<span className="agent-work-active">{stale ? "Sin actualizar" : running ? `${running} en ejecución` : `${commands.length} recientes`}</span>
						{currentCommand ? <code className="agent-command-current">{currentCommand.label}</code> : null}
					</summary>
					<ul className="agent-work-list agent-command-list" aria-label="Actividad de la sesión">
						{[...commands].reverse().map(command => (
							<li key={command.id}>
								<div className="agent-work-item-heading">
									<code>{command.label}</code>
									{capriMobile && command.finishedAt && Number.isFinite(Date.parse(command.finishedAt)) ? <time dateTime={command.finishedAt}>{new Date(command.finishedAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}</time> : null}
									<span className={`agent-work-state agent-work-state-${command.status}`}>
										{stale && command.status === "running" ? "Sin estado actual" : command.status === "running" && command.source === "live" ? "Ejecutando" : command.status === "completed" ? "Completado" : command.status === "failed" ? "Falló" : "Sin confirmar"}
									</span>
								</div>
								{capriMobile && command.output ? <details className="capri-command-output"><summary>Ver salida completa</summary><pre>{command.output}</pre>{command.outputTruncated ? <small>Salida parcial</small> : null}</details> : null}
							</li>
							))}
					</ul>
				</details>
			) : null}
			{agents.length ? (
				<details
					className="agent-workflow"
					onToggle={(event) => {
						if (event.target === event.currentTarget && event.currentTarget.open) onInspect?.();
					}}
				>
					{/* biome-ignore lint/a11y/noStaticElementInteractions: Native disclosure focus is tracked to restore it when the final delegate finishes. */}
					<summary
						onFocus={() => {
							restoreFocus.current = true;
						}}
						onBlur={() => {
							restoreFocus.current = false;
						}}
					>
						<span className="agent-work-summary">Subagentes</span>
						<span className="agent-work-active">
							{agents.length} {agents.length === 1 ? "activo" : "activos"}
						</span>
						<svg
							className="agent-work-chevron"
							viewBox="0 0 24 24"
							width="20"
							height="20"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.8"
							aria-hidden="true"
						>
							<path d="m7 10 5 5 5-5" />
						</svg>
					</summary>
					<ul className="agent-work-list agent-delegates" aria-label="Subagentes activos">
						{agents.map((agent) => (
							<li key={agent.id}>
								<DelegateStatus status={agent.status} />
								<div>
									<strong>{agent.agent}</strong>
									{agent.label && agent.label !== agent.agent ? <p>{agent.label}</p> : null}
								</div>
							</li>
						))}
					</ul>
				</details>
			) : null}
		</div>
	);
}

function DelegateStatus({ status }: { status: AgentWork["agents"][number]["status"] }) {
	const label = status === "running" ? "Trabajando" : status === "waiting" ? "En espera" : "En cola";
	return (
		<span
			className={`agent-delegate-status agent-delegate-${status}`}
			role="img"
			aria-label={label}
			title={label}
		>
			<svg
				viewBox="0 0 24 24"
				width="20"
				height="20"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				{status === "running" ? (
					<>
						<circle cx="12" cy="12" r="8" opacity=".2" />
						<path className="agent-status-spinner" d="M12 4a8 8 0 0 1 8 8" />
					</>
				) : status === "waiting" ? (
					<>
						<circle cx="12" cy="12" r="8" />
						<path d="M9 9v6m6-6v6" />
					</>
				) : (
					<>
						<circle cx="12" cy="12" r="8" />
						<path d="M12 7v5l3 2" />
					</>
				)}
			</svg>
		</span>
	);
}

function AgentPlan({
	plan,
	stale,
	onInspect,
}: {
	plan: NonNullable<AgentWork["plan"]>;
	stale: boolean;
	onInspect?: () => void;
}) {
	return (
		<section className="agent-plan" aria-label="Plan de trabajo">
			<details
				onToggle={(event) => {
					if (event.target === event.currentTarget && event.currentTarget.open) onInspect?.();
				}}
			>
				<summary aria-label={`Ver tareas · ${plan.completed} de ${plan.total}`}>
					<strong>Plan</strong>
					<span className="agent-plan-count">
						{plan.completed}/{plan.total}
					</span>
					{plan.total > 0 ? (
						<progress
							value={plan.completed}
							max={plan.total}
							aria-label={`${plan.completed} de ${plan.total} tareas terminadas`}
						/>
					) : null}
					<span className="agent-plan-source">
						{stale ? "Sin actualizar" : plan.source === "history" ? "Último plan" : ""}
					</span>
					<svg
						className="agent-work-chevron"
						viewBox="0 0 24 24"
						width="18"
						height="18"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.8"
						aria-hidden="true"
					>
						<path d="m7 10 5 5 5-5" />
					</svg>
				</summary>
				<ul className="agent-work-list">
					{plan.tasks.map((task) => (
						<li key={task.id}>
							<div className="agent-work-item-heading">
								<span>{task.title}</span>
								<span
									className={`agent-work-state agent-work-state-${task.status === "done" ? "completed" : "unknown"}`}
								>
									{task.status === "in_progress" && stale ? "Sin estado actual" : TASK_STATUS[task.status]}
								</span>
							</div>
							{task.note ? <p className="agent-work-note">{task.note}</p> : null}
						</li>
					))}
					{!plan.tasks.length ? <li className="agent-work-note">Todavía no hay tareas en el plan.</li> : null}
				</ul>
			</details>
		</section>
	);
}
