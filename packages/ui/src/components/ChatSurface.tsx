import { useMobileDraft } from "../useMobileDraft.ts";
import type { ClientMessage } from "@gentle-dot/protocol";
import { type DragEvent, lazy, type ReactNode, Suspense, useEffect, useId, useRef, useState } from "react";
import type { CompanionClient } from "../companion.ts";
import { useCompanionResponse } from "../companion-activity.ts";
import { openUrl as openExternal } from "../desktop.ts";
import type { DesktopCompanionControls } from "../desktop-companion.ts";
import { mobileBridge } from "../mobile.ts";
import type { OrchestrationClient } from "../orchestration.ts";
import { activeTitle, type DotAction, type DotState, isBusy, needsAccount } from "../store.ts";
import type { Uploader } from "../uploads.ts";
import type { UsageClient } from "../usage.ts";
import { AgentVoiceContext } from "../useAgentVoice.ts";
import { useAttachments } from "../useAttachments.ts";
import { useChatAppearance } from "../useChatAppearance.ts";
import { useChatScroll } from "../useChatScroll.ts";
import { useChatWindow } from "../useChatWindow.ts";
import { type CompanionControls, useCompanion } from "../useCompanion.ts";
import { type RefreshHistory, useHistoryRefresh } from "../useHistoryRefresh.ts";
import { useOrchestration } from "../useOrchestration.ts";
import type { PanelWindowControls } from "../usePanelWindow.ts";
import { useRequestPresentation } from "../useRequestPresentation.ts";
import { useVoice, type VoiceControls } from "../useVoice.ts";
import type { WatchersClient } from "../watchers.ts";
import { AccountsPanel } from "./AccountsPanel.tsx";
import { AgentPermissionCard } from "./AgentPermissionCard.tsx";
import { AskCard } from "./AskCard.tsx";
import { BrowserCard } from "./BrowserCard.tsx";
import { CapriSprite, CompanionSettings } from "./CapriCompanion.tsx";
import { ChatAppearance } from "./ChatAppearance.tsx";
import { Composer } from "./Composer.tsx";
import { ComputerBanner, type ComputerControls } from "./Computer.tsx";
import { ConnectorDraftCard } from "./ConnectorDraftCard.tsx";
import { ConnectorsPanel } from "./ConnectorsPanel.tsx";
import { DesktopCompanionSettings } from "./DesktopCompanionSettings.tsx";
import { DesktopOptions } from "./DesktopOptions.tsx";
import { DotApprovalCards } from "./DotApprovalCards.tsx";
import { FloatingNotices, type NoticeSession } from "./FloatingNotices.tsx";
import { FollowedWorkPanel } from "./FollowedWorkPanel.tsx";
import {
	AccountsIcon,
	CollapseIcon,
	ConnectorsIcon,
	ConversationsIcon,
	ExpandIcon,
	EyeIcon,
	EyeOffIcon,
	MinusIcon,
	PlusIcon,
	ProfilesIcon,
	RoseGlyph,
	SettingsIcon,
	SpeakerIcon,
	SpeakerOffIcon,
	UsageIcon,
} from "./icons.tsx";
import { MessageList } from "./MessageList.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { describePinCommand, PinForm } from "./PinForm.tsx";
import { ProfilesPanel } from "./ProfilesPanel.tsx";
import { RemoteComputerCard } from "./RemoteComputerCard.tsx";
import { RequestPresentation, RequestPresentationSetting } from "./RequestPresentation.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { type AnswerAppApproval, newRequestId, type Send } from "./types.ts";
import { UsageBadgeSettings } from "./UsageBadgeSettings.tsx";
import { UsageBadges } from "./UsageBadges.tsx";
import "../orchestration.css";
import "../mobile-navigation.css";

const OrchestrationPanel = lazy(() =>
	import("./OrchestrationPanel.tsx").then((module) => ({ default: module.OrchestrationPanel })),
);
const UsagePanel = lazy(() => import("./UsagePanel.tsx").then((module) => ({ default: module.UsagePanel })));
const WatchersPanel = lazy(() =>
	import("./WatchersPanel.tsx").then((module) => ({ default: module.WatchersPanel })),
);
const WatchersSettings = lazy(() =>
	import("./WatchersPanel.tsx").then((module) => ({ default: module.WatchersSettings })),
);

interface ChatSurfaceProps {
	mobileDraftScope?: string;
	desktopCompanion?: DesktopCompanionControls;
	companionClient?: CompanionClient;
	companionControls?: CompanionControls;
	onCompanionActivity?: (activity: CompanionActivity) => void;
	variant: "web" | "panel";
	state: DotState;
	send: Send;
	refreshHistory?: RefreshHistory;
	/**
	 * Connector changes (S25.2), through the desktop app on behalf of this window. Only the desktop
	 * panel has it; elsewhere connector controls are disabled with the reason.
	 */
	appSend?: Send;
	/** Exact app approvals use the native private channel, with an acknowledgement. */
	answerAppApproval?: AnswerAppApproval;
	dismiss: (id: number) => void;
	onHide?: () => void;
	focusKey?: number;
	dispatch?: (action: DotAction) => void;
	openUrl?: (url: string) => void;
	/** Computer control, in the desktop panel only. */
	computer?: ComputerControls;
	/** The desktop panel offers the voice engine and its optional local model (S30.5). */
	voiceModel?: boolean;
	/** Hiding the rose and full screen (S26), in the desktop panel only; the web page already fills the browser. */
	panelWindow?: PanelWindowControls;
	/** Sends files to the daemon (S31); without it the composer has no attachments. */
	upload?: Uploader;
	/** The Settings screen (S33.1), in the desktop panel only: its options belong to the app. */
	settings?: boolean;
	/** Authenticated connection to the computer's Herdr sessions. */
	orchestration?: OrchestrationClient;
	usage?: UsageClient;
	watchers?: WatchersClient;
	/** Present only in the Android shell: one header and a tools sheet containing these device controls. */
	mobileControls?: ReactNode;
}

