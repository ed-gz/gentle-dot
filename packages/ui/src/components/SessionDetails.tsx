import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { AgentConversation, AgentPolicy, AgentSession } from "../orchestration.ts";
import type { OrchestrationControls } from "../useOrchestration.ts";
import "../agent-session-details.css";

const PROVIDERS = { herdr: "Herdr", orca: "Orca", terminal: "Terminal" };
const THINKING: Record<string, string> = {
	off: "Desactivado",
	minimal: "Mínimo",
	low: "Bajo",
	medium: "Medio",
	high: "Alto",
	xhigh: "Muy alto",
	max: "Máximo",
	ultra: "Ultra",
};
const formatPercent = (value: number) =>
	new Intl.NumberFormat("es", { maximumFractionDigits: 1 }).format(value);

/** Uses the same inspection as the conversation, without polling for a second copy of the metadata. */
export function SessionContext({
	session,
	conversation,
	stale,
	active,
}: {
	session: AgentSession;
	conversation?: AgentConversation;
	stale: boolean;
	active: boolean;
}) {
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const metadata = conversation?.sessionId === session.sessionId ? conversation?.metadata : undefined;
	const model = metadata?.model?.name || metadata?.model?.id || "Modelo sin informar";
	const thinking = metadata?.thinkingLevel;
	const percent = metadata?.context?.percent;
	const measured = typeof percent === "number" && Number.isFinite(percent);
	const historical = stale || metadata?.source === "history";
	const currentContext = !stale && metadata?.context?.source === "live";
	const contextLabel = measured ? `${formatPercent(percent)}% de contexto usado` : "Contexto sin lectura";
	useEffect(() => {
		if (!active) setOpen(false);
	}, [active]);
	const close = () => {
		setOpen(false);
		requestAnimationFrame(() => trigger.current?.focus());
	};
	return (
		<>
			<button
				ref={trigger}
				type="button"
				className="session-context-trigger"
				aria-label={`Ver información de la sesión: ${model}${thinking ? `, razonamiento ${THINKING[thinking] ?? thinking}` : ""}, ${contextLabel}${historical ? (currentContext ? ", detalles parciales" : ", última lectura") : ""}`}
				aria-haspopup="dialog"
				onClick={() => setOpen(true)}
			>
				<span className="session-context-model">{model}</span>
				{thinking ? <span className="session-context-effort">{THINKING[thinking] ?? thinking}</span> : null}
				<span className={`session-context-meter${measured && percent >= 85 ? " session-context-high" : ""}`}>
					<svg
						viewBox="0 0 20 20"
						width="16"
						height="16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.8"
						aria-hidden="true"
					>
						<circle cx="10" cy="10" r="7" opacity=".25" />
						{measured ? (
							<circle
								cx="10"
								cy="10"
								r="7"
								pathLength="100"
								strokeDasharray={`${Math.min(100, Math.max(0, percent))} 100`}
								transform="rotate(-90 10 10)"
							/>
						) : (
							<path d="M7 10h6" />
						)}
					</svg>
					{measured ? `${formatPercent(percent)}%` : "Contexto —"}
				</span>
				<svg
					className="session-context-chevron"
					viewBox="0 0 24 24"
					width="16"
					height="16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.8"
					aria-hidden="true"
				>
					<path d="m9 6 6 6-6 6" />
				</svg>
			</button>
			{open && active ? (
				<SessionDetails session={session} conversation={conversation} stale={stale} close={close} />
			) : null}
		</>
	);
}
type DialogView = "info" | "close" | "duplicate";

