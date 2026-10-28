import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { AgentConversation, AgentSession, OrchestrationClient } from "../orchestration.ts";
import type { OrchestrationControls } from "../useOrchestration.ts";
import { reconcileDeliveries, restoreDeliveries, persistDeliveries, type OutgoingMessage } from "../session-delivery.ts";
import { useSessionPolling } from "../useSessionPolling.ts";
import { publishCompanionActivity, useCompanionResponse } from "../companion-activity.ts";
import "../session-delivery.css";
import { AgentPermissionCard } from "./AgentPermissionCard.tsx";
import { AgentAttachments } from "./AgentAttachments.tsx";
import { AgentWorkflow } from "./AgentWorkflow.tsx";
import { SessionContext, SessionMenu, SessionPendingQuestion } from "./SessionDetails.tsx";
import { SharedMarkdown } from "./SharedMarkdown.tsx";
import { TerminalMoodControl } from "./TerminalMoodControl.tsx";
import "../orchestration.css";
import "../session-turns.css";
import "../agent-mobile.css";
import "../agent-session.css";
import "../agent-activity.css";
import { SessionDeliveryPicker, SessionWorkShelf } from "./SessionMobileControls.tsx";

const STATES: Record<AgentSession["state"], string> = {
	idle: "Disponible",
	working: "Trabajando",
	blocked: "Te necesita",
	done: "Terminada",
	unknown: "Sin estado",
};
const PROVIDERS = { herdr: "Herdr", orca: "Orca", terminal: "Terminal" };
const DELIVERY_STATUS = {
	sending: "Enviando al equipo…",
	unconfirmed: "Sin confirmación. Revisa el historial antes de reintentar.",
	accepted: "Recibido por la conexión; esperando confirmación de la sesión.",
	queued: "En cola; la sesión todavía no ha recibido el mensaje.",
	delivered: "Recibido por la sesión",
	dismissed: "Descartado",
};