export interface CompanionActivity {
	sessions: boolean;
	working: boolean;
	needsYou: boolean;
	speaking: boolean;
	attentionLabel?: string;
}

const CONTINUE_TEXT = "Continue where you left off.";

type SwitchMessage = Extract<ClientMessage, { type: "new_conversation" | "open_conversation" }>;

function statusText(state: DotState, mobile = false): string | undefined {
	if (state.connection === "unauthorized") {
		if (mobile || mobileBridge())
			return "El acceso de este teléfono venció o fue revocado. Desvincúlalo y escanea un nuevo QR de vinculación desde tu equipo.";
		return "This access key is not valid anymore. Open the page again from the Gentle Dot menu (Open in browser).";
	}
	if (state.connection === "closed")
		return mobile ? "Reconectando con tu equipo…" : "Reconnecting to the assistant…";
	if (state.connection === "connecting") return mobile ? "Conectando…" : "Connecting…";
	if (state.agentState === "restarting")
		return mobile ? "Reiniciando el asistente…" : "The assistant is restarting…";
	if (state.agentState === "starting") return mobile ? "Iniciando el asistente…" : "Starting the assistant…";
	return undefined;
}

export function ChatSurface(props: ChatSurfaceProps) {
	return props.companionControls ? (
		<ChatSurfaceView {...props} companionControls={props.companionControls} />
	) : (
		<StandaloneChatSurface {...props} />
	);
}

/** Isolated previews retain their controls; the app owns its one shared companion instance. */
function StandaloneChatSurface(props: ChatSurfaceProps) {
	const controls = useCompanion(props.companionClient, props.state.connection === "open");
	return <ChatSurfaceView {...props} companionControls={controls} />;
}

