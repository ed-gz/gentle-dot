import type { AgentState } from "@gentle-dot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { type CapriAction, capriAnimation } from "../capri-animation.ts";
import type { CapriPose } from "../capri-art.ts";
import { sceneCaption, sceneForActivity } from "../capri-scenes.ts";
import { isVisualNotification, notificationPresentation } from "../companion-notification.ts";
import type { DesktopCompanionControls } from "../desktop-companion.ts";
import { CapriSprite } from "./CapriCompanion.tsx";
import "../desktop-companion.css";

interface Props {
	controls: DesktopCompanionControls;
	agentState: AgentState;
	connected: boolean;
	inControl?: boolean;
	yolo?: boolean;
	toggle(): void;
	startDrag(): void | Promise<void>;
}
const IDLE_ART: readonly CapriPose[] = [
	"idle",
	"coffee",
	"stretch",
	"snack",
	"chill",
	"reading",
	"lounging",
	"peek",
	"eyes",
	"face",
	"sleepy-coffee",
	"confused",
];
interface Press {
	id: number;
	x: number;
	y: number;
	dragging: boolean;
	target: HTMLButtonElement;
}

/** The native companion has its own preferences and window; web/mobile appearance is never read here. */
export function DesktopCompanionSurface({
	controls,
	agentState,
	connected,
	inControl = false,
	yolo = false,
	toggle,
	startDrag,
}: Props) {
	const latest = useRef({ controls, inControl, reduced: false });
	const [awake, setAwake] = useState(() => !document.hidden);
	const [interacting, setInteracting] = useState(false);
	const [phase, setPhase] = useState(0);
	const [greeting, setGreeting] = useState(true);
	const [celebrate, setCelebrate] = useState(false);
	const [reduced, setReduced] = useState(
		() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	latest.current = { controls, inControl, reduced };
	const held = useRef({ hover: false, focus: false, press: false });
	const reported = useRef(false);
	const press = useRef<Press | undefined>(undefined);
	const suppressClick = useRef(false);
	const previousBusy = useRef(false);
	const visible = controls.state.enabled && controls.state.visible && awake;
	const animated = visible && !reduced;
	const actionAtlas = useRef<HTMLImageElement | undefined>(undefined);
	useEffect(() => {
		if (!controls.state.enabled) return;
		const clip = capriAnimation("file-away");
		if (!clip) return;
		// Warm the local action atlas before the 450 ms notification deadline starts.
		// This never acknowledges a notification; its actual gesture still needs two painted frames.
		const image = new Image();
		actionAtlas.current = image;
		image.src = clip.href;
		if (typeof image.decode === "function") void image.decode().catch(() => {});
		return () => {
			actionAtlas.current = undefined;
		};
	}, [controls.state.enabled]);
	const moving =
		animated &&
		controls.state.motion &&
		!controls.state.pinned &&
		!controls.state.paused &&
		!interacting &&
		!inControl;
	useEffect(() => {
		if (!animated || !greeting) return;
		const timer = setTimeout(() => setGreeting(false), 3500);
		return () => clearTimeout(timer);
	}, [animated, greeting]);
	const publishInteraction = useCallback((reconcile = false) => {
		const local = held.current.hover || held.current.focus || held.current.press;
		setInteracting(local);
		const current = latest.current;
		const active =
			!document.hidden &&
			current.controls.state.visible &&
			current.controls.state.enabled &&
			(local || current.inControl || current.reduced);
		if (reported.current === active && (!reconcile || !active)) return;
		reported.current = active;
		void current.controls.interact(active).catch(() => {});
	}, []);
	const hold = (kind: keyof typeof held.current, value: boolean) => {
		held.current[kind] = value;
		publishInteraction();
	};
	const endPointer = useCallback(() => {
		const current = press.current;
		press.current = undefined;
		if (current) {
			try {
				if (current.target.hasPointerCapture?.(current.id)) current.target.releasePointerCapture(current.id);
			} catch {
				/* Native drag already released it. */
			}
		}
		held.current.press = false;
		publishInteraction();
	}, [publishInteraction]);
	const clearInteraction = useCallback(() => {
		held.current = { hover: false, focus: false, press: false };
		endPointer();
	}, [endPointer]);
	useEffect(() => {
		if (typeof matchMedia !== "function") return;
		const query = matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setReduced(query.matches);
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	useEffect(() => {
		const visibility = () => {
			setAwake(!document.hidden);
			if (document.hidden) clearInteraction();
			else publishInteraction();
		};
		document.addEventListener("visibilitychange", visibility);
		window.addEventListener("blur", clearInteraction);
		return () => {
			document.removeEventListener("visibilitychange", visibility);
			window.removeEventListener("blur", clearInteraction);
			if (reported.current) {
				reported.current = false;
				void latest.current.controls.interact(false).catch(() => {});
			}
		};
	}, [clearInteraction, publishInteraction]);
	// The stable callback reads these flags from refs, so changes must still republish the native pause.
	// biome-ignore lint/correctness/useExhaustiveDependencies: inControl and reduced are read through latest by publishInteraction.
	useEffect(() => {
		if (!controls.state.visible || !controls.state.enabled) clearInteraction();
		else publishInteraction(!controls.state.paused);
	}, [
		controls.state.visible,
		controls.state.enabled,
		controls.state.paused,
		inControl,
		reduced,
		clearInteraction,
		publishInteraction,
	]);
	useEffect(() => {
		if (!animated) return;
		const timer = setInterval(() => setPhase((value) => (value + 1) % 120), 12_000);
		return () => clearInterval(timer);
	}, [animated]);
	useEffect(() => {
		const busy = agentState === "working" || agentState === "thinking";
		const finished = previousBusy.current && agentState === "idle" && visible;
		previousBusy.current = busy;
		setCelebrate(finished);
		if (!finished) return;
		const timer = setTimeout(() => setCelebrate(false), 6000);
		return () => clearTimeout(timer);
	}, [agentState, visible]);
	const context = controls.state.context;
	const activeQuestion =
		context?.cue?.kind === "question" && context.cue.expiresAt > Date.now() ? context.cue : undefined;
	const cue =
		isVisualNotification(context?.notification) && activeQuestion
			? activeQuestion
			: (context?.notification ?? context?.cue);
	const visualNotification = isVisualNotification(context?.notification) ? context?.notification : undefined;
	const notificationId = visualNotification?.id;
	const contextReady = controls.contextReady;
	const visualExpiresAt = visualNotification?.expiresAt;
	const lastVisualReceipt = useRef<string | undefined>(undefined);
	const attention = agentState === "needs_you" || cue?.kind === "question";
	const visualReady = useCallback(
		(action: CapriAction) => {
			if (
				action !== "file-away" ||
				!notificationId ||
				!visible ||
				inControl ||
				attention ||
				!visualExpiresAt ||
				visualExpiresAt <= Date.now() ||
				!contextReady ||
				lastVisualReceipt.current === notificationId
			)
				return;
			lastVisualReceipt.current = notificationId;
			void contextReady(notificationId).catch(() => {});
		},
		[notificationId, visible, inControl, attention, visualExpiresAt, contextReady],
	);
	const visiting = phase % 10 >= 3 && phase % 10 <= 7;
	const soloSlot = phase % 10 <= 2 ? phase % 10 : (phase % 10) - 5;
	const idlePose = IDLE_ART[(Math.floor(phase / 10) * 5 + soloSlot) % IDLE_ART.length] ?? "idle";
	let pose = sceneForActivity({
		state: inControl || cue?.kind === "working" ? "working" : agentState,
		connected: connected || !!context?.musicPlaying || !!cue,
		attention,
		sessions: !!cue?.sessionId,
		interaction:
			cue?.kind === "typing"
				? "typing"
				: cue?.kind === "submitted"
					? "submitted"
					: greeting && agentState === "idle" && !context?.musicPlaying
						? "greeting"
						: "rest",
		company: "visits",
		phase,
		scene: agentState === "idle" && phase > 0 && !visiting && !celebrate && !inControl ? idlePose : "auto",
		celebrate,
		musicPlaying: context?.musicPlaying,
	});
	if (!attention && !inControl && isVisualNotification(cue)) pose = "file-away";
	if (!attention && !inControl && cue?.kind === "notification") pose = "face";
	if (!attention && !inControl && !context?.notification && cue?.placement) {
		if (cue.kind === "input-ready" && cue.placement === "perch") pose = "perch";
		else if (cue.kind === "typing" && cue.placement === "aside")
			pose = controls.state.travelling ? "step-aside" : "peek";
	}
	const duo = pose.startsWith("duo-") || pose === "invite-rebecca";
	const externalMessage = cue?.kind === "notification" ? notificationPresentation(cue) : undefined;
	const message =
		!connected && !context?.musicPlaying && !cue
			? "Sin conexión con tu asistente"
			: inControl
				? "Controlando tu equipo"
				: attention
					? (cue?.summary ?? "Hay una pregunta para ti")
					: externalMessage
						? `${externalMessage.summary}${externalMessage.body ? ` «${externalMessage.body}»` : ""}`
						: cue?.summary
							? cue.summary
							: sceneCaption(pose);
	return (
		<button
			type="button"
			className="desktop-companion-surface"
			data-pose={pose}
			data-duo={duo}
			data-motion={moving}
			data-animated={animated}
			data-pinned={controls.state.pinned}
			data-visible={visible}
			data-attention={attention}
			data-context={cue?.kind ?? (context?.musicPlaying ? "music" : "rest")}
			data-in-control={inControl}
			data-yolo={yolo}
			aria-label={`${duo ? "Capri y Rebecca" : "Capri"}: ${message}${yolo ? ". Modo directo activo" : ""}. Abrir conversación`}
			tabIndex={visible ? 0 : -1}
			aria-hidden={!visible}
			onMouseEnter={() => hold("hover", true)}
			onMouseLeave={() => hold("hover", false)}
			onFocus={() => hold("focus", true)}
			onBlur={() => hold("focus", false)}
			onPointerDown={(event) => {
				if (!visible || event.button !== 0 || event.isPrimary === false) return;
				suppressClick.current = false;
				press.current = {
					id: event.pointerId,
					x: event.clientX,
					y: event.clientY,
					dragging: false,
					target: event.currentTarget,
				};
				hold("press", true);
				try {
					event.currentTarget.setPointerCapture(event.pointerId);
				} catch {
					/* Unsupported test surface. */
				}
			}}
			onPointerMove={(event) => {
				const current = press.current;
				if (
					!current ||
					current.id !== event.pointerId ||
					current.dragging ||
					Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6
				)
					return;
				current.dragging = true;
				suppressClick.current = true;
				event.preventDefault();
				try {
					if (current.target.hasPointerCapture?.(current.id))
						current.target.releasePointerCapture(current.id);
					void Promise.resolve(startDrag())
						.catch(() => {})
						.finally(() => {
							if (press.current === current) endPointer();
						});
				} catch {
					endPointer();
				}
			}}
			onPointerUp={(event) => {
				if (press.current?.id === event.pointerId) endPointer();
			}}
			onPointerCancel={(event) => {
				if (press.current?.id === event.pointerId) {
					suppressClick.current = true;
					endPointer();
				}
			}}
			onLostPointerCapture={(event) => {
				if (press.current?.id === event.pointerId) endPointer();
			}}
			onClick={(event) => {
				if (suppressClick.current && event.detail !== 0) {
					suppressClick.current = false;
					event.preventDefault();
					return;
				}
				if (visible) toggle();
			}}
			onKeyDown={(event) => {
				if (!visible || event.altKey || event.metaKey || event.ctrlKey) return;
				if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
					event.preventDefault();
					void controls.menu().catch(() => {});
					return;
				}
				const step = event.shiftKey ? 64 : 24;
				const delta: Record<string, [number, number]> = {
					ArrowLeft: [-step, 0],
					ArrowRight: [step, 0],
					ArrowUp: [0, -step],
					ArrowDown: [0, step],
				};
				const direction = delta[event.key];
				if (direction) {
					event.preventDefault();
					void controls.move(...direction).catch(() => {});
				} else if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					toggle();
				}
			}}
			onContextMenu={(event) => {
				event.preventDefault();
				void controls.menu().catch(() => {});
			}}
		>
			<CapriSprite
				key={notificationId ?? "companion"}
				pose={pose}
				animated
				playing={animated}
				onPresented={visualNotification ? visualReady : undefined}
				walking={
					Boolean(controls.state.travelling) &&
					!duo &&
					!attention &&
					!visualNotification &&
					pose !== "perch" &&
					pose !== "eyes" &&
					pose !== "eyes-blink" &&
					pose !== "face" &&
					pose !== "face-talk"
				}
			/>
			{inControl || yolo ? (
				<span className="desktop-companion-control" aria-hidden="true">
					{inControl ? "Control activo" : "Modo directo"}
				</span>
			) : null}
		</button>
	);
}

/** Independent static launcher: no assistant connection, preference reader, or animation timers. */
export function DesktopCompanionLauncher({ toggle }: { toggle(): void; recall?(): void | Promise<void> }) {
	return (
		<button
			type="button"
			className="desktop-companion-launcher"
			aria-label="Abrir conversación con Capri"
			title="Abrir conversación con Capri"
			onClick={toggle}
		>
			<CapriSprite pose="face" />
		</button>
	);
}