export function OrchestrationPanel({
	controls,
	client,
	active = true,
	mobile = false,
	capriMobile = false,
	requestsVisible = true,
	onVisibleSession,
	requestedSession,
	identityScope = "",
}: {
	controls: OrchestrationControls;
	client: OrchestrationClient;
	active?: boolean;
	mobile?: boolean;
	capriMobile?: boolean;
	requestsVisible?: boolean;
	onVisibleSession?(identity: { paneId: string; sessionId?: string } | undefined): void;
	requestedSession?: { paneId: string; sessionId?: string; key: number };
	/** Prevent saved session drafts/receipts from crossing linked hosts. */
	identityScope?: string;
}) {
	const { snapshot, busy, error, act, refresh } = controls;
	const [selected, updateSelected] = useState<string>();
	const [creating, setCreating] = useState(false);
	const [cwd, setCwd] = useState("");
	const [label, setLabel] = useState("");
	const [provider, setProvider] = useState<AgentSession["provider"]>();
	const [instruction, setInstruction] = useState("");
	const [receipt, setReceipt] = useState<string>();
	const [outbox, setOutbox] = useState<OutgoingMessage[]>(restoreDeliveries);
	const outboxRef = useRef(outbox);
	outboxRef.current = outbox;
	const [deliverAs, setDeliverAs] = useState<"steer" | "followUp">("steer");
	const [mobileDisclosure, setMobileDisclosure] = useState<"work" | "delivery">();
	const [conversation, setConversation] = useState<AgentConversation>();
	const [conversationError, setConversationError] = useState<string>();
	const [loadingEarlier, setLoadingEarlier] = useState(false);
	const [canJump, setCanJump] = useState(false);
	const drafts = useRef(new Map<string, string>());
	const positions = useRef(new Map<string, { top: number; following: boolean }>());
	const history = useRef(new Map<string, AgentConversation>());
	const pendingPrepend = useRef<{ top: number; height: number } | undefined>(undefined);
	const restoreTop = useRef<number | undefined>(undefined);
	const wasActive = useRef(active);
	const pageAbort = useRef<AbortController | undefined>(undefined);
	const conversationMessages =
		conversation?.messages.filter((message) => message.role === "user" || message.role === "assistant") ?? [];
	const session = snapshot?.sessions.find((entry) => entry.paneId === selected);
	const visiblePaneId = active ? session?.paneId : undefined;
	const visibleSessionId = active ? session?.sessionId : undefined;
	// A rejected mutation is not a transport disconnect. Every answer is revalidated
	// by the daemon; keep refresh/retry available after QUESTION_CHANGED or a refusal.
	const answerConnected = snapshot?.available === true;
	const connected = answerConnected && !error;
	const identity = session?.sessionId ? `${identityScope}${session.paneId}:${session.sessionId}` : undefined;
	useCompanionResponse(conversationMessages.findLast(message => message.role === "assistant")?.id, identity, active, ".agent-message-assistant");
	const clientEpoch = useRef({ client, epoch: 0 });
	if (clientEpoch.current.client !== client) clientEpoch.current = { client, epoch: clientEpoch.current.epoch + 1 };
	// Draft/file ownership survives view and availability changes. Only a new owner
	// invalidates an already dispatched acknowledgement; capture is fenced separately.
	const ownerEpoch = useRef({ identity, client, epoch: 0 });
	if (ownerEpoch.current.identity !== identity || ownerEpoch.current.client !== client) {
		ownerEpoch.current = { identity, client, epoch: ownerEpoch.current.epoch + 1 };
	}
	const capturedEpoch = ownerEpoch.current.epoch;
	const liveIdentity = useRef(identity);
	liveIdentity.current = identity;
	const activeSessions = [...(snapshot?.sessions ?? [])].sort((a, b) => {
		const priority = { blocked: 0, working: 1, idle: 2, done: 3, unknown: 4 };
		return priority[a.state] - priority[b.state];
	});
	const creationProviders = snapshot?.providers?.filter((entry) => entry.available && entry.canCreate);
	const creationProvider =
		creationProviders?.find((entry) => entry.id === provider)?.id ?? creationProviders?.[0]?.id;
	const canCreate = connected && (!snapshot?.providers || Boolean(creationProvider));
	const id = useId();
	const viewedSession = useRef<string | undefined>(undefined);
	const conversationViewport = useRef<HTMLDivElement>(null);
	const panel = useRef<HTMLElement>(null);
	const handledRequest = useRef<number | undefined>(undefined);
	const pendingRequest = useRef<number | undefined>(undefined);
	const followConversation = useRef(true);
	useEffect(() => { setMobileDisclosure(undefined); }, [identity, active, mobile]);
	const closeMobileDisclosure = useCallback(() => {
		const selector = mobileDisclosure === "work" ? ".session-mobile-controls-trigger" : ".session-delivery-trigger";
		setMobileDisclosure(undefined);
		panel.current?.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
	}, [mobileDisclosure]);
	const setSelected = useCallback(
		(paneId: string | undefined) => {
			if (identity) {
				drafts.current.set(identity, instruction);
				positions.current.set(identity, {
					top: conversationViewport.current?.scrollTop ?? 0,
					following: followConversation.current,
				});
				if (conversation) history.current.set(identity, conversation);
			}
			updateSelected(paneId);
		},
		[identity, instruction, conversation],
	);
	const selectRequestedSession = useRef(setSelected);
	selectRequestedSession.current = setSelected;
	useEffect(() => {
		if (!active || !requestedSession || !snapshot || handledRequest.current === requestedSession.key) return;
		if (!requestedSession.sessionId) {
			handledRequest.current = requestedSession.key;
			selectRequestedSession.current(undefined);
			return;
		}
		const target = snapshot.sessions.find(
			(entry) => entry.paneId === requestedSession.paneId && entry.sessionId === requestedSession.sessionId,
		);
		if (target) {
			handledRequest.current = requestedSession.key;
			setCreating(false);
			selectRequestedSession.current(target.paneId);
		} else if (pendingRequest.current !== requestedSession.key) {
			pendingRequest.current = requestedSession.key;
			selectRequestedSession.current(undefined);
		}
	}, [active, requestedSession, snapshot]);
	useEffect(() => {
		onVisibleSession?.(
			visiblePaneId
				? { paneId: visiblePaneId, ...(visibleSessionId ? { sessionId: visibleSessionId } : {}) }
				: undefined,
		);
		return () => onVisibleSession?.(undefined);
	}, [visiblePaneId, visibleSessionId, onVisibleSession]);
	useLayoutEffect(() => {
		if (viewedSession.current === identity) return;
		viewedSession.current = identity;
		pageAbort.current?.abort();
		setLoadingEarlier(false);
		pendingPrepend.current = undefined;
		const saved = identity ? positions.current.get(identity) : undefined;
		followConversation.current = saved?.following ?? true;
		restoreTop.current = saved?.top;
		setConversation(identity ? history.current.get(identity) : undefined);
		setConversationError(undefined);
		setInstruction(identity ? (drafts.current.get(identity) ?? "") : "");
		setReceipt(undefined);
	}, [identity]);
	useLayoutEffect(() => {
		const element = conversationViewport.current;
		if (active && !wasActive.current && identity) restoreTop.current = positions.current.get(identity)?.top;
		wasActive.current = active;
		if (!element || !active || !conversation) return;
		if (pendingPrepend.current) {
			const before = pendingPrepend.current;
			element.scrollTop = before.top + element.scrollHeight - before.height;
			pendingPrepend.current = undefined;
		} else if (restoreTop.current !== undefined) {
			element.scrollTop = restoreTop.current;
			restoreTop.current = undefined;
		} else if (followConversation.current && session?.state !== "blocked")
			element.scrollTop = element.scrollHeight;
		setCanJump(element.scrollHeight - element.scrollTop - element.clientHeight > 72);
	}, [conversation, outbox, active, identity, session?.state]);
	useEffect(() => () => pageAbort.current?.abort(), []);
	const loadEarlier = async () => {
		if (!identity || !session?.sessionId || !conversation?.history?.before || loadingEarlier) return;
		const key = identity;
		const controller = new AbortController();
		pageAbort.current = controller;
		setLoadingEarlier(true);
		setConversationError(undefined);
		try {
			const earlier = await client.inspect(session.paneId, session.sessionId, controller.signal, {
				before: conversation.history.before,
				limit: 50,
			});
			if (controller.signal.aborted || viewedSession.current !== key) return;
			const element = conversationViewport.current;
			if (element) pendingPrepend.current = { top: element.scrollTop, height: element.scrollHeight };
			followConversation.current = false;
			setConversation((current) =>
				current
					? {
							...current,
							history: earlier.history,
							messages: mergeMessages(earlier.messages, current.messages),
						}
					: earlier,
			);
		} catch (problem) {
			if (!controller.signal.aborted)
				setConversationError(problem instanceof Error ? problem.message : "No se pudo cargar el historial.");
		} finally {
			if (!controller.signal.aborted) setLoadingEarlier(false);
		}
	};

	const refreshConversation = useSessionPolling(client, session?.paneId, session?.sessionId,
		Boolean(active && session?.connected && (session.capabilities?.inspect ?? session.managed)),
		session?.state === "working" || outbox.some(item => item.identity === identity && ["sending", "accepted", "queued"].includes(item.status)),
		(next) => {
			setConversation((current) => {
				const value = current && next.history?.supported ? {
					...next,
					messages: mergeMessages(current.messages, next.messages),
					history: current.history?.supported && current.messages[0]?.id !== next.messages[0]?.id ? current.history : next.history,
				} : next;
				if (identity) {
					history.current.set(identity, value);
					if (history.current.size > 12) { const oldest = history.current.keys().next().value; if (oldest) history.current.delete(oldest); }
				}
				return value;
			});
			setConversationError(undefined);
		},
		(problem) => setConversationError(problem instanceof Error ? problem.message : "No se pudo cargar esta conversación."));
	useEffect(() => {
		if (conversation && conversation.sessionId === session?.sessionId)
			setOutbox(current => reconcileDeliveries(current, conversation, identity));
	}, [conversation, identity, session?.sessionId]);
	useEffect(() => { persistDeliveries(outbox); }, [outbox]);
	const retryDelivery = async (item: OutgoingMessage) => {
		if (!session?.sessionId || !connected || !session.connected || !active || busy) return;
		if (!item.payload) {
			// A receipt from another client only contains a potentially truncated preview.
			// Never resend it silently or pretend its attachments can be reconstructed.
			setInstruction(item.text);
			setReceipt("Revisa el mensaje completo y vuelve a adjuntar los archivos antes de enviarlo.");
			panel.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
			return;
		}
		let payload: unknown;
		try { payload = JSON.parse(item.payload); } catch { setReceipt("No se pudo recuperar el envío. Revisa el mensaje antes de enviarlo."); return; }
		if (!Array.isArray(payload) || typeof payload[0] !== "string") return;
		const [text, attachments, mode] = payload;
		setOutbox(current => current.map(entry => entry.id === item.id ? {...entry, status:"sending"} : entry));
		const sent = await act({action:"prompt", paneId:session.paneId, sessionId:session.sessionId, text,
			...(attachments ? {attachments} : {}), clientMessageId:item.id, ...(mode ? {deliverAs:mode} : {})});
		setOutbox(current => current.map(entry => entry.id === item.id && entry.status === "sending" ? {...entry, status:sent ? "accepted" : "unconfirmed"} : entry));
		refreshConversation();
	};
	const lastCompanionDelivery = useRef("");
	useEffect(() => {
		if (!active || !identity) return;
		const last = outbox.findLast(item => item.identity === identity);
		if (!last || lastCompanionDelivery.current === `${last.id}:${last.status}`) return;
		lastCompanionDelivery.current = `${last.id}:${last.status}`;
		if (last.status === "queued") publishCompanionActivity("queued", panel.current?.querySelector("textarea"));
		else if (last.status === "delivered") publishCompanionActivity("submitted", panel.current?.querySelector(".agent-message-user:last-of-type"));
		else if (last.status === "unconfirmed") publishCompanionActivity("failed", panel.current?.querySelector("textarea"));
	}, [outbox, active, identity]);

	useEffect(() => {
		const onBack = (event: Event) => {
			if (
				!active ||
				event.defaultPrevented ||
				document.querySelector("dialog[open]") ||
				panel.current?.querySelector(".agent-session-menu[open]")
			)
				return;
			if (mobile && mobileDisclosure) closeMobileDisclosure();
			else if (selected) setSelected(undefined);
			else if (creating) setCreating(false);
			else return;
			event.preventDefault();
		};
		window.addEventListener("gentledot-back", onBack, true);
		return () => window.removeEventListener("gentledot-back", onBack, true);
	}, [selected, creating, active, mobile, mobileDisclosure, closeMobileDisclosure, setSelected]);
	useEffect(() => {
		if (!active || !mobile || !mobileDisclosure) return;
		const onEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]") || panel.current?.querySelector(".agent-session-menu[open]")) return;
			event.preventDefault();
			closeMobileDisclosure();
		};
		window.addEventListener("keydown", onEscape);
		return () => window.removeEventListener("keydown", onEscape);
	}, [active, mobile, mobileDisclosure, closeMobileDisclosure]);

	const selectedView = session ? (
		<section className="agent-detail" aria-label={`Sesión ${session.label}`}>
			<SessionWorkShelf mobile={mobile} capriMobile={mobile && capriMobile} open={mobileDisclosure === "work"}
				onToggle={() => setMobileDisclosure(current => current === "work" ? undefined : "work")}
				work={conversation?.work} stale={Boolean(conversationError) || !connected || !session.connected}>
				<TerminalMoodControl client={client.terminalMood} paneId={session.paneId} sessionId={session.sessionId}
					active={active} paneLabels={Object.fromEntries((snapshot?.sessions ?? []).map(item => [item.paneId, item.label]))} />
				<SessionContext
					key={`context:${identity}`}
					session={session}
					conversation={conversation}
					stale={Boolean(conversationError) || !connected || !session.connected}
					active={active}
				/>
				<AgentWorkflow
					capriMobile={mobile && capriMobile}
					key={`${session.paneId}:${session.sessionId ?? ""}`}
					work={conversation?.work}
					stale={Boolean(conversationError) || !connected || !session.connected}
					onInspect={() => {
						followConversation.current = false;
					}}
				/>
			</SessionWorkShelf>
			<div
				className="agent-detail-scroll"
				ref={conversationViewport}
				onScroll={() => {
					const element = conversationViewport.current;
					if (element && active) {
						followConversation.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
						setCanJump(!followConversation.current);
						if (identity)
							positions.current.set(identity, {
								top: element.scrollTop,
								following: followConversation.current,
							});
					}
				}}
			>
				{receipt ? (
					<p className="orchestration-receipt" role="status">
						{receipt}
					</p>
				) : null}
				{error ? (
					<p className="orchestration-error" role="alert">
						{error}
					</p>
				) : null}
				{conversationError ? (
					<p className="orchestration-error" role="status">
						{conversationError}
					</p>
				) : null}
				{!conversation && !conversationError ? <p className="muted" role="status">{
					session.connected && session.sessionId && (session.capabilities?.inspect ?? session.managed)
						? "Cargando el historial de esta sesión…"
						: "Esta terminal no ofrece un historial de agente conectado. Su estado sigue disponible en Detalles y actividad."
				}</p> : null}

				{conversation ? (
					<section
						className="agent-conversation"
						aria-label="Conversación de la sesión"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the conversation.
						tabIndex={0}
					>
						{conversation.history?.hasEarlier && conversation.history.before ? (
							<button
								type="button"
								className="agent-earlier"
								disabled={loadingEarlier}
								onClick={() => void loadEarlier()}
							>
								{loadingEarlier ? "Cargando…" : "Ver mensajes anteriores"}
							</button>
						) : null}
						{conversationMessages.length === 0 && !outbox.some(item => item.identity === identity && !["delivered", "dismissed"].includes(item.status)) ? <p className="muted">Todavía no hay mensajes.</p> : null}
						<SessionTurns messages={conversation.messages} pending={outbox.filter(item => item.identity === identity)}
							onRetry={item => void retryDelivery(item)} onDiscard={item => setOutbox(current => current.map(entry => entry === item ? {...entry, status:"dismissed"} : entry))}
							retryDisabled={!active || !connected || !session.connected || busy} waiting={conversation.status === "waiting"} />
					</section>
				) : null}

			</div>
			{canJump ? (
				<button
					type="button"
					className="agent-jump"
					onClick={() => {
						followConversation.current = true;
						const el = conversationViewport.current;
						if (el) el.scrollTop = el.scrollHeight;
						setCanJump(false);
					}}
				>
					Ir al último mensaje ↓
				</button>
			) : null}
			<SessionPendingQuestion session={session} conversation={conversation} controls={controls} disabled={!active || !answerConnected || !session.connected || !!conversationError}/>
			{active && connected && session.connected && session.state === "working" ? (
				<div className="session-working" role="status" aria-label="Actividad de la sesión" aria-atomic="true">
					<span className="session-working-spinner" aria-hidden="true" />
					Trabajando…
				</div>
			) : null}
			{!(session.capabilities?.prompt ?? session.managed) || !session.sessionId ? (
				<p className="orchestration-intro">
					Solo consulta
				</p>
			) : (
				<>
				{session.capabilities?.deliveryModes?.includes("steer") ? (
					mobile ? <SessionDeliveryPicker value={deliverAs} open={mobileDisclosure === "delivery"}
						onToggle={() => setMobileDisclosure(current => current === "delivery" ? undefined : "delivery")}
						onChange={value => { setDeliverAs(value); closeMobileDisclosure(); }} /> :
					<label className="session-delivery-mode">Entrega del mensaje
						<select value={deliverAs} onChange={event => setDeliverAs(event.target.value as "steer" | "followUp")}>
							<option value="steer">En la siguiente pausa de la sesión</option>
							<option value="followUp">Al terminar el trabajo actual</option>
						</select>
					</label>
				) : null}
				<AgentAttachments key={`${identity}:${clientEpoch.current.epoch}`} client={client} paneId={session.paneId} sessionId={session.sessionId}
					text={instruction} onText={setInstruction} busy={busy} disabled={!connected || !active || !session.connected}
					images={session.capabilities?.attachments?.images ?? false}
					filesEnabled={session.capabilities?.attachments?.version === 1 && Boolean(client.uploadAttachment)}
					onSend={async (text, attachments) => {
						const mode = session.capabilities?.deliveryModes?.includes(deliverAs) ? deliverAs : undefined;
						const payload = JSON.stringify([text, attachments, mode]);
						const previous = outboxRef.current.findLast(item => item.identity === identity && item.payload === payload && item.status === "unconfirmed");
						const messageId = previous?.id ?? crypto.randomUUID();
						followConversation.current = true;
						setOutbox(current => [...current.filter(item => item.id !== messageId), { id: messageId, identity: identity!, text, payload, createdAt: Date.now(), status: "sending", attachmentNames: attachments?.map(file => file.name), baseline: previous?.baseline ?? new Set(conversation?.messages.map(message => message.id)) }]);
						const sent = await act({ action: "prompt", paneId: session.paneId, sessionId: session.sessionId!, text,
							...(attachments ? { attachments } : {}),
							...(session.capabilities?.deliveryReceipts ? { clientMessageId: messageId } : {}), ...(mode ? { deliverAs: mode } : {}) });
						if (clientEpoch.current.client === client) setOutbox(current => current.map(item => item.id === messageId && item.status === "sending" ? { ...item, status: sent ? "accepted" : "unconfirmed" } : item));
						refreshConversation();
						if (sent && ownerEpoch.current.epoch === capturedEpoch && liveIdentity.current === identity && clientEpoch.current.client === client) {
							setInstruction("");
							if (identity) drafts.current.delete(identity);
							followConversation.current = true;
							setReceipt(undefined);
						}
						return sent && ownerEpoch.current.epoch === capturedEpoch && liveIdentity.current === identity && clientEpoch.current.client === client;
					}} />
				</>
			)}
		</section>
	) : null;
	if (session)
		return (
			<section
				className="orchestration orchestration-with-session"
				aria-label="Agentes del equipo"
				ref={panel}
			>
				<div className="agent-detail-navigation">
					<button type="button" aria-label="Todos los agentes" onClick={() => setSelected(undefined)}>
						←
					</button>
					<div className="agent-current-session">
						<h3>{session.label || "Sesión seleccionada"}</h3>
						<SessionStatus session={session} />
					</div>
					<SessionMenu
						key={identity}
						session={session}
						conversation={conversation}
						stale={Boolean(conversationError)}
						controls={controls}
						connected={connected}
						active={active}
						onClosed={() => setSelected(undefined)}
					/>
				</div>
				{selectedView}
			</section>
		);

	return (
		<section className="orchestration" aria-label="Agentes del equipo" ref={panel}>
			<div className="orchestration-heading">
				<div>
					<h2>Sesiones</h2>
				</div>
				<button
					type="button"
					className="session-refresh"
					aria-label="Actualizar sesiones"
					disabled={busy}
					onClick={() => void refresh()}
				>
					<svg
						width="21"
						height="21"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.8"
						aria-hidden="true"
					>
						<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" />
					</svg>
				</button>
			</div>
			{error ? (
				<p className="orchestration-error" role="alert">
					{error} El último estado puede estar desactualizado.
				</p>
			) : null}
			{!snapshot && !error ? <p role="status">Conectando con tu equipo…</p> : null}
			{snapshot && !snapshot.available ? (
				<p className="orchestration-error" role="status">
					{snapshot.error ||
						"No hay agentes disponibles en este momento. Aparecerán aquí cuando estén activos en tu equipo."}
				</p>
			) : null}
			{receipt ? (
				<p className="orchestration-receipt" role="status">
					{receipt}
				</p>
			) : null}

			{active && requestsVisible && snapshot && snapshot.approvals.length > 0 ? (
				<section className="orchestration-section" aria-label="Permisos pendientes">
					<h3>
						Necesitan tu permiso <span className="chip">{snapshot.approvals.length}</span>
					</h3>
					{snapshot.approvals.map((approval) => (
						<AgentPermissionCard
							key={approval.id}
							approval={approval}
							controls={controls}
							disabled={!answerConnected || !snapshot.sessions.some((entry) => entry.paneId === approval.paneId && entry.sessionId === approval.sessionId && entry.connected)}
							label={snapshot.sessions.find((entry) => entry.paneId === approval.paneId && entry.sessionId === approval.sessionId)?.label}
						/>
					))}
				</section>
			) : null}

			<section className="orchestration-section" aria-label="Sesiones de agentes">
				<div className="orchestration-heading">
					<span className="muted">
						{activeSessions.length} {activeSessions.length === 1 ? "sesión" : "sesiones"}
					</span>
					<button
						type="button"
						onClick={() => setCreating(!creating)}
						aria-expanded={creating}
						disabled={!canCreate || busy}
					>
						{creating ? "Cancelar nueva sesión" : "Nueva sesión"}
					</button>
				</div>
				{creating ? (
					<form
						className="orchestration-form card"
						onSubmit={async (event) => {
							event.preventDefault();
							if (!cwd.trim() || !canCreate) return;
							if (
								await act({
									action: "create",
									cwd: cwd.trim(),
									...(creationProvider ? { provider: creationProvider } : {}),
									...(label.trim() ? { label: label.trim() } : {}),
								})
							) {
								setCreating(false);
								setLabel("");
								setReceipt("Sesión creada. Selecciónala cuando se conecte para enviar una instrucción.");
							}
						}}
					>
						{snapshot?.providers ? (
							<>
								<label htmlFor={`${id}-provider`}>Abrir en</label>
								<select
									id={`${id}-provider`}
									value={creationProvider ?? ""}
									onChange={(event) => setProvider(event.target.value as AgentSession["provider"])}
								>
									{snapshot.providers.map((entry) => (
										<option key={entry.id} value={entry.id} disabled={!entry.available || !entry.canCreate}>
											{PROVIDERS[entry.id]}
											{!entry.available || !entry.canCreate ? " · no disponible" : ""}
										</option>
									))}
								</select>
							</>
						) : null}
						<div className="session-recent-folders" role="group" aria-label="Carpetas recientes">
							{[...new Set(snapshot?.sessions.map(entry => entry.cwd?.trim()).filter((folder): folder is string => Boolean(folder)))].slice(0, 6).map(folder => (
								<button type="button" key={folder} aria-pressed={cwd === folder} onClick={() => setCwd(folder)}>{folder}</button>
							))}
						</div>
						<label htmlFor={`${id}-cwd`}>Carpeta del proyecto en tu equipo</label>
						<input
							id={`${id}-cwd`}
							required
							value={cwd}
							placeholder="/home/usuario/proyectos/mi-proyecto"
							onChange={(event) => setCwd(event.target.value)}
							autoComplete="off"
							spellCheck={false}
						/>
						<label htmlFor={`${id}-label`}>
							Nombre de la sesión <span className="muted">(opcional)</span>
						</label>
						<input
							id={`${id}-label`}
							value={label}
							maxLength={120}
							onChange={(event) => setLabel(event.target.value)}
						/>
						<button type="submit" className="primary" disabled={busy || !cwd.trim() || !canCreate}>
							{busy ? "Creando…" : "Crear sesión"}
						</button>
					</form>
				) : null}
				{snapshot && activeSessions.length === 0 ? (
					<p className="orchestration-empty">
						No hay sesiones activas. Puedes pedir a Dot que inicie una desde el chat.
					</p>
				) : null}
				<SessionGroups sessions={activeSessions} enabled={mobile && capriMobile}>
					{(entry) => (
						<div className="agent-session-row" key={`${entry.paneId}:${entry.sessionId}`}>
						<button
							type="button"
							className="agent-session"
							data-pane-id={entry.paneId}
							data-session-id={entry.sessionId}
							aria-label={`${entry.label || "Sesión sin nombre"} · ${entry.connected ? STATES[entry.state] : "Sin conexión"}`}
							aria-pressed={selected === entry.paneId}
							onClick={() => setSelected(selected === entry.paneId ? undefined : entry.paneId)}
						>
							{mobile && capriMobile ? <span className="capri-session-type" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m5 6 6 6-6 6m8 0h6" /></svg></span> : null}
							<span className="agent-session-top">
								<strong>{entry.label || "Sesión sin nombre"}</strong>
								<span className="agent-session-state">{entry.connected && entry.state === "working" ? <span className="session-working-dot" aria-hidden="true" /> : null}<SessionStatus session={entry} /><span aria-hidden="true">{entry.connected ? STATES[entry.state] : "Sin conexión"}</span></span>
							</span>
							{mobile && capriMobile && entry.cwd ? <span className="capri-session-project">{entry.provider ? PROVIDERS[entry.provider] : "TI"} · {entry.cwd.split("/").filter(Boolean).at(-1)}</span> : null}
							<span className="agent-preview">
								{entry.lastMessage ||
									((entry.capabilities?.prompt ?? entry.managed) ? "Abre la conversación" : "Sólo lectura")}
							</span>
						</button>
						<SessionMenu session={entry} controls={controls} connected={connected} active={active} onClosed={() => setSelected(undefined)} />
						</div>
					)}
				</SessionGroups>
			</section>
		</section>
	);
}