/** Session actions always use the identity shown when the person opens the menu. */
export function SessionMenu({
	session,
	conversation,
	controls,
	connected,
	stale = false,
	active,
	onClosed,
}: {
	session: AgentSession;
	conversation?: AgentConversation | undefined;
	controls: OrchestrationControls;
	connected: boolean;
	stale?: boolean;
	active: boolean;
	onClosed(): void;
}) {
	const menu = useRef<HTMLDetailsElement>(null);
	const trigger = useRef<HTMLElement>(null);
	const [view, setView] = useState<DialogView>();
	const [pending, setPending] = useState(false);
	const [failure, setFailure] = useState<string>();
	const [receipt, setReceipt] = useState<string>();
	const submitting = useRef(false);
	const intent = useRef<{ identity: string; action: OrchestrationControls["act"] } | undefined>(undefined);
	const mounted = useRef(true);
	const identity = `${session.paneId}:${session.sessionId ?? ""}`;
	const displayedIdentity = useRef(identity);
	const current = useRef({ identity, action: controls.act });
	current.current = { identity, action: controls.act };
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		if (displayedIdentity.current === identity) return;
		displayedIdentity.current = identity;
		setView(undefined);
		setFailure(undefined);
		setReceipt(undefined);
		intent.current = undefined;
		if (menu.current) menu.current.open = false;
	}, [identity]);
	useEffect(() => {
		if (!receipt) return;
		const timer = setTimeout(() => setReceipt(undefined), 5_000);
		return () => clearTimeout(timer);
	}, [receipt]);
	const closeDialog = () => {
		setView(undefined);
		requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
	};
	useEffect(() => {
		if (active) return;
		setView(undefined);
		if (menu.current) menu.current.open = false;
	}, [active]);
	useEffect(() => {
		const onBack = (event: Event) => {
			if (!active || event.defaultPrevented || !menu.current?.open || document.querySelector("dialog[open]"))
				return;
			menu.current.open = false;
			trigger.current?.focus({ preventScroll: true });
			event.preventDefault();
		};
		const outside = (event: PointerEvent) => {
			if (event.target instanceof Node && !menu.current?.contains(event.target) && menu.current)
				menu.current.open = false;
		};
		window.addEventListener("gentledot-back", onBack, true);
		document.addEventListener("pointerdown", outside);
		return () => {
			window.removeEventListener("gentledot-back", onBack, true);
			document.removeEventListener("pointerdown", outside);
		};
	}, [active]);
	const open = (next: DialogView) => {
		intent.current = { identity, action: controls.act };
		if (menu.current) menu.current.open = false;
		setFailure(undefined);
		setReceipt(undefined);
		setView(next);
	};
	const canAct = connected && session.connected && Boolean(session.sessionId) && !controls.busy && !pending;
	const canDuplicate =
		session.capabilities?.duplicate === true && session.state !== "working" && session.state !== "blocked";
	const confirmationValid = intent.current?.identity === identity && intent.current.action === controls.act;
	const run = async (action: "close" | "duplicate") => {
		if (
			!canAct ||
			!confirmationValid ||
			submitting.current ||
			!session.sessionId ||
			session.capabilities?.[action] !== true ||
			(action === "duplicate" && !canDuplicate)
		)
			return;
		const actionHandler = controls.act;
		submitting.current = true;
		setPending(true);
		setFailure(undefined);
		try {
			const accepted = await actionHandler({ action, paneId: session.paneId, sessionId: session.sessionId });
			if (
				!mounted.current ||
				current.current.identity !== identity ||
				current.current.action !== actionHandler
			)
				return;
			if (!accepted) {
				setFailure(
					"No se pudo confirmar la acción. Revisa el estado de la sesión antes de intentarlo de nuevo.",
				);
				return;
			}
			setView(undefined);
			if (action === "close") onClosed();
			else {
				setReceipt("Copia creada. La encontrarás en Sesiones cuando se conecte.");
				requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
			}
		} catch {
			if (mounted.current && current.current.identity === identity)
				setFailure(
					"No se pudo confirmar la acción. Revisa el estado de la sesión antes de intentarlo de nuevo.",
				);
		} finally {
			submitting.current = false;
			if (mounted.current) setPending(false);
		}
	};
	const policies =
		controls.snapshot?.policies.filter(
			(policy) => policy.paneId === session.paneId && policy.sessionId === session.sessionId,
		) ?? [];
	return (
		<div className="session-menu-anchor">
			<details
				className="agent-session-menu"
				ref={menu}
				onKeyDown={(event) => {
					if (event.key === "Escape" && menu.current?.open) {
						menu.current.open = false;
						trigger.current?.focus();
						event.stopPropagation();
					}
				}}
			>
				<summary aria-label="Detalles de la sesión" ref={trigger}>
					<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
						<circle cx="12" cy="5" r="2" />
						<circle cx="12" cy="12" r="2" />
						<circle cx="12" cy="19" r="2" />
					</svg>
				</summary>
				<div className="agent-session-menu-content session-action-list">
					<button type="button" onClick={() => open("info")}>
						Información de la sesión
					</button>
					{session.capabilities?.duplicate ? (
						<button type="button" disabled={!canAct || !canDuplicate} onClick={() => open("duplicate")}>
							Duplicar sesión
						</button>
					) : null}
					{session.capabilities?.duplicate && !canDuplicate ? (
						<p className="session-menu-note">
							Podrás duplicarla cuando termine y no tenga preguntas pendientes.
						</p>
					) : null}
					{session.connected &&
					session.sessionId &&
					session.capabilities?.abort &&
					(session.state === "working" || session.state === "blocked") ? (
						<button
							type="button"
							disabled={!canAct}
							onClick={() =>
								void controls.act({
									action: "abort",
									paneId: session.paneId,
									sessionId: session.sessionId as string,
								})
							}
						>
							Detener tarea
						</button>
					) : null}
					{policies.map((policy) => (
						<Policy key={policy.id} policy={policy} controls={controls} disabled={!canAct} />
					))}
					{session.capabilities?.close ? (
						<button
							type="button"
							className="session-close-action"
							disabled={!canAct}
							onClick={() => open("close")}
						>
							Cerrar sesión
						</button>
					) : null}
				</div>
			</details>
			{receipt ? (
				<div className="session-menu-receipt" role="status">
					{receipt}
					<button type="button" aria-label="Cerrar confirmación" onClick={() => setReceipt(undefined)}>
						×
					</button>
				</div>
			) : null}
			{view === "info" ? (
				<SessionDetails
					session={session}
					conversation={conversation}
					stale={stale || !connected || !session.connected}
					close={closeDialog}
				/>
			) : null}
			{view === "close" || view === "duplicate" ? (
				<SessionDialog
					title={view === "close" ? "Cerrar esta sesión" : "Duplicar esta sesión"}
					close={closeDialog}
				>
					<div className="session-confirm-content">
						<p>
							<strong>{session.label || "Sesión seleccionada"}</strong>
						</p>
						<p>
							{view === "close"
								? "Se cerrará el agente en el equipo. Si está trabajando, su tarea se interrumpirá. El historial guardado se conserva."
								: "Se abrirá otra sesión con este historial, modelo y configuración de perfil. Las autorizaciones de esta sesión no se copiarán."}
						</p>
						{view === "duplicate" && !canDuplicate ? (
							<p role="status">La sesión debe terminar y resolver sus preguntas antes de duplicarla.</p>
						) : null}
						{failure ? (
							<p className="session-detail-error" role="alert">
								{failure}
							</p>
						) : null}
						<div className="session-confirm-actions">
							<button type="button" onClick={closeDialog}>
								Volver
							</button>
							<button
								type="button"
								className={view === "close" ? "session-close-action" : "primary"}
								disabled={
									!canAct ||
									!confirmationValid ||
									session.capabilities?.[view] !== true ||
									(view === "duplicate" && !canDuplicate)
								}
								onClick={() => void run(view)}
							>
								{pending ? "Confirmando…" : view === "close" ? "Sí, cerrar sesión" : "Crear copia"}
							</button>
						</div>
					</div>
				</SessionDialog>
			) : null}
		</div>
	);
}

