import type { AgentState } from "@gentle-dot/protocol";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type CapriAction, capriAnimation } from "../capri-animation.ts";
import { capriBehavior, CAPRI_OUTCOME_MS, type CapriActionKind } from "@gentle-dot/theme-capri/behavior";
import { sceneCaption } from "../capri-scenes.ts";
import { isVisualNotification, notificationPresentation } from "../companion-notification.ts";
import type { DesktopCompanionControls } from "../desktop-companion.ts";
import { CapriSprite } from "./CapriCompanion.tsx";
import { Capri3D } from "../capri3d/Capri3D.tsx";
import { publish3DSurface, readLocalAsset, usePreferred3D } from "../capri3d/native.ts";
import { useChoreography } from "../capri3d/useChoreography.ts";
import { restChoice, responseChoice, speechDuration } from "../capri3d/choreography.ts";
import { clipForBehavior, type ClipChoice } from "../capri3d/mapping.ts";
import "../desktop-companion.css";

interface Props {
	controls: DesktopCompanionControls;
	agentState: AgentState;
	actionKind?: CapriActionKind;
	connected: boolean;
	inControl?: boolean;
	yolo?: boolean;
	toggle(): void;
	startDrag(): void | Promise<void>;
}
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
	actionKind,
	connected,
	inControl = false,
	yolo = false,
	toggle,
	startDrag,
}: Props) {
	const preferred3D = usePreferred3D(controls.state.enabled);
	const [active3D, setActive3D] = useState(false);
	const [failed3D, setFailed3D] = useState(false);
	useEffect(() => { setFailed3D(false); }, [preferred3D, controls.state.enabled]);
	const on3DActive = useCallback((active: boolean) => {
		setActive3D(active);
		void publish3DSurface(active).catch(() => { if (active) setFailed3D(true); });
	}, []);
	const on3DMask = useCallback((mask: number[]) => {
		void publish3DSurface(true, mask).catch(() => setFailed3D(true));
	}, []);
	const latest = useRef({ controls, inControl, reduced: false });
	const [awake, setAwake] = useState(() => !document.hidden);
	const [interacting, setInteracting] = useState(false);
	const [holding, setHolding] = useState(false);
	const [outcome, setOutcome] = useState<{ kind: "done" | "error"; at: number }>();
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
		if (kind === "press") setHolding(value);
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
		setHolding(false);
		publishInteraction();
	}, [publishInteraction]);
	const clearInteraction = useCallback(() => {
		if (press.current?.dragging && active3D) return;
		held.current = { hover: false, focus: false, press: false };
		endPointer();
	}, [endPointer, active3D]);
	useEffect(() => {
		if (!controls.state.enabled || !isTauri()) return;
		let live = true, stop: (() => void) | undefined;
		void import("@tauri-apps/api/event").then(async ({ listen }) => {
			const unlisten = await listen("dot://capri3d-release", () => {
				if (!live) return;
				held.current = { hover: false, focus: false, press: false };
				endPointer();
			});
			if (live) stop = unlisten; else unlisten();
		}).catch(() => {});
		return () => { live = false; stop?.(); };
	}, [controls.state.enabled, endPointer]);
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
		const busy = agentState === "working" || agentState === "thinking";
		if (agentState === "error" || (previousBusy.current && agentState === "idle"))
			setOutcome({ kind: agentState === "error" ? "error" : "done", at: Date.now() });
		previousBusy.current = busy;
	}, [agentState]);
	useEffect(() => {
		if (!outcome) return;
		const timer = setTimeout(() => setOutcome(undefined), Math.max(0, outcome.at + CAPRI_OUTCOME_MS - Date.now()));
		return () => clearTimeout(timer);
	}, [outcome]);
	const context = controls.state.context;
	const [, refreshExpiry] = useState(0);
	useEffect(() => {
		const deadlines = [context?.cue?.expiresAt, context?.notification?.expiresAt]
			.filter((at): at is number => at !== undefined && at > Date.now());
		if (!deadlines.length) return;
		const timer = setTimeout(() => refreshExpiry((n) => n + 1), Math.max(0, Math.min(...deadlines) - Date.now()));
		return () => clearTimeout(timer);
	});
	const activeQuestion =
		context?.cue?.kind === "question" && context.cue.expiresAt > Date.now() ? context.cue : undefined;
	const cue =
		isVisualNotification(context?.notification) && activeQuestion
			? activeQuestion
			: (context?.notification && context.notification.expiresAt > Date.now() ? context.notification
				: context?.cue && context.cue.expiresAt > Date.now() ? context.cue : undefined);
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
	const behavior = capriBehavior({
		now: Date.now(),
		pendingQuestion: attention,
		outcome,
		typingUntil: cue?.kind === "typing" ? cue.expiresAt : undefined,
		agentWorking: inControl || cue?.kind === "working" || agentState === "working" || agentState === "thinking",
		actionKind: inControl ? "run" : actionKind ?? (agentState === "thinking" ? "thinking" : undefined),
		reply: cue?.kind === "submitted" ? { kind: "submitted", at: cue.expiresAt - 4500 } : undefined,
	});
	let pose = behavior.animation;
	// Delivery gestures and a verified resting perch have explicit causes, never a clock phase.
	if (behavior.state === "idle") {
		if (isVisualNotification(cue)) pose = "file-away";
		else if (cue?.kind === "notification") pose = "face";
		else if (cue?.kind === "input-ready" && cue.placement === "perch") pose = "perch";
	}
	const choreography = useChoreography(controls.state.enabled && preferred3D,
		behavior.state !== "idle" || interacting || Boolean(cue), cue?.id);
	const [speech, setSpeech] = useState<{ id: string; until: number; text: string }>();
	useEffect(() => {
		if (!cue?.summary || !["notification", "submitted"].includes(cue.kind)) {
			setSpeech(undefined); return;
		}
		const text = `${cue.summary}${cue.body ? ` ${cue.body}` : ""}`;
		const duration = Math.min(speechDuration(text), Math.max(0, cue.expiresAt - Date.now()));
		setSpeech({ id: cue.id, until: Date.now() + duration, text });
		const timer = setTimeout(() => setSpeech(undefined), duration);
		return () => clearTimeout(timer);
	}, [cue?.id, cue?.summary, cue?.body, cue?.kind, cue?.expiresAt]);
	const motion = choreography.motion;
	const perched = cue?.kind === "input-ready" && cue.placement === "perch";
	const choice = useMemo<ClipChoice>(() => {
		if (choreography.absent) return restChoice("sleep");
		if (holding && !controls.state.pinned) return { model: "roja_brazos.glb", clip: null };
		if (choreography.rest === "wake" || choreography.rest === "greet") return restChoice(choreography.rest);
		if (attention) return responseChoice("attention");
		if (controls.state.travelling && motion && motion.mode !== "rest") {
			return motion.mode === "teleport"
				? { model: "roja.glb", clip: "Saludar_y_teletransportarse", start: 2.85, end: 4.65, once: true, motion: "teleport", duration: motion.duration }
				: { model: "roja.glb", clip: "Flotar_en_reposo", motion: motion.mode, direction: motion.direction, duration: motion.duration };
		}
		if (motion?.mode === "land") return { model: "roja.glb", clip: "Reir", once: true, motion: "land", duration: 600 };
		if (speech) return responseChoice("reply");
		if (behavior.state === "idle") return restChoice(perched ? "sit" : choreography.rest);
		return clipForBehavior(behavior);
	}, [choreography.absent, attention, holding, controls.state.pinned, controls.state.travelling, motion, speech, behavior.state, behavior.animation, behavior.target, choreography.rest, perched]);
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
			data-form={active3D ? "3d" : "2d"}
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
					controls.state.pinned ||
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
					if (isTauri()) void invoke("desktop_companion_interaction", { active: true, dragging: true }).catch(() => {});
					void Promise.resolve(startDrag()).catch(() => endPointer()).finally(() => { if (!active3D && press.current === current) endPointer(); });
				} catch {
					endPointer();
				}
			}}
			onPointerUp={(event) => {
				if (active3D && press.current?.dragging) held.current = { hover: false, focus: false, press: false };
				if (suppressClick.current && isTauri() && !controls.state.pinned)
					void invoke("desktop_companion_interaction", { active: false, released: true }).catch(() => {});
				if (press.current?.id === event.pointerId) endPointer();
			}}
			onPointerCancel={(event) => {
				if (active3D && press.current?.dragging) return;
				if (press.current?.id === event.pointerId) {
					suppressClick.current = true;
					endPointer();
				}
			}}
			onLostPointerCapture={(event) => {
				if (press.current?.id === event.pointerId && (!press.current.dragging || !active3D)) endPointer();
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
					if (!controls.state.pinned) void controls.move(...direction).catch(() => {});
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
			<Capri3D
				enabled={controls.state.enabled && !visualNotification}
				preferred={preferred3D && !failed3D}
				visible={visible && !inControl}
				reduced={reduced || !controls.state.motion}
				behavior={behavior}
				choice={choice}
				read={readLocalAsset}
				onActive={on3DActive}
				onMask={on3DMask}
			/>
			{!active3D && <CapriSprite
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
			/>}
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