/** Grouping is a projection of the existing sorted list, never another session store. */
function SessionGroups({ sessions, enabled, children }: {
	sessions: AgentSession[];
	enabled: boolean;
	children: (session: AgentSession) => ReactNode;
}) {
	if (!enabled) return <div className="agent-sessions">{sessions.map(children)}</div>;
	const ongoing = (session: AgentSession) => session.state === "working" || session.state === "blocked";
	return <div className="capri-session-groups">{[
		{ title: "En curso", entries: sessions.filter(ongoing) },
		{ title: "Disponibles", entries: sessions.filter(session => !ongoing(session)) },
	].map(group => <details className="capri-session-group" key={group.title} open>
		<summary>{group.title} · {group.entries.length}</summary>
		<div className="agent-sessions">{group.entries.map(children)}</div>
	</details>)}</div>;
}

function mergeMessages(earlier: AgentConversation["messages"], later: AgentConversation["messages"]) {
	const messages = new Map(earlier.map((message) => [message.id, message]));
	for (const message of later) messages.set(message.id, message);
	return [...messages.values()];
}

/** User entries are the only turn boundaries; delegated replies never create new turns. */
export function SessionTurns({ messages, pending = [], onRetry, onDiscard, retryDisabled = false, waiting = false }: {
	messages: AgentConversation["messages"]; pending?: OutgoingMessage[];
	onRetry?(item: OutgoingMessage): void; onDiscard?(item: OutgoingMessage): void; retryDisabled?: boolean; waiting?: boolean;
}) {
	const timeline = [...messages];
	const pendingById = new Map<string, OutgoingMessage>();
	for (const item of [...pending].filter(item => !["delivered", "dismissed"].includes(item.status)).sort((a,b) => a.createdAt-b.createdAt)) {
		const id = `pending:${item.id}`;
		pendingById.set(id, item);
		const entry = {id, role:"user" as const, timestamp:new Date(item.createdAt).toISOString(), content:[]};
		const next = timeline.findIndex(message => Date.parse(message.timestamp ?? "") > item.createdAt);
		if (next < 0) timeline.push(entry); else timeline.splice(next, 0, entry);
	}
	const turns: AgentConversation["messages"][] = [];
	for (const message of timeline) {
		if (message.role === "system") continue;
		if (!turns.length || (message.role === "user" && !message.provenance)) turns.push([]);
		turns.at(-1)!.push(message);
	}
	return <>{turns.map((turn, index) => {
		const lastTool = turn.findLastIndex(message => message.role === "tool");
		const work = lastTool < 0 ? [] : turn.filter((message, i) => message.role === "tool" || (message.role === "assistant" && !message.provenance && (i < lastTool || message.stopReason === "toolUse")));
		const actions = work.filter(message => message.role === "tool").length;
		const pendingItem = pendingById.get(turn[0]!.id);
		const superseded = pendingItem?.status === "unconfirmed" && messages.some(message => message.role === "user" && !message.provenance && Date.parse(message.timestamp ?? "") > pendingItem.createdAt);
		return <section className="session-turn" aria-label={`Turno ${index + 1}`} key={turn[0]!.id}>
			{pendingItem ? <article className={`session-delivery session-delivery-${pendingItem.status}`} aria-label="Envío sin confirmar">
				{superseded ? <details className="session-delivery-superseded"><summary>Sin confirmar · {pendingItem.text.slice(0, 80) || "Archivos adjuntos"}</summary><p>{pendingItem.text || "Archivos adjuntos"}</p></details> : <p>{pendingItem.text || "Archivos adjuntos"}</p>}
				{!superseded ? <small>{pendingItem.status === "queued" && waiting ? "En cola: se enviará cuando respondas la pregunta" : DELIVERY_STATUS[pendingItem.status]}</small> : null}
				<div className="session-delivery-actions">
					<button type="button" disabled={retryDisabled || pendingItem.status !== "unconfirmed"} onClick={() => onRetry?.(pendingItem)}>Reintentar</button>
					<button type="button" disabled={pendingItem.status === "sending"} onClick={() => onDiscard?.(pendingItem)}>Descartar</button>
				</div>
			</article> : null}
			{turn.filter(message => message.role === "user" && !pendingById.has(message.id)).map(message => <TurnMessage key={message.id} message={message} />)}
			{work.length ? <details className="session-turn-work"><summary>Trabajó: {actions} {actions === 1 ? "acción" : "acciones"}</summary>
				{work.map(message => <div key={message.id} className="session-turn-action">
					{message.role === "tool" ? <span role="img" aria-label={message.isError ? "Error" : "Ejecutada"}>{message.isError ? "!" : "✓"}</span> : null}
					<AgentMessageContent message={message} />
				</div>)}
			</details> : null}
			{turn.filter(message => message.role === "assistant" && !work.includes(message)).map(message => <TurnMessage key={message.id} message={message} reply={!message.provenance} />)}
		</section>;
	})}</>;
}
function TurnMessage({ message, reply = false }: { message: AgentConversation["messages"][number]; reply?: boolean }) {
	return <article className={`agent-message agent-message-${message.role}${reply ? " session-turn-reply" : ""}${message.provenance ? " agent-message-delegated" : ""}`} data-message-id={message.id} aria-label={message.provenance ? messageSource(message) : message.role === "user" ? "Tu mensaje" : "Respuesta"}>
		{reply ? <header className="session-turn-reply-label">Respuesta{message.timestamp && Number.isFinite(Date.parse(message.timestamp)) ? <time dateTime={message.timestamp}>{new Date(message.timestamp).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}</time> : null}</header> : null}
		{message.provenance?.kind === "subagent" ? <details className="agent-subagent-reply"><summary className="agent-message-source">{messageSource(message)}</summary><AgentMessageContent message={message}/></details> : <>{message.provenance ? <div className="agent-message-source">{messageSource(message)}</div> : null}<AgentMessageContent message={message}/></>}
	</article>;
}