function Policy({
	policy,
	controls,
	disabled,
}: {
	policy: AgentPolicy;
	controls: OrchestrationControls;
	disabled: boolean;
}) {
	return (
		<div className="session-menu-policy">
			<span>
				{policy.action} · {policy.remainingUses} usos
			</span>
			<button
				type="button"
				disabled={disabled}
				onClick={() => void controls.act({ action: "revoke", policyId: policy.id })}
			>
				Revocar permiso
			</button>
		</div>
	);
}

export function SessionDetails({
	session,
	conversation,
	stale,
	close,
}: {
	session: AgentSession;
	conversation?: AgentConversation | undefined;
	stale: boolean;
	close(): void;
}) {
	const metadata = conversation?.sessionId === session.sessionId ? conversation?.metadata : undefined;
	const legacy = conversation?.sessionId === session.sessionId && !metadata && session.managed;
	const context = metadata?.context;
	const percent = context?.percent;
	const [copyStatus, setCopyStatus] = useState<string>();
	const copy = async (text: string) => {
		try {
			await navigator.clipboard.writeText(text);
			setCopyStatus("Copiado");
		} catch {
			setCopyStatus("No se pudo copiar. Puedes seleccionar el texto y copiarlo.");
		}
	};
	return (
		<SessionDialog title="Información de la sesión" close={close}>
			<div className="session-info-content">
				<p className="session-info-name">{session.label || "Sesión sin nombre"}</p>
				{stale || metadata?.source === "history" ? (
					<p className="session-detail-note" role="status">
						{stale
							? "Últimos datos recibidos. No se pudo verificar que sigan actualizados."
							: metadata?.model?.source === "live" && metadata.context?.source === "live"
								? "Modelo y contexto actuales. Algunos detalles proceden del historial; las conexiones no se han verificado."
								: metadata?.model?.source === "live"
									? "Modelo actual. Los demás detalles proceden del historial o todavía no están disponibles."
									: "Última configuración registrada. El uso de contexto y las conexiones requieren una lectura de la sesión activa."}
					</p>
				) : null}
				{!metadata ? (
					<p className="session-detail-note">
						{legacy
							? "Esta sesión usa una conexión anterior. Cuando termine, escribe /reload en su terminal para actualizarla."
							: "Esta sesión no comparte información de modelo, contexto y conexiones."}
					</p>
				) : null}
				<dl className="session-info-facts">
					{session.provider ? (
						<>
							<dt>Aplicación</dt>
							<dd>{PROVIDERS[session.provider]}</dd>
						</>
					) : null}
					{metadata ? (
						<>
							<dt>Modelo principal</dt>
							<dd>
								{metadata?.model ? (
									<>
										{metadata.model.name || metadata.model.id}
										<small>{metadata.model.provider}</small>
									</>
								) : (
									"No compartido por esta sesión"
								)}
							</dd>
							<dt>{metadata.profile?.source === "session" ? "Perfil activo" : "Perfil configurado"}</dt>
							<dd>
								{metadata?.profile ? (
									<>
										{metadata.profile.name}
										<small>
											{
												{
													global: "General",
													local: "Local",
													repo: "Del proyecto",
													session: "De esta sesión",
												}[metadata.profile.source]
											}
										</small>
									</>
								) : (
									"No compartido por esta sesión"
								)}
							</dd>
							{metadata?.thinkingLevel ? (
								<>
									<dt>Razonamiento</dt>
									<dd>{THINKING[metadata.thinkingLevel] ?? metadata.thinkingLevel}</dd>
								</>
							) : null}
						</>
					) : null}
				</dl>
				{metadata ? (
					<>
						{context ? (
							<section className="session-context" aria-label="Contexto de la sesión">
								<div>
									<h3>Contexto</h3>
									<strong>
										{percent !== null && percent !== undefined
											? `${new Intl.NumberFormat("es", { maximumFractionDigits: 1 }).format(percent)}%`
											: "Sin lectura"}
									</strong>
								</div>
								{percent !== null && percent !== undefined ? (
									<progress value={percent} max={100} aria-label="Contexto utilizado" />
								) : null}
								<p>
									{context.tokens === null
										? `Capacidad: ${new Intl.NumberFormat("es").format(context.contextWindow)} tokens. Uso no disponible todavía.`
										: `${new Intl.NumberFormat("es").format(context.tokens)} de ${new Intl.NumberFormat("es").format(context.contextWindow)} tokens.`}
								</p>
							</section>
						) : (
							<p className="session-detail-note">Esta sesión aún no comparte su uso de contexto.</p>
						)}
						<details className="session-info-disclosure">
							<summary>
								Conexiones MCP <span>{metadata?.mcp?.length ?? ""}</span>
							</summary>
							{metadata?.mcp ? (
								metadata.mcp.length ? (
									<ul>
										{metadata.mcp.map((item) => (
											<li key={item.name}>
												<strong>{item.name}</strong>
												<span>
													{
														{ available: "Disponible", configured: "Configurado", disabled: "Desactivado" }[
															item.status
														]
													}{" "}
													· {item.tools} {item.tools === 1 ? "herramienta" : "herramientas"}
												</span>
											</li>
										))}
									</ul>
								) : (
									<p>No se han informado conexiones MCP.</p>
								)
							) : (
								<p>Esta sesión no comparte sus conexiones MCP.</p>
							)}
						</details>
						<details className="session-info-disclosure">
							<summary>
								Herramientas <span>{metadata?.tools?.active.length ?? ""}</span>
							</summary>
							{metadata?.tools ? (
								<>
									<p>
										{metadata.tools.active.length} habilitadas de {metadata.tools.available} disponibles.
									</p>
									<ul className="session-tool-names">
										{metadata.tools.active.map((tool) => (
											<li key={tool}>{tool}</li>
										))}
									</ul>
								</>
							) : (
								<p>Esta sesión no comparte sus herramientas.</p>
							)}
						</details>
						<details className="session-info-disclosure">
							<summary>
								Habilidades <span>{metadata?.skills?.length ?? ""}</span>
							</summary>
							{metadata?.skills ? (
								metadata.skills.length ? (
									<ul>
										{metadata.skills.map((skill) => (
											<li key={skill.name}>
												<strong>{skill.name}</strong>
												{skill.description ? <span>{skill.description}</span> : null}
											</li>
										))}
									</ul>
								) : (
									<p>No se han informado habilidades.</p>
								)
							) : (
								<p>Esta sesión no comparte sus habilidades.</p>
							)}
						</details>
					</>
				) : null}
				<details className="session-info-disclosure">
					<summary>Carpeta e identificación</summary>
					{session.cwd ? (
						<div className="session-copy-row">
							<code>{session.cwd}</code>
							<button type="button" onClick={() => void copy(session.cwd as string)}>
								Copiar carpeta
							</button>
						</div>
					) : null}
					{session.sessionId ? (
						<div className="session-copy-row">
							<code>{session.sessionId}</code>
							<button type="button" onClick={() => void copy(session.sessionId as string)}>
								Copiar ID
							</button>
						</div>
					) : null}
					{copyStatus ? <p role="status">{copyStatus}</p> : null}
				</details>
			</div>
		</SessionDialog>
	);
}

function SessionDialog({ title, children, close }: { title: string; children: ReactNode; close(): void }) {
	const element = useRef<HTMLDialogElement>(null);
	const closeRef = useRef(close);
	closeRef.current = close;
	const id = useId();
	useEffect(() => {
		const dialog = element.current;
		dialog?.showModal();
		const onBack = (event: Event) => {
			if (event.defaultPrevented || !dialog?.open) return;
			event.preventDefault();
			closeRef.current();
		};
		window.addEventListener("gentledot-back", onBack, true);
		return () => {
			window.removeEventListener("gentledot-back", onBack, true);
			dialog?.close();
		};
	}, []);
	return (
		<dialog
			ref={element}
			className="agent-session-dialog"
			aria-labelledby={id}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
		>
			<header>
				<h2 id={id}>{title}</h2>
				<button type="button" aria-label="Cerrar detalles" onClick={close}>
					<svg
						width="20"
						height="20"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.8"
						aria-hidden="true"
					>
						<path d="m6 6 12 12M6 18 18 6" />
					</svg>
				</button>
			</header>
			<div className="session-dialog-scroll">{children}</div>
		</dialog>
	);
}