function ChatSurfaceView({
	desktopCompanion,
	companionControls: companion,
	onCompanionActivity,
	settings,
	variant,
	state,
	send,
	refreshHistory,
	appSend,
	answerAppApproval,
	dismiss,
	onHide,
	focusKey,
	dispatch = () => {},
	openUrl = openExternal,
	computer,
	voiceModel,
	panelWindow,
	upload,
	orchestration,
	usage,
	watchers,
	mobileControls,
	mobileDraftScope,
}: ChatSurfaceProps & { companionControls: CompanionControls }) {
	// The Android shell supplies these controls. A narrow desktop window remains the desktop chat.
	const mobile = mobileControls !== undefined && mobileControls !== null;
	const appearance = useChatAppearance(mobile);
	const draftConversation = state.features.conversations ? state.conversationId : "continuous";
	const mobileDraft = useMobileDraft(mobile && mobileDraftScope && draftConversation
		? JSON.stringify([mobileDraftScope, draftConversation]) : undefined);
	const capri = companion.settings.mode === "capri";
	const capriPersona = companion.settings.persona === "capri";
	const [requestMode] = useRequestPresentation();
	const popupRequests = mobile && requestMode === "popup";
	const [showTools, setShowTools] = useState(false);
	const [showAppearance, setShowAppearance] = useState(false);
	const [showUsage, setShowUsage] = useState(false);
	const [usageFromChat, setUsageFromChat] = useState(false);
	const usageShortcut = useRef<HTMLButtonElement>(null);
	const closeUsage = () => {
		setShowUsage(false);
		if (usageFromChat) {
			setShowTools(false);
			requestAnimationFrame(() => usageShortcut.current?.focus({ preventScroll: true }));
		}
		setUsageFromChat(false);
	};
	const [showWatchers, setShowWatchers] = useState(false);
	const [showSettings, setShowSettings] = useState(false);
	/** A connector change waiting for the web PIN (S25.8). */
	const [pinPending, setPinPending] = useState<ClientMessage>();
	// On a server without the desktop app, connector changes go out with the web PIN instead.
	const pin = state.pin;
	const changeSend: Send | undefined = appSend ?? (pin ? setPinPending : undefined);
	const [showAgents, setShowAgents] = useState(false);
	const [visibleAgent, setVisibleAgent] = useState<NoticeSession>();
	const [requestedAgent, setRequestedAgent] = useState<NoticeSession & { key: number }>();
	const agents = useOrchestration(
		mobile ? orchestration : undefined,
		mobile && (popupRequests || showAgents) && !showTools,
	);
	useEffect(() => {
		if (!mobile) setShowAgents(false);
	}, [mobile]);
	const openAccounts = () => {
		setShowTools(mobile);
		setShowAgents(false);
		setShowSettings(false);
		send({ type: "auth_list" });
		dispatch({ type: "accounts", open: true });
	};
	const openProfiles = () => {
		setShowTools(mobile);
		setShowAgents(false);
		setShowSettings(false);
		send({ type: "profiles_list" });
		dispatch({ type: "profiles", open: true });
	};
	const openConnectors = () => {
		setShowTools(mobile);
		setShowAgents(false);
		setShowSettings(false);
		send({ type: "connectors_list" });
		dispatch({ type: "connectors", open: true });
	};
	/** Settings is a screen like the others: opening it closes them, except a sign-in waiting for an answer. */
	const openSettings = () => {
		setShowTools(false);
		setShowAgents(false);
		if (state.auth.open && !state.auth.flow?.prompt) dispatch({ type: "accounts", open: false });
		if (state.profiles.open) dispatch({ type: "profiles", open: false });
		if (state.connectors.open && !state.connectors.flow?.prompt)
			dispatch({ type: "connectors", open: false });
		setShowSettings(true);
	};
	const [showConversations, setShowConversations] = useState(false);
	const voice = useVoice(state, send);
	const attachments = useAttachments(upload);
	/** Files are being dragged over the chat. */
	const [dropping, setDropping] = useState(false);
	const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
	const dropHandlers = attachments
		? {
				onDragOver: (event: DragEvent<HTMLDivElement>) => {
					if (!carriesFiles(event)) return;
					event.preventDefault();
					setDropping(true);
				},
				onDragLeave: (event: DragEvent<HTMLDivElement>) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
				},
				onDrop: (event: DragEvent<HTMLDivElement>) => {
					if (!carriesFiles(event)) return;
					event.preventDefault();
					setDropping(false);
					attachments.add(Array.from(event.dataTransfer.files));
				},
			}
		: {};
	/** A switch that waits for the user to confirm stopping the running answer. */
	const [pendingSwitch, setPendingSwitch] = useState<SwitchMessage | undefined>(undefined);
	const switchTo = (message: SwitchMessage) => {
		setShowTools(false);
		setShowConversations(false);
		if (isBusy(state.agentState)) setPendingSwitch(message);
		else send(message);
	};
	/** Typing means the user is back to the chat; a sign-in waiting for an answer stays. */
	const closeOptions = () => {
		setShowTools(false);
		setShowAppearance(false);
		setShowUsage(false);
		setUsageFromChat(false);
		setShowWatchers(false);
		setShowAgents(false);
		setShowConversations(false);
		setShowSettings(false);
		if (state.auth.open && !state.auth.flow?.prompt) dispatch({ type: "accounts", open: false });
		if (state.profiles.open) dispatch({ type: "profiles", open: false });
		if (state.connectors.open && !state.connectors.flow?.prompt)
			dispatch({ type: "connectors", open: false });
	};
	const covered = state.auth.open || state.profiles.open || state.connectors.open;
	const settingsShown = showSettings && !covered;
	const agentsShown =
		mobile && Boolean(orchestration) && showAgents && !covered && !settingsShown && !showTools;
	const sessionsWorking =
		agentsShown && Boolean(agents.snapshot?.sessions.some((session) => session.state === "working"));
	const sessionsNeedYou = Boolean(agents.snapshot?.approvals.length);
	const pendingSession = agents.snapshot?.approvals.find(a => a.paneId !== visibleAgent?.paneId || a.sessionId !== visibleAgent?.sessionId) ?? agents.snapshot?.approvals[0];
	const pendingLabel = agents.snapshot?.sessions.find(s => s.paneId === pendingSession?.paneId && s.sessionId === pendingSession?.sessionId)?.label;
	useEffect(() => {
		onCompanionActivity?.({
			sessions: agentsShown,
			working: sessionsWorking,
			needsYou: sessionsNeedYou,
			speaking: voice.speaking,
			attentionLabel: pendingLabel ? `${pendingLabel} tiene una pregunta para ti` : undefined,
		});
	}, [onCompanionActivity, agentsShown, sessionsWorking, sessionsNeedYou, voice.speaking, pendingLabel]);
	useEffect(() => {
		const guide = () => {
			if (!pendingSession) return;
			setShowTools(false); setShowSettings(false); setShowAgents(true);
			setRequestedAgent({ paneId: pendingSession.paneId, sessionId: pendingSession.sessionId, key: Date.now() });
		};
		window.addEventListener("gentle-dot-companion-question", guide);
		return () => window.removeEventListener("gentle-dot-companion-question", guide);
	}, [pendingSession]);
	useEffect(() => {
		const open = () => {
			setShowTools(false); setShowSettings(false); setShowAgents(false);
			setShowUsage(false); setShowWatchers(false); setShowConversations(false);
			setRequestedAgent(undefined);
		};
		window.addEventListener("gentledot-open-chat", open);
		return () => window.removeEventListener("gentledot-open-chat", open);
	}, []);
	useEffect(() => {
		const open = (event: Event) => {
			const target = event instanceof CustomEvent ? event.detail : undefined;
			if (!target || typeof target.paneId !== "string" || !target.paneId.trim() ||
				target.paneId.length > 1024 || target.paneId.includes("\0") ||
				(target.sessionId !== undefined && (typeof target.sessionId !== "string" ||
					!target.sessionId.trim() || target.sessionId.length > 256 || target.sessionId.includes("\0")))) return;
			setShowTools(false); setShowSettings(false); setShowAgents(true);
			// The session panel resolves both IDs against a fresh snapshot. A recycled pane
			// or notification without a session identity never selects another conversation.
			setRequestedAgent({ paneId: target.paneId, sessionId: target.sessionId, key: Date.now() });
		};
		window.addEventListener("gentledot-open-session", open);
		return () => window.removeEventListener("gentledot-open-session", open);
	}, []);
	useEffect(
		() => () => onCompanionActivity?.({ sessions: false, working: false, needsYou: false, speaking: false }),
		[onCompanionActivity],
	);
	useEffect(() => {
		const open = () => {
			if (mobile) {
				setShowTools(true);
				setShowAppearance(false);
				setShowUsage(false);
				setShowWatchers(false);
			} else setShowSettings(true);
		};
		window.addEventListener("gentle-dot-companion-settings", open);
		return () => window.removeEventListener("gentle-dot-companion-settings", open);
	}, [mobile]);
	// One continuous chat unless the daemon turns the conversations list on.
	const conversations = state.features.conversations;
	const chatVisible =
		!covered && !settingsShown && !agentsShown && !(mobile && showTools) && !(!mobile && showUsage);
	useCompanionResponse(state.messages.findLast(message => message.role === "assistant")?.id, state.conversationId, chatVisible, ".message-assistant");
	// A late Dot dictation must not land after entering an agent session.
	useEffect(() => {
		if (agentsShown) voice.cancel();
	}, [agentsShown, voice.cancel]);
	const chatScroll = useChatScroll({
		conversationKey: conversations ? state.conversationId : undefined,
		active: chatVisible,
	});
	const historyWindow = useChatWindow({
		messages: state.messages,
		conversationKey: state.conversationId,
		following: !chatScroll.canJump,
		hasEarlier: state.hasEarlier,
		prepareForPage: chatScroll.prepareForPrepend,
		loadEarlier: (before) => send({ type: "get_earlier", before }),
	});
	useHistoryRefresh(
		state,
		chatVisible && !chatScroll.canJump && !historyWindow.hasNewer,
		refreshHistory,
		chatScroll.isAtLatest,
	);
	const jumpToLatest = () => {
		historyWindow.showLatest();
		chatScroll.jumpToLatest();
	};
	const status = statusText(state, mobile);
	const ready =
		state.connection === "open" && state.agentState !== "restarting" && state.agentState !== "starting";

	useEffect(() => {
		const onBack = (event: Event) => {
			if (event.defaultPrevented) return;
			if (state.auth.open && !state.auth.flow?.prompt) dispatch({ type: "accounts", open: false });
			else if (state.profiles.open) dispatch({ type: "profiles", open: false });
			else if (state.connectors.open && !state.connectors.flow?.prompt)
				dispatch({ type: "connectors", open: false });
			else if (showTools && showAppearance) setShowAppearance(false);
			else if (showTools && showUsage) {
				setShowUsage(false);
				if (usageFromChat) {
					setShowTools(false);
					requestAnimationFrame(() => usageShortcut.current?.focus({ preventScroll: true }));
				}
				setUsageFromChat(false);
			} else if (showTools && showWatchers) setShowWatchers(false);
			else if (showTools) setShowTools(false);
			else if (pendingSwitch) setPendingSwitch(undefined);
			else if (showConversations) setShowConversations(false);
			else if (agentsShown) setShowAgents(false);
			else if (settingsShown) setShowSettings(false);
			else return;
			event.preventDefault();
		};
		window.addEventListener("gentledot-back", onBack);
		return () => window.removeEventListener("gentledot-back", onBack);
	}, [
		showTools,
		showAppearance,
		showUsage,
		usageFromChat,
		showWatchers,
		pendingSwitch,
		showConversations,
		agentsShown,
		settingsShown,
		state.auth.open,
		state.auth.flow?.prompt,
		state.profiles.open,
		state.connectors.open,
		state.connectors.flow?.prompt,
		dispatch,
	]);

	const asks = state.asks.filter(
		(ask) =>
			!(ask.method === "app" && mobile && orchestration?.dotApprovals && orchestration.answerDotApproval),
	);
	const askCards = asks.map((ask) => (
		<fieldset key={ask.requestId} className="request-controls" disabled={!ready} aria-label={ask.title}>
			<AskCard
				ask={ask}
				send={(message) => (ready ? send(message) : false)}
				disabled={!ready}
				{...(!mobile && variant === "panel" && answerAppApproval ? { answerAppApproval } : {})}
				{...(pin ? { pin } : {})}
			/>
		</fieldset>
	));
	const popupIds = [
		...asks.map((ask) => `ask:${ask.requestId}`),
		...(agents.snapshot?.approvals ?? []).map(
			(approval) => `agent:${approval.paneId}:${approval.sessionId}:${approval.id}`,
		),
	];
	const popupCards = (
		<>
			{!ready || agents.error ? (
				<p role="status" className="muted">
					Sin conexión o estado sin verificar. Espera la actualización antes de responder.
				</p>
			) : null}
			{askCards}
			{agents.snapshot?.approvals.map((approval) => {
				const owner = agents.snapshot?.sessions.find(
					(session) => session.paneId === approval.paneId && session.sessionId === approval.sessionId,
				);
				return (
					<AgentPermissionCard
						key={`${approval.paneId}:${approval.sessionId}:${approval.id}`}
						approval={approval}
						controls={agents}
						disabled={!ready || !agents.snapshot?.available || Boolean(agents.error) || !owner?.connected}
						label={owner?.label}
					/>
				);
			})}
		</>
	);
	return (
		<div
			className={`chat chat-${variant}${mobile ? " chat-mobile" : ""}${panelWindow?.fullscreen ? " chat-fullscreen" : ""}${dropping ? " chat-dropping" : ""}`}
			data-state={state.agentState}
			data-companion={companion.settings.mode}
			data-ambience={companion.settings.ambience}
			{...(mobile
				? {
						style: capri
							? Object.fromEntries(
									Object.entries(appearance.style).filter(
										([key]) =>
											key.startsWith("--chat-font") ||
											key.startsWith("--chat-line") ||
											key.startsWith("--chat-message") ||
											key.startsWith("--chat-bubble") ||
											key === "--chat-gutter",
									),
								)
							: appearance.style,
						"data-chat-theme": appearance.resolvedTheme,
						"data-chat-density": appearance.settings.density,
						"data-chat-layout": appearance.settings.layout,
						"data-chat-background": appearance.settings.background,
					}
				: {})}
			{...dropHandlers}
		>
			{popupRequests ? (
				orchestration?.dotApprovals && orchestration.answerDotApproval ? (
					<DotApprovalCards client={orchestration} presentation connected={ready} extraIds={popupIds}>
						{popupCards}
					</DotApprovalCards>
				) : (
					<RequestPresentation ids={popupIds}>{popupCards}</RequestPresentation>
				)
			) : null}
			{mobile ? (
				<nav className="mobile-top-nav" aria-label="Navegación principal">
					<button
						type="button"
						aria-pressed={showTools || covered || settingsShown}
						onClick={() => {
							closeOptions();
							setShowAppearance(false);
							setShowUsage(false);
							setUsageFromChat(false);
							setShowWatchers(false);
							setShowTools(true);
						}}
					>
						<SettingsIcon />
						<span>Ajustes</span>
					</button>
					<button type="button" className="mobile-dot-tab" aria-pressed={chatVisible} onClick={closeOptions}>
						<>{capri ? <CapriSprite pose="face" className="capri-header-sprite" /> : <RoseGlyph />}</>
						<span>{capriPersona ? "Capri" : "Dot"}</span>
					</button>
					{orchestration ? (
						<button
							type="button"
							className="mobile-sessions-tab"
							aria-pressed={agentsShown}
							onClick={() => {
								closeOptions();
								setShowAgents(true);
							}}
						>
							<ConversationsIcon />
							<span>Sesiones</span>
							{agents.snapshot?.approvals.length ? (
								<span
									className="nav-attention"
									role="img"
									aria-label={`${agents.snapshot.approvals.length} permisos pendientes`}
								/>
							) : null}
						</button>
					) : null}
				</nav>
			) : null}
			{!mobile ? (
				<header className="chat-header" data-tauri-drag-region={variant === "panel" ? "" : undefined}>
					<span className={`state-dot state-${state.agentState}`} aria-hidden="true" />
					{conversations ? (
						<>
							<h1 className="gradient-text">{activeTitle(state)}</h1>
							<button
								type="button"
								className="icon"
								aria-label="Conversations"
								title="Conversations"
								aria-expanded={showConversations}
								onClick={() => {
									if (!showConversations) send({ type: "list_conversations" });
									setShowConversations(!showConversations);
								}}
							>
								<ConversationsIcon />
							</button>
						</>
					) : (
						<h1 className="assistant-name">
							<>{capri ? <CapriSprite pose="face" className="capri-header-sprite" /> : <RoseGlyph />}</>
							<span className="gradient-text">{capriPersona ? "Capri" : "Gentle Dot"}</span>
						</h1>
					)}
					<DesktopOptions>
						<button
							type="button"
							className="icon"
							aria-label="Accounts"
							title="Accounts"
							onClick={openAccounts}
						>
							<AccountsIcon />
							<span>Accounts</span>
						</button>
						<button
							type="button"
							className="icon"
							aria-label="Profiles"
							title="Profiles"
							onClick={openProfiles}
						>
							<ProfilesIcon />
							<span>Profiles</span>
						</button>
						<button
							type="button"
							className="icon"
							aria-label="Connectors"
							title="Connectors"
							onClick={openConnectors}
						>
							<ConnectorsIcon />
							<span>Connectors</span>
						</button>
						{voice.mic ? <MuteButton voice={voice} label /> : null}
						{conversations ? (
							<button
								type="button"
								className="icon"
								aria-label="New conversation"
								title="New conversation"
								disabled={!ready}
								onClick={() => switchTo({ type: "new_conversation" })}
							>
								<PlusIcon />
								<span>New conversation</span>
							</button>
						) : null}
						{settings ? (
							<button
								type="button"
								className="icon"
								aria-label="Settings"
								title="Settings"
								aria-expanded={settingsShown}
								onClick={() => (settingsShown ? setShowSettings(false) : openSettings())}
							>
								<SettingsIcon />
								<span>Settings</span>
							</button>
						) : null}
						{panelWindow && !desktopCompanion?.state.enabled ? (
							<RoseButton controls={panelWindow} label />
						) : null}
					</DesktopOptions>
					{panelWindow ? <FullscreenButton controls={panelWindow} /> : null}
					{onHide ? (
						<button type="button" className="icon" aria-label="Hide" title="Hide" onClick={onHide}>
							<MinusIcon />
						</button>
					) : null}
				</header>
			) : null}
			{mobile && showTools && !covered ? (
				<MobileTools
					title={
						showAppearance
							? "Apariencia del chat"
							: showUsage
								? "Consumo"
								: showWatchers
									? "Dot 24/7"
									: "Ajustes"
					}
					{...(showAppearance || showUsage || showWatchers
						? {
								backLabel: showUsage && usageFromChat ? "Volver a Dot" : "Volver a ajustes",
								back: () => {
									if (showUsage) {
										closeUsage();
										return;
									}
									setShowAppearance(false);
									setShowUsage(false);
									setShowWatchers(false);
								},
							}
						: {})}
				>
					{showAppearance ? (
						<ChatAppearance controls={appearance} />
					) : showUsage && usage ? (
						<Suspense fallback={<p role="status">Abriendo consumo…</p>}>
							<UsagePanel client={usage} />
						</Suspense>
					) : showWatchers && watchers ? (
						<Suspense fallback={<p role="status">Abriendo Dot 24/7…</p>}>
							<WatchersPanel client={watchers} connected={state.connection === "open"} />
						</Suspense>
					) : (
						<>
							<CompanionSettings controls={companion} />
							<div className="mobile-tool-list mobile-quick-tools">
								{usage ? (
									<button
										type="button"
										className="mobile-usage-link"
										aria-label="Consumo"
										onClick={() => {
											setUsageFromChat(false);
											setShowUsage(true);
										}}
									>
										<UsageIcon />
										<span>
											<strong>Consumo</strong>
											<small>Disponible y próximos reinicios</small>
										</span>
										<span className="mobile-menu-arrow" aria-hidden="true">
											›
										</span>
									</button>
								) : null}
								{watchers ? (
									<button
										type="button"
										className="mobile-usage-link"
										aria-label="Dot 24/7"
										onClick={() => setShowWatchers(true)}
									>
										<svg
											width="18"
											height="18"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="1.8"
											strokeLinecap="round"
											strokeLinejoin="round"
											aria-hidden="true"
										>
											<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
										</svg>
										<span>
											<strong>Dot 24/7</strong>
											<small>Qué revisa y hace por ti</small>
										</span>
										<span className="mobile-menu-arrow" aria-hidden="true">
											›
										</span>
									</button>
								) : null}
							</div>
							<details className="mobile-device-settings">
								<summary>
									<span>
										<strong>Avisos y teléfono</strong>
										<small>Resúmenes, conexión y acceso</small>
									</span>
									<span className="mobile-menu-arrow" aria-hidden="true">
										›
									</span>
								</summary>
								{mobileControls}
							</details>
							<section className="mobile-menu-model" aria-label="Modelo de IA">
								<h3>Modelo</h3>
								<ModelPicker
									models={state.models}
									send={send}
									dispatch={dispatch}
									disabled={!ready}
									{...(state.model ? { model: state.model } : {})}
								/>
							</section>
							{usage ? <UsageBadgeSettings /> : null}
							<RequestPresentationSetting />
							<div className="mobile-tool-list">
								<button type="button" onClick={() => setShowAppearance(true)}>
									<svg
										width="18"
										height="18"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="1.8"
										strokeLinecap="round"
										strokeLinejoin="round"
										aria-hidden="true"
									>
										<circle cx="12" cy="12" r="9" />
										<path d="M12 3v18a9 9 0 0 0 0-18Z" fill="currentColor" stroke="none" />
									</svg>
									<span>Apariencia del chat</span>
								</button>
								<button type="button" onClick={openAccounts}>
									<AccountsIcon />
									<span>Cuentas de IA</span>
								</button>

								<button type="button" onClick={openProfiles}>
									<ProfilesIcon />
									<span>Perfiles</span>
								</button>
								<button type="button" onClick={openConnectors}>
									<ConnectorsIcon />
									<span>
										Conexiones
										{state.connectors.issue ? (
											<small className="mobile-menu-hint">Revisar acceso</small>
										) : null}
									</span>
								</button>
								{voice.mic ? (
									<button
										type="button"
										aria-pressed={!voice.muted}
										onClick={() => voice.setMuted(!voice.muted)}
									>
										{voice.muted ? <SpeakerOffIcon /> : <SpeakerIcon />}
										<span>Respuestas en voz alta</span>
										<small>{voice.muted ? "Desactivadas" : "Activadas"}</small>
									</button>
								) : null}
								{conversations ? (
									<>
										<button
											type="button"
											onClick={() => {
												setShowTools(false);
												send({ type: "list_conversations" });
												setShowConversations(true);
											}}
										>
											<ConversationsIcon />
											<span>Conversaciones</span>
										</button>
										<button
											type="button"
											disabled={!ready}
											onClick={() => switchTo({ type: "new_conversation" })}
										>
											<PlusIcon />
											<span>Nueva conversación</span>
										</button>
									</>
								) : null}
								{settings ? (
									<button type="button" onClick={openSettings}>
										<SettingsIcon />
										<span>Ajustes del asistente</span>
									</button>
								) : null}
							</div>

							{orchestration ? (
								<SettingsDisclosure title="Trabajo en segundo plano">
									<FollowedWorkPanel
										client={orchestration}
										connected={agents.snapshot?.available === true && !agents.error}
									/>
								</SettingsDisclosure>
							) : null}
							{orchestration?.browserStatus && orchestration.browserAction ? (
								<SettingsDisclosure title="Aplicaciones y navegador">
									{orchestration.computerStatus ? <RemoteComputerCard client={orchestration} /> : null}
									<BrowserCard client={orchestration} />
								</SettingsDisclosure>
							) : null}
						</>
					)}
				</MobileTools>
			) : null}
			{computer?.session ? (
				<ComputerBanner session={computer.session} yolo={computer.yolo !== undefined} stop={computer.stop} />
			) : null}

			{conversations && showConversations ? (
				<nav className="conversations" aria-label="Earlier conversations">
					<p className="eyebrow">Conversations</p>
					{state.conversations.length === 0 ? <p className="muted">No conversations yet.</p> : null}
					{state.conversations.map((conversation) => (
						<button
							key={conversation.id}
							type="button"
							className={conversation.id === state.conversationId ? "active" : ""}
							onClick={() => {
								if (conversation.id === state.conversationId) setShowConversations(false);
								else switchTo({ type: "open_conversation", conversationId: conversation.id });
							}}
						>
							<span>{conversation.title}</span>
							<time dateTime={conversation.updatedAt}>
								{new Date(conversation.updatedAt).toLocaleString()}
							</time>
						</button>
					))}
				</nav>
			) : null}

			{status ? (
				<div className="status" role="status">
					{status}
				</div>
			) : null}

			{state.auth.open ? (
				<main className="chat-body">
					<AccountsPanel
						auth={state.auth}
						send={send}
						dispatch={dispatch}
						openUrl={openUrl}
						mobile={mobile}
					/>
				</main>
			) : null}

			{state.profiles.open && !state.auth.open ? (
				<main className="chat-body">
					<ProfilesPanel
						mobile={mobile}
						profiles={state.profiles}
						send={send}
						dispatch={dispatch}
						{...(state.auth.providers ? { providers: state.auth.providers } : {})}
					/>
				</main>
			) : null}

			{state.connectors.open && !state.auth.open && !state.profiles.open ? (
				<main className="chat-body">
					<ConnectorsPanel
						mobile={mobile}
						connectors={state.connectors}
						send={send}
						{...(changeSend ? { appSend: changeSend } : {})}
						dispatch={dispatch}
						openUrl={openUrl}
						{...(computer?.available ? { computer } : {})}
						{...(voiceModel ? { voiceModel } : {})}
					/>
				</main>
			) : null}

			{settingsShown ? (
				<main className="chat-body">
					<SettingsPanel close={() => setShowSettings(false)}>
						{desktopCompanion ? <DesktopCompanionSettings controls={desktopCompanion} /> : null}
						<CompanionSettings controls={companion} desktop={Boolean(desktopCompanion)} />
						{usage ? <UsageBadgeSettings /> : null}
						{watchers ? (
							<Suspense fallback={null}>
								<WatchersSettings client={watchers} connected={state.connection === "open"} />
							</Suspense>
						) : null}
					</SettingsPanel>
				</main>
			) : null}

			{!mobile && showUsage && usage ? (
				<main className="chat-usage-details">
					<button type="button" onClick={closeUsage}>
						Volver a Dot
					</button>
					<UsageBadgeSettings />
					<Suspense fallback={<p role="status">Abriendo consumo…</p>}>
						<UsagePanel client={usage} />
					</Suspense>
				</main>
			) : null}
			{mobile && orchestration ? (
				<main className="chat-body sessions-screen" hidden={!agentsShown}>
					<Suspense fallback={<p role="status">Abriendo agentes…</p>}>
						<AgentVoiceContext value={{ state, send }}>
							<OrchestrationPanel
								mobile={mobile}
								controls={agents}
								client={orchestration}
								active={agentsShown}
								requestsVisible={!popupRequests}
								onVisibleSession={setVisibleAgent}
								requestedSession={requestedAgent}
							/>
						</AgentVoiceContext>
					</Suspense>
				</main>
			) : null}

			<main className="chat-body chat-transcript" ref={chatScroll.viewportRef} hidden={!chatVisible}>
				<div className="chat-transcript-content" ref={chatScroll.contentRef}>
					{/* In the chat's own flow, so messages start below it instead of sliding under it. */}
					{needsAccount(state) ? (
						<div className="onboarding">
							<p>To start, connect the AI service you use (a subscription or an API key).</p>
							<button type="button" className="primary" onClick={openAccounts}>
								Connect an AI account
							</button>
						</div>
					) : null}
					<MessageList
						working={
							!historyWindow.hasNewer &&
							state.connection === "open" &&
							(state.agentState === "thinking" || state.agentState === "working")
						}
						mobile={mobile}
						messages={historyWindow.messages}
						queued={historyWindow.hasNewer ? [] : [...state.queue.steering, ...state.queue.followUp]}
						hasEarlier={historyWindow.hasEarlier}
						loadingEarlier={historyWindow.loadingEarlier}
						onShowEarlier={historyWindow.showEarlier}
						hasNewer={historyWindow.hasNewer}
						onShowNewer={historyWindow.showNewer}
					/>
					{state.interrupted ? (
						<div className="interrupted">
							<p>I was interrupted. Continue?</p>
							<button
								type="button"
								className="primary"
								disabled={!ready}
								onClick={() => send({ type: "send", text: CONTINUE_TEXT, requestId: newRequestId() })}
							>
								Continue
							</button>
						</div>
					) : null}
					{!popupRequests && chatVisible ? askCards : null}
					{mobile &&
					!popupRequests &&
					chatVisible &&
					orchestration?.dotApprovals &&
					orchestration.answerDotApproval ? (
						<DotApprovalCards client={orchestration} connected={ready} />
					) : null}
					{(state.connectors.drafts ?? []).map((draft) => (
						<ConnectorDraftCard
							key={draft.draftId}
							draft={draft}
							send={send}
							{...(changeSend ? { appSend: changeSend } : {})}
							// Its secrets are asked in the Connectors screen.
							approved={() => dispatch({ type: "connector_started", connectorId: draft.name })}
						/>
					))}
				</div>
			</main>
			{chatVisible && (chatScroll.canJump || historyWindow.hasNewer) ? (
				<div className="chat-scroll-controls">
					<button type="button" className="chat-scroll-latest" onClick={jumpToLatest}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
							<path d="M12 4v15m-6-6 6 6 6-6" />
						</svg>
						{mobile ? "Volver al final" : "Jump to latest"}
					</button>
				</div>
			) : null}

			{pinPending && pin ? (
				<div
					className="switch-confirm pin-dialog"
					role="dialog"
					aria-label={pin.set ? "Enter your PIN" : "Create a PIN"}
				>
					<p>{describePinCommand(pinPending, state.connectors.list)}</p>
					<PinForm
						pin={pin}
						action="Continue"
						onPin={(value, created) => {
							if (created) send({ type: "pin_set", pin: value });
							send({ type: "pin_command", pin: value, command: pinPending });
							setPinPending(undefined);
						}}
					>
						<button
							type="button"
							onClick={() => {
								setPinPending(undefined);
								// Nothing was sent: a sign-in that was starting stops, as when the app declines.
								dispatch({
									type: "server",
									message: { type: "error", code: "declined", message: "Nothing was changed.", seq: 0 },
								});
							}}
						>
							Cancel
						</button>
					</PinForm>
				</div>
			) : null}

			{pendingSwitch ? (
				<div className="switch-confirm" role="alertdialog" aria-label="Stop and switch?">
					<p>The assistant is still answering. Stop it and open the other conversation?</p>
					<div className="switch-actions">
						<button
							type="button"
							className="primary"
							onClick={() => {
								send(pendingSwitch);
								setPendingSwitch(undefined);
							}}
						>
							Stop and switch
						</button>
						<button type="button" onClick={() => setPendingSwitch(undefined)}>
							Cancel
						</button>
					</div>
				</div>
			) : null}

			<FloatingNotices
				notices={state.notices}
				dismiss={dismiss}
				mobile={mobile}
				chatVisible={chatVisible}
				visibleSession={agentsShown ? visibleAgent : undefined}
				onOpenSession={
					mobile && orchestration
						? (session) => {
								closeOptions();
								setShowAgents(true);
								setRequestedAgent((previous) => ({ ...session, key: (previous?.key ?? 0) + 1 }));
							}
						: undefined
				}
			/>

			<div
				className="chat-composer"
				hidden={agentsShown || (mobile && (covered || settingsShown || showTools))}
			>
				{!mobile ? (
					<ModelPicker
						models={state.models}
						send={send}
						dispatch={dispatch}
						disabled={!ready}
						{...(state.model ? { model: state.model } : {})}
					/>
				) : null}
				{usage ? (
					<div className={mobile ? "mobile-chat-utilities chat-usage-utilities" : "chat-usage-utilities"}>
						<UsageBadges client={usage} />
						<button
							type="button"
							className="mobile-usage-shortcut"
							aria-label="Ver consumo"
							title="Ver consumo"
							ref={usageShortcut}
							onClick={() => {
								closeOptions();
								setShowAppearance(false);
								setShowWatchers(false);
								setUsageFromChat(true);
								setShowUsage(true);
								setShowTools(mobile);
							}}
						>
							<UsageIcon />
						</button>
					</div>
				) : null}
				{mobileDraft?.note ? <p className="voice-status" role="status">{mobileDraft.note}</p> : null}
				<Composer
					{...(mobileDraft ? { text: mobileDraft.text, onText: mobileDraft.onText,
						temporaryAttachmentsNote: "Archivos temporales: vuelve a adjuntarlos si Android cierra la app." } : {})}
					busy={isBusy(state.agentState)}
					disabled={!ready}
					send={(message) => {
						if (message.type === "send") jumpToLatest();
						return send(message);
					}}
					focusKey={mobile ? undefined : focusKey}
					onStartTyping={closeOptions}
					voice={voice}
					mobile={mobile}
					{...(attachments ? { attachments } : {})}
				/>
			</div>
		</div>
	);
}

