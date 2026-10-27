import type { ClientMessage } from "@gentle-dot/protocol";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ConnectionInfo, tokenFromLocation } from "./client.ts";
import { createCompanionClient } from "./companion.ts";
import { focusCompanionSession, useDesktopSessionContext } from "./companion-sessions.ts";
import { CapriCompanion } from "./components/CapriCompanion.tsx";
import { currentAgentAction } from "./agent-activity.ts";
import { ChatSurface, type CompanionActivity } from "./components/ChatSurface.tsx";
import type { ComputerControls } from "./components/Computer.tsx";
import { CapriIntro } from "./capri2d/CapriIntro.tsx";
import { DesktopCompanionBubble } from "./components/DesktopCompanionBubble.tsx";
import { DesktopCompanionLauncher } from "./components/DesktopCompanionSurface.tsx";
import { DotSurface } from "./components/DotSurface.tsx";
import { GlowSurface } from "./components/GlowSurface.tsx";
import { SharedFileContext } from "./components/SharedMarkdown.tsx";
import type { AnswerAppApproval } from "./components/types.ts";
import {
	computerCapabilities,
	computerPermissions,
	requestComputerPermission,
	setComputerYolo,
	stopComputer,
} from "./computer.ts";
import {
	connectionInfo,
	connectorCommand,
	hidePanel,
	inDesktop,
	onDesktopEvent,
	panelVisible,
	setDotState,
	startDragging,
	togglePanel,
} from "./desktop.ts";
import { createOrchestrationClient } from "./orchestration.ts";
import { createSharedFileClient } from "./shared-files.ts";
import { createUploader } from "./uploads.ts";
import { createUsageClient } from "./usage.ts";
import { useCompanion } from "./useCompanion.ts";
import { useCompanionLayer } from "./useCompanionLayer.ts";
import { useComputerAvailable, useComputerState } from "./useComputer.ts";
import { useDesktopCompanion } from "./useDesktopCompanion.ts";
import { useDot } from "./useDot.ts";
import { usePanelWindow } from "./usePanelWindow.ts";
import { createWatchersClient } from "./watchers.ts";

type Surface = "dot" | "panel" | "web";

function currentSurface(): Surface | "glow" | "companion-launcher" | "companion-bubble" | "capri-intro" {
	const surface = new URLSearchParams(window.location.search).get("surface");
	return surface === "capri-intro" || surface === "dot" ||
		surface === "panel" ||
		surface === "glow" ||
		surface === "companion-launcher" ||
		surface === "companion-bubble"
		? surface
		: "web";
}

/**
 * Whether the window behind the panel blurs the desktop (macOS vibrancy). The shell adds
 * `effects=none` to the panel URL where it cannot (Linux), and the panel paints its own background.
 */
export function windowEffects(search: string): "native" | "none" {
	return new URLSearchParams(search).get("effects") === "none" ? "none" : "native";
}

function browserConnection(): ConnectionInfo | undefined {
	const token = tokenFromLocation(window.location, window.sessionStorage, (url) =>
		window.history.replaceState(null, "", url),
	);
	if (!token) return undefined;
	const daemon = import.meta.env.VITE_DAEMON_ORIGIN as string | undefined;
	const base = daemon ? new URL(daemon) : window.location;
	const protocol = base.protocol === "https:" ? "wss:" : "ws:";
	return { url: `${protocol}//${base.host}/ws`, token };
}

