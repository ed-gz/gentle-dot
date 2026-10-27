// Question, outcome and action-ticker choreography adapted from capri-desktop (MIT): https://github.com/mochiiwuff/capri-desktop
import { questionPointingTarget, useWorkingSession } from "../companion-sessions.ts";
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
import { Capri2D } from "../capri2d/Capri2D.tsx";
import { useRoaming } from "../capri2d/useRoaming.ts";
import { useIntro } from "../capri2d/useIntro.ts";
import { usePossession } from "../capri2d/usePossession.ts";
import { publish3DSurface, readLocalAsset, usePreferred3D } from "../capri3d/native.ts";
import { useChoreography } from "../capri3d/useChoreography.ts";
import { restChoice, responseChoice, speechDuration } from "../capri3d/choreography.ts";
import { clipForBehavior, type ClipChoice } from "../capri3d/mapping.ts";
import { pointingClip } from "../capri3d/procedural.ts";
import { desktopFace } from "../capri3d/desktop-faces.ts";
import { CapriConversation, createOverlayPublisher, pendingApproval, type Speech, BUBBLE_HEIGHT, INPUT_HEIGHT } from "../capri3d/conversation.tsx";
import { useCompanionChat } from "../capri3d/replies.ts";
import { gestureChoice, type Gesture } from "../capri3d/gestures.ts";
import { connectionInfo, onDesktopEvent } from "../desktop.ts";
import { createOrchestrationClient, type AgentApproval, type OrchestrationClient } from "../orchestration.ts";
import "../desktop-companion.css";

// Prefixes emitted by this answer flow: local identity checks, orchestration.ts,
// daemon orchestration expiry, and the HERDR transport. Never surface other internals.
const APPROVAL_ERROR_PREFIXES = [
	"La pregunta cambió",
	"Sesión no disponible",
	"Esta solicitud venció",
	"No se puede conectar con HERDR",
	"La sesión cerró la conexión",
	"La conexión local no respondió",
	"Falló la conexión con los agentes",
	"El equipo devolvió",
];
export function approvalAnswerError(error: unknown): Error {
	return new Error(error instanceof Error && APPROVAL_ERROR_PREFIXES.some(prefix => error.message.startsWith(prefix))
		? error.message
		: "No se pudo responder con la sesión. Volvé a intentarlo o abrí el panel.");
}

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