function AgentMessageContent({ message }: { message: AgentConversation["messages"][number] }) {
	return (
		<div className="agent-message-content">
			<SharedMarkdown>
				{message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n\n")}
			</SharedMarkdown>
		</div>
	);
}

function messageSource(message: AgentConversation["messages"][number]) {
	const kind = message.provenance?.kind === "subagent" ? "Subagente" : "Sesión";
	return `${kind}${message.provenance?.label ? ` · ${message.provenance.label}` : ""}`;
}

function SessionStatus({ session }: { session: AgentSession }) {
	const state = session.connected ? session.state : "offline";
	const label = session.connected ? STATES[session.state] : "Sin conexión";
	return (
		<span className={`agent-status-icon agent-status-${state}`} role="img" aria-label={label} title={label}>
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
				{state === "working" ? (
					<>
						<circle cx="12" cy="12" r="8" opacity=".2" />
						<path className="agent-status-spinner" d="M12 4a8 8 0 0 1 8 8" />
					</>
				) : state === "blocked" ? (
					<>
						<path d="m12 3 10 17H2L12 3Z" />
						<path d="M12 9v4m0 3v.01" />
					</>
				) : state === "done" ? (
					<>
						<circle cx="12" cy="12" r="9" />
						<path d="m8 12 3 3 5-6" />
					</>
				) : state === "idle" ? (
					<>
						<circle cx="12" cy="12" r="7" />
						<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
					</>
				) : state === "offline" ? (
					<path d="m3 3 18 18M9 9l-3 3a4 4 0 0 0 6 6l2-2m-4-9 2-2a4 4 0 0 1 6 6l-1 1" />
				) : (
					<>
						<circle cx="12" cy="12" r="8" />
						<path d="M10 9a2 2 0 0 1 4 0c0 2-2 2-2 4m0 3v.01" />
					</>
				)}
			</svg>
		</span>
	);
}