/** Settings is a screen: navigation stays available and the conversation retains its draft. */
function MobileTools({
	children,
	title = "Ajustes",
	back,
	backLabel = "Volver a ajustes",
}: {
	children: ReactNode;
	title?: string;
	back?: () => void;
	backLabel?: string;
}) {
	const heading = useRef<HTMLHeadingElement>(null);
	const id = useId();
	useEffect(() => {
		if (title) heading.current?.focus();
	}, [title]);
	return (
		<main className="chat-body mobile-settings-screen" aria-labelledby={id}>
			<div className="mobile-settings-heading">
				{back ? (
					<button type="button" aria-label={backLabel} onClick={back}>
						<svg
							viewBox="0 0 24 24"
							width="22"
							height="22"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.8"
							aria-hidden="true"
						>
							<path d="m14 6-6 6 6 6" />
						</svg>
					</button>
				) : null}
				<h2 id={id} ref={heading} tabIndex={-1}>
					{title}
				</h2>
			</div>
			{children}
		</main>
	);
}
function SettingsDisclosure({ title, children }: { title: string; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<details className="mobile-device-settings" onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>{title}</summary>
			{open ? children : null}
		</details>
	);
}

/** Spoken replies on or off (S30.3); the choice is remembered. */
function MuteButton({ voice, label: showLabel }: { voice: VoiceControls; label?: boolean }) {
	const label = voice.muted ? "Unmute spoken replies" : "Mute spoken replies";
	return (
		<button
			type="button"
			className="icon"
			aria-label={label}
			title={label}
			aria-pressed={voice.muted}
			onClick={() => voice.setMuted(!voice.muted)}
		>
			{voice.muted ? <SpeakerOffIcon /> : <SpeakerIcon />}
			{showLabel ? <span>{label}</span> : null}
		</button>
	);
}

function RoseButton({ controls, label: showLabel }: { controls: PanelWindowControls; label?: boolean }) {
	const label = controls.roseHidden ? "Show the rose" : "Hide the rose";
	return (
		<button
			type="button"
			className="icon"
			aria-label={label}
			title={label}
			onClick={() => controls.setRoseHidden(!controls.roseHidden)}
		>
			{controls.roseHidden ? <EyeIcon /> : <EyeOffIcon />}
			{showLabel ? <span>{label}</span> : null}
		</button>
	);
}

function FullscreenButton({ controls }: { controls: PanelWindowControls }) {
	const label = controls.fullscreen ? "Exit full screen" : "Full screen";
	return (
		<button
			type="button"
			className="icon"
			aria-label={label}
			title={`${label} (⌘⇧F)`}
			aria-pressed={controls.fullscreen}
			onClick={() => controls.setFullscreen(!controls.fullscreen)}
		>
			{controls.fullscreen ? <CollapseIcon /> : <ExpandIcon />}
		</button>
	);
}