// Serialize precise 2D shapes with activation/deactivation too: a delayed draw
// must not re-enable input after fallback or unmount.
let surfacePublications=Promise.resolve();
function publishCanvasSurface(active:boolean,mask?:number[],layout?:{bubble:boolean;input:boolean},bodyRects?:[number,number,number,number][]){
 const publication=surfacePublications.then(async()=>{
  if(bodyRects&&isTauri()) await invoke('capri3d_surface',{active,mask:mask??null,bubble:layout?.bubble??false,input:layout?.input??false,bodyRects});
  else await publish3DSurface(active,mask,layout);
 });
 surfacePublications=publication.catch(()=>{});
 return publication;
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
	const legacyPreferred3D = usePreferred3D(controls.state.enabled);
 const renderMode = controls.state.renderMode ?? (legacyPreferred3D ? "3d" : "sprites");
 const preferred3D = renderMode === "3d";
	const [active3D, setActive3D] = useState(false);
	const [failed3D, setFailed3D] = useState(false);
	useEffect(() => { setFailed3D(false); }, [preferred3D, controls.state.enabled]);
	const on3DActive = useCallback((active: boolean) => {
  bodyInput.current=undefined;
		setActive3D(active);
		void publishCanvasSurface(active).catch(() => { if (active) setFailed3D(true); });
	}, []);
	const [chatOpen, setChatOpen] = useState(false);
	const quickMessage = useRef({ chatOpen, toggle });
	quickMessage.current = { chatOpen, toggle };
	useEffect(() => {
		if (!controls.state.enabled) return;
		let live = true, stop: (() => void) | undefined;
		void onDesktopEvent("dot://capri-message", () => {
			if (!live) return;
			const current = quickMessage.current;
			const wasOpen = current.chatOpen;
			current.chatOpen = !wasOpen;
			setChatOpen(!wasOpen);
		}).then(unlisten => { if (live) stop = unlisten; else unlisten(); }).catch(() => {});
		return () => { live = false; stop?.(); };
	}, [controls.state.enabled]);
	const [gesture, setGesture] = useState<{ name: Gesture; at: number }>();
	useEffect(() => {
		if (!gesture) return;
		const choice = gestureChoice(gesture.name);
		const duration = choice.procedural ? ({ saludar: 3000, bailar: 7200, salto: 1300, voltereta: 1600, estirarse: 3200 }[gesture.name as "saludar" | "bailar" | "salto" | "voltereta" | "estirarse"] ?? 3200) : 6000;
		const timer = setTimeout(() => setGesture(undefined), duration);
		return () => clearTimeout(timer);
	}, [gesture]);
	const [overlays, setOverlays] = useState({ bubble: false, input: false });
	const maskState = useRef({ mask: Array<number>(816).fill(0), bubble: false, input: false });
 const bodyInput=useRef<[number,number,number,number][]|undefined>(undefined);
	const { state: chatState, send: chatSend } = useCompanionChat();
	const [approval, setApproval] = useState<AgentApproval>();
 const [answeredQuestion,setAnsweredQuestion]=useState<string>();
	const [denied, setDenied] = useState(false);
	useEffect(() => {
		if (!denied) return;
		const timer = setTimeout(() => setDenied(false), 6000);
		return () => clearTimeout(timer);
	}, [denied]);
	const orchestration = useRef<OrchestrationClient | undefined>(undefined);
	const layout = useCallback((bubble: boolean, input: boolean) => {
		maskState.current = { ...maskState.current, bubble, input };
		setOverlays(previous => previous.bubble === bubble && previous.input === input ? previous : { bubble, input });
	}, []);
	const publishMask = useMemo(() => createOverlayPublisher((mask, layout) => {
		void publishCanvasSurface(true, mask, layout).catch(() => setFailed3D(true));
	}), [active3D]);
	const on3DMask = useCallback((mask: number[],bodyRects?:[number,number,number,number][]) => {
		const current = maskState.current;
		current.mask = mask;
  bodyInput.current=bodyRects;
  if(bodyRects) void publishCanvasSurface(true,mask,current,bodyRects).catch(()=>setFailed3D(true));
		else publishMask(mask, current.bubble, current.input);
	}, [publishMask]);
	useEffect(() => {
		if (!active3D) return;
		const current = maskState.current;
  if(bodyInput.current) void publishCanvasSurface(true,current.mask,overlays,bodyInput.current).catch(()=>setFailed3D(true));
		else publishMask(current.mask, overlays.bubble, overlays.input);
	}, [active3D, overlays, publishMask]);
	const latest = useRef({ controls, inControl, reduced: false });
	const [awake, setAwake] = useState(() => !document.hidden);
	const [interacting, setInteracting] = useState(false);
	const [holding, setHolding] = useState(false);
 const [pointerEpisode, setPointerEpisode] = useState(0);
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
 const [activityInfo,setActivityInfo] = useState<Awaited<ReturnType<typeof connectionInfo>>>();
 useEffect(() => {
  if (!active3D || !visible || !isTauri()) return;
  let live = true;
  void connectionInfo().then(info => { if (live) setActivityInfo(info); }).catch(() => {});
  return () => { live = false; };
 },[active3D,visible]);
 const questionCue=controls.state.context?.cue;
 const liveQuestion=questionCue?.kind==="question" && questionCue.expiresAt>Date.now() ? questionCue : undefined;
 const enteredQuestions=useRef(new Set<string>());
 useEffect(()=>{
  if(!visible && liveQuestion)enteredQuestions.current.add(JSON.stringify([liveQuestion.id,liveQuestion.paneId,liveQuestion.sessionId]));
 },[visible,liveQuestion?.id,liveQuestion?.paneId,liveQuestion?.sessionId]);
 const workingSession = useWorkingSession(activityInfo,active3D && visible,liveQuestion);
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
		if (!outcome || !visible) return;
		const timer = setTimeout(() => setOutcome(undefined), Math.max(0, outcome.at + CAPRI_OUTCOME_MS - Date.now()));
		return () => clearTimeout(timer);
	}, [outcome, visible]);
	const context = controls.state.context;
	useEffect(() => {
		if (!active3D || context?.cue?.kind !== "question" || !isTauri()) { setApproval(undefined); return; }
		let live = true;
		setApproval(undefined);
		const abort = new AbortController();
		void connectionInfo().then(async info => {
			const client = createOrchestrationClient(info);
			orchestration.current = client;
			const snapshot = await client.snapshot(abort.signal);
			const cue = context.cue;
			const candidate = snapshot.approvals.find(a => cue?.id === `question:${a.id}` && a.paneId === cue.paneId && a.sessionId === cue.sessionId);
			if (live) setApproval(candidate);
		}).catch(() => { if (live) setApproval(undefined); });
		return () => { live = false; abort.abort(); };
	}, [active3D, context?.cue?.id, context?.cue?.paneId, context?.cue?.sessionId]);
	// A render can replace the cue before effect cleanup runs; invalidate late snapshots then, too.
	const approvalGeneration = useMemo(() => ({}), [active3D, approval?.id, context?.cue?.kind, context?.cue?.id, context?.cue?.paneId, context?.cue?.sessionId]);
	const currentApprovalGeneration = useRef(approvalGeneration);
	currentApprovalGeneration.current = approvalGeneration;
	// Self-heal: a request resolved in the terminal, panel or by expiry must not leave dead buttons.
	useEffect(() => {
		const cue = context?.cue;
		if (!approval || !active3D || cue?.kind !== "question" || !isTauri()) return;
		let live = true, pending = false;
		const abort = new AbortController();
		const timer = setInterval(() => {
			const client = orchestration.current;
			const generation = currentApprovalGeneration.current;
			if (!live || pending || !client || generation !== approvalGeneration) return;
			pending = true;
			void client.snapshot(abort.signal).then(snapshot => {
				if (live && currentApprovalGeneration.current === generation && !pendingApproval(snapshot.approvals, cue)) setApproval(undefined);
			}).catch(() => {}).finally(() => { pending = false; });
		}, 2000);
		return () => { live = false; clearInterval(timer); abort.abort(); };
	}, [approvalGeneration]);
	const [, refreshExpiry] = useState(0);
	useEffect(() => {
		const deadlines = [context?.cue?.expiresAt, context?.notification?.expiresAt]
			.filter((at): at is number => at !== undefined && at > Date.now());
		if (!deadlines.length) return;
		const timer = setTimeout(() => refreshExpiry((n) => n + 1), Math.max(0, Math.min(...deadlines) - Date.now()));
		return () => clearTimeout(timer);
	});
	const activeQuestion =
		context?.cue?.kind === "question" && context.cue.expiresAt > Date.now() && JSON.stringify([context.cue.id,context.cue.paneId,context.cue.sessionId])!==answeredQuestion ? context.cue : undefined;
 const questionTarget=activeQuestion ? questionPointingTarget(workingSession) : undefined;
 const questionClip=pointingClip(questionTarget ? questionTarget.rect.x+questionTarget.rect.width/2 : undefined,window.screenX+window.innerWidth/2);
	const cue =
		activeQuestion
			? activeQuestion
			: (context?.notification && context.notification.expiresAt > Date.now() ? context.notification
				: context?.cue && context.cue.kind !== "question" && context.cue.expiresAt > Date.now() ? context.cue : undefined);
	const previousSession = useRef<{ pane?: string; working: boolean }>({ working: false });
	useEffect(() => {
		const before = previousSession.current;
		if (before.working && before.pane === cue?.paneId && cue?.kind === "input-ready")
			setOutcome({ kind: "done", at: Date.now() });
		previousSession.current = { pane: cue?.paneId, working: cue?.kind === "working" };
	}, [cue?.kind, cue?.paneId]);
	const visualNotification = isVisualNotification(context?.notification) ? context?.notification : undefined;
	const notificationId = visualNotification?.id;
	const contextReady = controls.contextReady;
	const visualExpiresAt = visualNotification?.expiresAt;
	const lastVisualReceipt = useRef<string | undefined>(undefined);
	const attention = Boolean(activeQuestion) || (agentState === "needs_you" && context?.cue?.kind !== "question");
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
	useEffect(() => {
		if (!active3D || !visualNotification || !visible) return;
		let second = 0;
		const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => visualReady("file-away")); });
		return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
	}, [active3D, visualNotification?.id, visible, visualReady]);
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
	const choreography = useChoreography(controls.state.enabled && renderMode !== "sprites",
		behavior.state !== "idle" || interacting || Boolean(cue), cue?.id);
	const [speech, setSpeech] = useState<Speech & { until: number }>();
 const thinkingEpisode = useRef<{key:string;said:Set<string>}>({key:"",said:new Set()});
 const thinkingKey = workingSession?.activity.lastAction ? JSON.stringify([
  workingSession.paneId,workingSession.sessionId,workingSession.activity.lastAction,
 ]) : undefined;
 const thinkingSpeech = useCallback((text: string) => {
  if (!thinkingKey) return;
  if (thinkingEpisode.current.key !== thinkingKey) thinkingEpisode.current={key:thinkingKey,said:new Set()};
  if (thinkingEpisode.current.said.has(text)) return;
  thinkingEpisode.current.said.add(text);
  // Retain once-per-episode delivery across temporary hide/show; real notices always win.
  setSpeech(current => current && current.until > Date.now() ? current : {
   id: `thinking:${Date.now()}`, text, showMore: false, until: Date.now() + speechDuration(text),
  });
 },[thinkingKey]);
 useEffect(() => {
  if (!speech) return;
  const timer=setTimeout(()=>setSpeech(undefined),Math.max(0,speech.until-Date.now()));
  return()=>clearTimeout(timer);
 },[speech?.until]);
	useEffect(() => {
		if (!cue?.summary || !["notification", "submitted", "question", "capture", "download"].includes(cue.kind)) {
			setSpeech(undefined); return;
		}
		const presentation = cue.kind === "notification" || cue.kind === "capture" ? notificationPresentation(cue) : { ...cue, showMore: undefined };
		const text = `${presentation.summary}${presentation.body ? ` ${presentation.body}` : ""}`;
		const duration = Math.min(speechDuration(text), Math.max(0, cue.expiresAt - Date.now()));
		setSpeech({ ...presentation, question: cue.kind === "question", approvalKey: cue.kind === "question" ? JSON.stringify([cue.paneId, cue.sessionId, cue.id.slice("question:".length)]) : undefined, id: cue.id, until: Date.now() + duration, text, showMore: presentation.showMore });
		const timer = setTimeout(() => setSpeech(undefined), duration);
		return () => clearTimeout(timer);
	}, [cue?.id, cue?.summary, cue?.body, cue?.kind, cue?.expiresAt, cue?.paneId, cue?.sessionId]);
 const introActive=useIntro(controls.state.enabled,connected,Boolean(activeQuestion)||Boolean(approval)||attention||inControl||chatOpen,reduced||!controls.state.motion);
 const possessionBusy=useRef(false);
 const roaming=useRoaming(renderMode==='2d' && visible,{
  composer:chatOpen,question:Boolean(activeQuestion),approval:Boolean(approval)||attention,
  sleeping:choreography.absent||choreography.rest==='sleep',reduced:reduced||!controls.state.motion,
  paused:possessionBusy.current||introActive||inControl||interacting||controls.state.pinned||(controls.state.paused&&!reduced),
 });
 const possessionActive=usePossession(renderMode==='2d'&&visible,connected,{
  perched:roaming.pose?.resting==='sit'&&!roaming.travelling,
  composer:chatOpen,question:Boolean(activeQuestion),approval:Boolean(approval)||attention,
  intro:introActive,reduced:reduced||!controls.state.motion,
  sleeping:choreography.absent||choreography.rest==='sleep',
  paused:inControl||interacting||controls.state.pinned||controls.state.paused,
 },roaming.feedSource);
 possessionBusy.current=possessionActive;
	const motion = choreography.motion;
	const perched = (cue?.kind === "input-ready" || cue?.kind === "typing") && cue.placement === "perch";
	const baseChoice = useMemo<ClipChoice>(() => {
		if (activeQuestion) return { model: "roja.glb", clip: null, procedural: questionClip };
		if (attention) return responseChoice("attention");
		if (choreography.absent) return restChoice("sleep");
		if (holding && !controls.state.pinned) return { model: "roja.glb", clip: null, procedural: "colgando" };
		if (choreography.rest === "wake" || choreography.rest === "greet") return restChoice(choreography.rest);
		if (gesture) return gestureChoice(gesture.name);
		if (controls.state.travelling && motion && motion.mode !== "rest") {
			return motion.mode === "teleport"
				? { model: "roja.glb", clip: "Saludar_y_teletransportarse", start: 2.85, end: 4.65, once: true, motion: "teleport", duration: motion.duration }
				: { model: "roja.glb", clip: "Flotar_en_reposo", motion: motion.mode, direction: motion.direction, duration: motion.duration };
		}
		if (motion?.mode === "land") return { model: "roja.glb", clip: null, procedural: "quieta", once: true, motion: "land", duration: 600 };
		// Outcome poses must not be replaced by their own summary's talking clip.
		if (behavior.state === "done") return { model: "roja.glb", clip: null, procedural: "celebrar", once: true };
		if (behavior.state === "error") return clipForBehavior(behavior);
		if (speech) return responseChoice("reply");
		if (perched && (behavior.state === "idle" || behavior.state === "userTyping")) return { model: "roja.glb", clip: null, procedural: "sentada" };
		if (behavior.state === "idle") return restChoice(choreography.rest);
		return clipForBehavior(behavior);
	}, [choreography.absent, attention, activeQuestion?.id, questionClip, gesture, holding, controls.state.pinned, controls.state.travelling, motion, speech, behavior.state, behavior.animation, behavior.target, choreography.rest, perched]);
	const faceEvent = attention ? "question" : denied ? "denied" : behavior.state === "error" ? "error"
		: behavior.state === "done" ? "done" : behavior.state === "userTyping" ? "typing"
		: behavior.state === "agentWorking" ? "working"
		: choreography.rest === "wake" || choreography.rest === "greet" ? "return"
		: choreography.absent || choreography.rest === "sleep" ? "idle"
		: cue?.kind === "submitted" ? "output" : cue?.kind === "notification" ? "notification" : "";
	// Typing uses a compact head to leave the editor clear; other events peek alongside 3D.
	const choice = useMemo<ClipChoice>(() => ({ ...baseChoice, perch: perched && baseChoice.procedural === "sentada",
		face: { animation: desktopFace(faceEvent), form: faceEvent === "typing" ? "face" : "3d" },
	}), [baseChoice, faceEvent, perched]);
	const duo = pose.startsWith("duo-") || pose === "invite-rebecca";
	const externalMessage = cue?.kind === "notification" || cue?.kind === "capture" ? notificationPresentation(cue) : undefined;
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
		<div className="capri3d-host" data-expanded={active3D && (overlays.bubble || overlays.input)} style={{ "--capri-top": `${active3D && overlays.bubble ? BUBBLE_HEIGHT : 0}px`, "--capri-bottom": `${active3D && overlays.input ? INPUT_HEIGHT : 0}px` } as React.CSSProperties}>
		<button
			type="button"
			className="desktop-companion-surface"
			data-form={active3D ? "3d" : "2d"}
            data-render-mode={renderMode}
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
			onMouseEnter={() => { setPointerEpisode(n => n + 1); hold("hover", true); }}
			onMouseLeave={() => hold("hover", false)}
			onFocus={() => hold("focus", true)}
			onBlur={() => hold("focus", false)}
			onPointerDown={(event) => {
				if (!visible || event.button !== 0 || event.isPrimary === false) return;
				suppressClick.current = false;
				press.current = {
					id: event.pointerId,
					x: renderMode === '2d' ? event.screenX : event.clientX,
					y: renderMode === '2d' ? event.screenY : event.clientY,
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
                if(renderMode==='2d' && current && current.id===event.pointerId){
                 if(controls.state.pinned||chatOpen||activeQuestion||approval||attention)return;
                 const dx=event.screenX-current.x,dy=event.screenY-current.y;
                 if(Math.hypot(dx,dy)<6)return;
                 current.x=event.screenX;current.y=event.screenY;current.dragging=true;
                 suppressClick.current=true;event.preventDefault();
                 roaming.dragBy(dx,dy);
                 return;
                }
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
				if (visible) { if (active3D) setChatOpen(true); else toggle(); }
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
					if (active3D) setChatOpen(true); else toggle();
				}
			}}
			onContextMenu={(event) => {
				event.preventDefault();
				void controls.menu().catch(() => {});
			}}
		>
            {renderMode === "2d" ? <Capri2D
                 possessing={possessionActive}
                 sleepingPerched={(perched||roaming.pose?.resting==='sit')&&(choreography.absent||choreography.rest==='sleep')&&!reduced}
                enabled={controls.state.enabled} visible={visible && !inControl}
                reduced={reduced || !controls.state.motion}
                intent={{
                 question: activeQuestion ? JSON.stringify([activeQuestion.id,activeQuestion.paneId,activeQuestion.sessionId]) : undefined,
                 alert: attention && !activeQuestion,
                 direction: activeQuestion ? (questionClip === "pointingLeft" ? -1 : 1) : roaming.pose?.direction ?? motion?.direction ?? 1,
                 outcome: behavior.state === "done" || behavior.state === "error" ? outcome : undefined,
                 resting: choreography.absent || choreography.rest === "sleep" ? "sleep" : choreography.rest === "wake" || choreography.rest === "greet" ? "wake" : perched || roaming.pose?.resting === 'sit' || choreography.rest === "sit" ? "sit" : "stand",
                 pointer: interacting && !holding ? pointerEpisode : undefined,
                 dragging: holding && !controls.state.pinned,
                 watching: behavior.state === "userTyping" && !perched,
                 seated: perched || roaming.pose?.resting === 'sit' || choreography.rest === "sit",
                 working: behavior.state === "agentWorking",
                 thinking: agentState === "thinking" || actionKind === "thinking",
                 workBeat: workingSession?.activity.lastAction?.at,
                 gesture,
                 travelling: roaming.travelling || controls.state.travelling,
                 falling: motion?.mode === "fall",
                 talking: Boolean(speech),
                }}
                onActive={on3DActive} onMask={on3DMask}
            /> : <Capri3D
				enabled={controls.state.enabled}
				preferred={preferred3D && !failed3D}
				visible={visible && !inControl}
				reduced={reduced || !controls.state.motion}
				behavior={behavior}
				choice={choice}
				read={readLocalAsset}
				onActive={on3DActive}
				onMask={on3DMask}
			/>}
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
		{active3D && visible && <CapriConversation
   question={activeQuestion ? {...activeQuestion,target:questionTarget} : undefined} enteredQuestions={enteredQuestions.current}
			state={chatState} send={chatSend} open={chatOpen} close={() => setChatOpen(false)}
			outcome={renderMode !== "2d" && (behavior.state === "done" || behavior.state === "error") ? outcome : undefined} reduced={reduced || !controls.state.motion} visible={visible && !inControl}
			speech={speech} approval={approval} activity={attention ? undefined : workingSession?.activity} episodeKey={workingSession ? `${workingSession.paneId}:${workingSession.sessionId}` : undefined} onThinkingSpeech={thinkingSpeech} onLayout={layout} more={() => { if (cue?.kind === "question") void controls.openContext?.(); toggle(); }}
			onGesture={name => setGesture({ name, at: Date.now() })}
			answer={async action => {
				try {
					if (!orchestration.current) throw new Error("Sesión no disponible");
					// Revalidate immediately before the existing answer action; stale UI never approves a replacement.
					const snapshot = await orchestration.current.snapshot();
					if (action.action !== "answer" || !pendingApproval(snapshot.approvals, { id: `question:${action.requestId}`, paneId: action.paneId, sessionId: action.sessionId })) throw new Error("La pregunta cambió");
					await orchestration.current.act(action);
     setAnsweredQuestion(JSON.stringify([`question:${action.requestId}`,action.paneId,action.sessionId]));
					if ("approved" in action && !action.approved) setDenied(true);
				} catch (error) {
					throw approvalAnswerError(error);
				}
			}}
		/>}
		</div>
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
