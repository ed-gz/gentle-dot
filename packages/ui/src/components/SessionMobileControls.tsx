import { type ReactNode, useId } from "react";
import type { AgentWork } from "../orchestration.ts";
import "../session-mobile-controls.css";

export function SessionWorkShelf({
	mobile,
	capriMobile = false,
	open,
	onToggle,
	work,
	stale,
	children,
}: {
	mobile: boolean;
	capriMobile?: boolean;
	open: boolean;
	onToggle: () => void;
	work?: AgentWork;
	stale: boolean;
	children: ReactNode;
}) {
	const id = useId();
	if (!mobile) return <div className="agent-session-work">{children}</div>;
	return (
		<div className="agent-session-work session-mobile-controls">
			<button
				type="button"
				className="session-mobile-controls-trigger"
				aria-expanded={open}
				aria-controls={`${id}-content`}
				aria-labelledby={`${id}-title`}
				aria-describedby={`${id}-summary`}
				onClick={onToggle}
			>
				<span>
					<span id={`${id}-title`}>Detalles y actividad</span>
					<small id={`${id}-summary`}>{activitySummary(work, stale)}</small>
				</span>
				<Chevron open={open} />
			</button>
			{capriMobile && !stale && work?.version === 1 && work.plan && work.plan.total > 0 ? (
				<div className="capri-plan-progress"><progress aria-label="Progreso del plan" value={work.plan.completed} max={work.plan.total} /><span>{work.plan.completed}/{work.plan.total}</span></div>
			) : null}
			<div id={`${id}-content`} className="session-mobile-controls-content" hidden={!open}>
				{children}
			</div>
		</div>
	);
}

const DELIVERY_OPTIONS = [
	{
		value: "steer",
		label: "En la próxima pausa",
		description: "La sesión lo recibirá cuando haga una pausa.",
	},
	{
		value: "followUp",
		label: "Al terminar",
		description: "Quedará en cola hasta que termine el trabajo actual.",
	},
] as const;

export function SessionDeliveryPicker({
	value,
	open,
	onToggle,
	onChange,
}: {
	value: "steer" | "followUp";
	open: boolean;
	onToggle: () => void;
	onChange: (value: "steer" | "followUp") => void;
}) {
	const id = useId();
	const selected = value === "steer" ? DELIVERY_OPTIONS[0] : DELIVERY_OPTIONS[1];
	return (
		<div className="session-delivery-picker">
			<button
				type="button"
				className="session-delivery-trigger"
				aria-label={`Entrega del mensaje: ${selected.label}`}
				aria-expanded={open}
				aria-controls={id}
				onClick={onToggle}
			>
				<span className="session-delivery-label">Entrega:</span>
				<span className="session-delivery-value">{selected.label}</span>
				<Chevron open={open} />
			</button>
			<fieldset
				id={id}
				className="session-delivery-options"
				aria-label="Cuándo recibirá tu mensaje"
				hidden={!open}
			>
				{DELIVERY_OPTIONS.map((option) => (
					<button
						key={option.value}
						type="button"
						aria-pressed={value === option.value}
						aria-labelledby={`${id}-${option.value}-label`}
						aria-describedby={`${id}-${option.value}-description`}
						onClick={() => onChange(option.value)}
					>
						<span className="session-delivery-check" aria-hidden="true">
							{value === option.value ? (
								<svg
									viewBox="0 0 24 24"
									width="20"
									height="20"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									aria-hidden="true"
								>
									<path d="m5 12 4 4L19 6" />
								</svg>
							) : null}
						</span>
						<span>
							<strong id={`${id}-${option.value}-label`}>{option.label}</strong>
							<small id={`${id}-${option.value}-description`}>{option.description}</small>
						</span>
					</button>
				))}
			</fieldset>
		</div>
	);
}

function activitySummary(work: AgentWork | undefined, stale: boolean) {
	if (stale) return "Sin actualizar";
	const current = work?.version === 1 ? work : undefined;
	const parts: string[] = [];
	if (current?.plan) {
		const { completed, total, source } = current.plan;
		parts.push(`${source === "history" ? "Último plan" : "Plan"} ${completed}/${total}`);
	}
	const agents =
		current?.agents.filter(
			(agent) => agent.source === "live" && ["queued", "running", "waiting"].includes(agent.status),
		).length ?? 0;
	const commands =
		current?.commands.filter((command) => command.source === "live" && command.status === "running").length ??
		0;
	if (commands) parts.push(`${commands} ${commands === 1 ? "herramienta" : "herramientas"}`);
	if (agents) parts.push(`${agents} ${agents === 1 ? "subagente" : "subagentes"}`);
	return parts.join(" · ") || "Modelo, terminal y actividad";
}

function Chevron({ open }: { open: boolean }) {
	return (
		<svg
			className="session-mobile-chevron"
			viewBox="0 0 24 24"
			width="18"
			height="18"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			aria-hidden="true"
		>
			<path d={open ? "m7 14 5-5 5 5" : "m7 10 5 5 5-5"} />
		</svg>
	);
}