/** ⌘⇧F (Ctrl+Shift+F off macOS) toggles the panel's full screen. */
function isFullscreenShortcut(event: KeyboardEvent): boolean {
	return (
		(event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "f"
	);
}

/** The desktop's glow overlay (S28) is its own surface: it never connects to the assistant. */
export interface AppProps {
	connection?: ConnectionInfo;
	/** Device controls rendered inside the mobile tools sheet; enables the compact mobile layout. */
	mobileControls?: ReactNode;
	/** Non-secret endpoint + pairing identity supplied by the native shell. */
	mobileDraftScope?: string;
	/** Collapse the Android companion conversation back to its character. */
	onCollapseMobile?: () => void;
}

export function App({ connection, mobileControls, mobileDraftScope, onCollapseMobile }: AppProps = {}) {
	const surface = currentSurface();
	return surface === "capri-intro" ? <CapriIntro /> : surface === "companion-launcher" ? (
		<CompanionLauncher />
	) : surface === "companion-bubble" ? (
		<CompanionBubble />
	) : surface === "glow" ? (
		<GlowSurface />
	) : surface === "panel" && inDesktop() ? (
		<DesktopPanel
			connection={connection}
			mobileControls={mobileControls}
			mobileDraftScope={mobileDraftScope}
			onCollapseMobile={onCollapseMobile}
		/>
	) : (
		<Assistant
			surface={surface}
			connection={connection}
			mobileControls={mobileControls}
			mobileDraftScope={mobileDraftScope}
			onCollapseMobile={onCollapseMobile}
		/>
	);
}

/** Keep native window ownership eager, but start the panel's assistant only on first use. */
function DesktopPanel(props: AppProps) {
	const [activated, setActivated] = useState(false);
	useEffect(() => {
		document.documentElement.dataset.surface = "panel";
		document.documentElement.dataset.effects = windowEffects(window.location.search);
		let live = true;
		const activate = () => {
			if (live) setActivated(true);
		};
		// Subscribe before the snapshot: first load may already be visible. Only ever set true,
		// so a delayed hidden snapshot cannot undo a show event or discard a live session.
		const listening = onDesktopEvent("dot://panel-shown", activate);
		void listening
			.then(async () => {
				if (live && (await panelVisible())) activate();
			})
			.catch(() => {
				// If the host bridge fails, keep the panel usable rather than blank forever.
				activate();
			});
		return () => {
			live = false;
			void listening.then((stop) => stop(), () => {});
		};
	}, []);
	// The native readiness probe requires a mounted root child, not a connected assistant.
	return activated ? <Assistant {...props} surface="panel" /> : <div data-panel-dormant="true" />;
}

function CompanionBubble() {
	const controls = useDesktopCompanion(inDesktop());
	useEffect(() => {
		document.documentElement.dataset.surface = "companion-bubble";
	}, []);
	return <DesktopCompanionBubble controls={controls} />;
}

/** The fixed desktop entry point has no assistant connection or chat history. */
function CompanionLauncher() {
	useEffect(() => {
		document.documentElement.dataset.surface = "companion-launcher";
	}, []);
	return <DesktopCompanionLauncher toggle={togglePanel} />;
}

function Assistant({
	surface,
	connection,
	mobileControls,
	mobileDraftScope,
	onCollapseMobile,
}: AppProps & { surface: Surface }) {
	const [info, setInfo] = useState<ConnectionInfo | undefined>(undefined);
	const [missingToken, setMissingToken] = useState(false);
	/** Why the desktop app could not reach its assistant, in the app's own words (S35.2). */
	const [unreachable, setUnreachable] = useState<string>();
	const [focusKey, setFocusKey] = useState(0);
	const { state, send, dismiss, dispatch, refreshHistory } = useDot(info);
	// Files go to the daemon over HTTP, with the same access key as the WebSocket (S31.2).
	const sharedFiles = useMemo(() => (info ? createSharedFileClient(info) : undefined), [info]);
	const upload = useMemo(() => (info ? createUploader(info) : undefined), [info]);
	const companion = useMemo(() => (info ? createCompanionClient(info) : undefined), [info]);
	const companionControls = useCompanion(companion, state.connection === "open");
	const [companionActivity, setCompanionActivity] = useState<CompanionActivity>({
		sessions: false,
		working: false,
		needsYou: false,
		speaking: false,
	});
	const usage = useMemo(() => (info ? createUsageClient(info) : undefined), [info]);
	const watchers = useMemo(() => (info ? createWatchersClient(info) : undefined), [info]);
	const orchestration = useMemo(
		() => (info && surface !== "dot" ? createOrchestrationClient(info) : undefined),
		[info, surface],
	);
	const conversations = useRef(state.features.conversations);
	conversations.current = state.features.conversations;
	// Computer control lives in the desktop app only (S24.7); the panel registers the helper.
	const desktop = inDesktop();
	const desktopCompanion = useDesktopCompanion(desktop && surface !== "web");
	useDesktopSessionContext(
		info,
		desktopCompanion,
		desktop && surface === "dot" && desktopCompanion.state.enabled,
	);
	useEffect(() => {
		if (!desktop || surface !== "dot" || !info) return;
		let live = true,
			stop: (() => void) | undefined;
		void import("@tauri-apps/api/event").then(async ({ listen }) => {
			const unlisten = await listen<{ kind: string; paneId?: string; sessionId?: string }>(
				"dot://capri-open-context",
				(event) => {
					const { kind, paneId, sessionId } = event.payload;
					if (kind === "question" && paneId && sessionId)
						void focusCompanionSession(info, { paneId, sessionId }).then(
							() =>
								desktopCompanion.context?.({
									id: `focused:${paneId}:${Date.now()}`,
									kind: "notification",
									summary: "Sesión seleccionada en Herdr",
									body: "Abre su ventana para responder.",
								}),
							() =>
								desktopCompanion.context?.({
									id: `focus-failed:${Date.now()}`,
									kind: "notification",
									summary: "Esa sesión ya no está disponible",
									body: "Actualiza las sesiones para verla.",
								}),
						);
				},
			);
			if (live) stop = unlisten;
			else unlisten();
		});
		return () => {
			live = false;
			stop?.();
		};
	}, [desktop, surface, info, desktopCompanion.context]);
	useEffect(() => {
		if (!desktop || surface !== "panel") return;
		const unsubscribe = onDesktopEvent("dot://capri-settings", () => {
			window.dispatchEvent(new Event("gentle-dot-companion-settings"));
		});
		return () => {
			void unsubscribe.then((stop) => stop());
		};
	}, [desktop, surface]);
	const companionVisible =
		surface !== "dot" &&
		companionControls.settings.mode === "capri" &&
		companionControls.settings.visible &&
		!desktop;
	const companionHost = useCompanionLayer(companionVisible);
	const companionOverlay = companionVisible ? (
		<CapriCompanion
			portalHost={companionHost}
			controls={companionControls}
			state={companionActivity.working ? "working" : state.agentState}
			actionKind={companionActivity.working ? "other" : currentAgentAction(state.agentState, state.messages)}
			connected={state.connection === "open"}
			sessions={companionActivity.sessions}
			needsYou={state.asks.length > 0 || companionActivity.needsYou}
			attentionLabel={companionActivity.attentionLabel}
			onAttention={
				companionActivity.needsYou
					? () => window.dispatchEvent(new Event("gentle-dot-companion-question"))
					: undefined
			}
			speaking={companionActivity.speaking}
			onSettings={() => window.dispatchEvent(new Event("gentle-dot-companion-settings"))}
		/>
	) : null;
	const { session: computerSession, yolo } = useComputerState(desktop && surface !== "web");
	const computerAvailable = useComputerAvailable(desktop && surface === "panel", state.connection === "open");
	// Connector changes go through the app, on behalf of this window (S25.2); the web page has none.
	const clientId = state.clientId;
	const approvalState = useRef(state);
	approvalState.current = state;
	const answerAppApproval = useCallback<AnswerAppApproval>(
		async (requestId, approved) => {
			const current = approvalState.current;
			if (!desktop || surface !== "panel" || current.connection !== "open" || !current.clientId)
				throw new Error("No hay conexión segura con Gentle Dot. Espera a que vuelva a conectarse.");
			const ask = current.asks.find((entry) => entry.requestId === requestId && entry.method === "app");
			if (!ask) throw new Error("Esta solicitud ya no está pendiente.");
			await connectorCommand(current.clientId, { type: "app_approval_reply", requestId, approved });
		},
		[desktop, surface],
	);
	const appSend = useCallback(
		(message: ClientMessage) => {
			if (!clientId) return;
			connectorCommand(clientId, message).catch((error: unknown) =>
				dispatch({ type: "notice", level: "error", message: String(error) }),
			);
		},
		[clientId, dispatch],
	);
	// The panel's own window (S26): hide the rose, full screen.
	const panel = usePanelWindow(desktop && surface === "panel");
	const fullscreenNow = panel.fullscreenNow;
	const setFullscreen = panel.controls.setFullscreen;
	const computer: ComputerControls | undefined =
		desktop && surface === "panel"
			? {
					available: computerAvailable,
					...(computerSession ? { session: computerSession } : {}),
					...(yolo ? { yolo } : {}),
					stop: stopComputer,
					setYolo: setComputerYolo,
					permissions: computerPermissions,
					capabilities: computerCapabilities,
					requestPermission: requestComputerPermission,
				}
			: undefined;

	useEffect(() => {
		if (connection) {
			setInfo(connection);
			setMissingToken(false);
			return;
		}
		if (inDesktop()) {
			let live = true;
			const connect = () =>
				connectionInfo().then(
					(next) => {
						if (!live) return;
						// The same assistant keeps its connection; only a new one replaces it.
						setInfo((current) =>
							current?.url === next.url && current.token === next.token ? current : next,
						);
						setUnreachable(undefined);
						setMissingToken(false);
					},
					(error: unknown) => {
						if (!live) return;
						const reason = typeof error === "string" ? error : error instanceof Error ? error.message : "";
						if (reason) setUnreachable(reason);
						else setMissingToken(true);
					},
				);
			// A refused or timed-out window recovers without a reopen: the app reports its assistant
			// ready after Restart assistant, or after a start slower than `connection_info` waits (S35.2).
			const ready = onDesktopEvent("dot://assistant-ready", () => void connect());
			void connect();
			return () => {
				live = false;
				void ready.then((unlisten) => unlisten());
			};
		}
		const found = browserConnection();
		if (found) setInfo(found);
		else setMissingToken(true);
	}, [connection]);

	useEffect(() => {
		if (surface === "dot") setDotState(state.agentState);
	}, [surface, state.agentState]);

	useEffect(() => {
		if (surface !== "panel") return;
		const subscriptions = [
			// The menu bar item starts a new chat only when the conversations list is on.
			onDesktopEvent("dot://new-conversation", () => {
				if (conversations.current) send({ type: "new_conversation" });
			}),
			onDesktopEvent("dot://panel-shown", () => setFocusKey((k) => k + 1)),
		];
		// Esc, in order: whatever inside the panel already handled it (it called preventDefault),
		// then leaving full screen, then hiding the panel.
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			if (event.key === "Escape") {
				if (fullscreenNow.current) setFullscreen(false);
				else hidePanel();
				return;
			}
			if (isFullscreenShortcut(event)) {
				event.preventDefault();
				setFullscreen(!fullscreenNow.current);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			for (const s of subscriptions) void s.then((unlisten) => unlisten());
		};
	}, [surface, send, fullscreenNow, setFullscreen]);

	useEffect(() => {
		document.documentElement.dataset.surface = surface;
		document.documentElement.dataset.effects = windowEffects(window.location.search);
	}, [surface]);

	if (surface === "dot") {
		return (
			<DotSurface
				agentState={state.agentState}
				actionKind={currentAgentAction(state.agentState, state.messages)}
				connected={state.connection === "open"}
				inControl={computerSession !== undefined}
				yolo={yolo !== undefined}
				toggle={togglePanel}
				startDrag={startDragging}
				{...(desktop ? { desktopCompanion } : {})}
			/>
		);
	}
	if (unreachable !== undefined || missingToken) {
		return (
			<>
				<div className="chat chat-web">
					<div className="status" role="status">
						{unreachable ??
							"This page needs your access key. Open it from the Gentle Dot menu (Open in browser)."}
					</div>
				</div>
				{companionOverlay}
			</>
		);
	}
	return (
		<SharedFileContext value={sharedFiles}>
			<ChatSurface
				variant={surface === "panel" ? "panel" : "web"}
				companionControls={companionControls}
				onCompanionActivity={setCompanionActivity}
				{...(desktop && surface === "panel" ? { desktopCompanion } : {})}
				state={state}
				send={send}
				refreshHistory={refreshHistory}
				dismiss={dismiss}
				dispatch={dispatch}
				focusKey={focusKey}
				{...(surface === "panel" ? { onHide: hidePanel } : {})}
				{...(desktop && surface === "panel" ? { appSend, answerAppApproval } : {})}
				{...(computer ? { computer } : {})}
				{...(desktop && surface === "panel" ? { voiceModel: true } : {})}
				{...(desktop && surface === "panel" ? { panelWindow: panel.controls } : {})}
				{...(desktop && surface === "panel" ? { settings: true } : {})}
				{...(upload ? { upload } : {})}
				{...(orchestration ? { orchestration } : {})}
				{...(usage ? { usage } : {})}
				{...(watchers ? { watchers } : {})}
				{...(mobileControls !== undefined ? { mobileControls, mobileDraftScope, onCollapseMobile } : {})}
			/>
			{companionOverlay}
		</SharedFileContext>
	);
}
