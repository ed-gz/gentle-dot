import type { AgentState } from "@gentle-dot/protocol";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { companionTarget, useCompanionActivity } from "../companion-activity.ts";
import { useCapriFloat } from "../useCapriFloat.ts";
import type { CompanionControls } from "../useCompanion.ts";
import "../capri.css";
import { type CapriAction, capriAnimation } from "../capri-animation.ts";
import { type CapriPose, capriFrame } from "../capri-art.ts";
import { capriBehavior, CAPRI_OUTCOME_MS, type CapriActionKind } from "@gentle-dot/theme-capri/behavior";
import { sceneCaption } from "../capri-scenes.ts";
import { CapriAnimatedSprite } from "./CapriAnimatedSprite.tsx";
import { CompanionSpaceEditor } from "./CompanionSpaceEditor.tsx";
import { MobileAtlas } from "../capri3d/MobileAtlas.tsx";

export { CAPRI_POSES, type CapriPose } from "../capri-art.ts";

export function CapriSprite({
	pose = "idle",
	className = "",
	animated = false,
	playing = true,
	walking = false,
	onPresented,
}: {
	pose?: CapriPose;
	className?: string;
	animated?: boolean;
	playing?: boolean;
	walking?: boolean;
	onPresented?: (action: CapriAction) => void;
}) {
	const { frame, data, href } = capriFrame(pose);
	const clip = useId();
	const still = (
		<span
			aria-hidden="true"
			className={`capri-sprite ${className}`}
			data-pose={pose}
			data-animation="static"
			data-frame="0"
			data-playing="false"
		>
			<svg
				aria-hidden="true"
				width="100%"
				height="100%"
				viewBox={`${frame.x} ${frame.y} ${frame.width} ${frame.height}`}
				preserveAspectRatio="xMidYMid meet"
				overflow="hidden"
				focusable="false"
			>
				<defs>
					<clipPath id={clip}>
						{"clip" in frame && frame.clip ? (
							<polygon points={frame.clip.map((point) => point.join(",")).join(" ")} />
						) : (
							<rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} />
						)}
					</clipPath>
				</defs>
				<image href={href} width={data.width} height={data.height} clipPath={`url(#${clip})`} />
			</svg>
		</span>
	);
	const animation = animated ? capriAnimation(pose, walking) : undefined;
	return animation ? (
		<CapriAnimatedSprite
			clip={animation}
			pose={pose}
			className={className}
			enabled={playing}
			fallback={still}
			onPresented={onPresented}
		/>
	) : (
		still
	);
}

export function CompanionSwitch({
	controls,
	compact = false,
}: {
	controls: CompanionControls;
	compact?: boolean;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-label="Tema Capri"
			aria-checked={controls.settings.mode === "capri"}
			className={`companion-switch${compact ? " capri-activation" : ""}`}
			onClick={() => void controls.setMode(controls.settings.mode === "capri" ? "gentle" : "capri")}
		>
			<span className="companion-switch-track" aria-hidden="true">
				<span />
			</span>
			<span>
				{compact
					? controls.settings.mode === "capri"
						? "Activo"
						: "Activar"
					: controls.settings.mode === "capri"
						? "Capri"
						: "Gentle Dot"}
			</span>
		</button>
	);
}

export function CompanionSettings({
	controls,
	desktop = false,
}: {
	controls: CompanionControls;
	desktop?: boolean;
}) {
	const { settings, change } = controls;
	return (
		<section className="companion-settings capri-preferences" aria-label="Tema y personalidad">
			<div className="capri-preferences-header">
				<div>
					<h3>Tema Capri</h3>
					<p>
						{settings.mode === "capri"
							? "Sprites y colores en este dispositivo"
							: "Opcional · incluido, funciona sin conexión"}
					</p>
				</div>
				<CompanionSwitch controls={controls} compact />
			</div>
			<details className="companion-persona-settings">
				<summary>Conversación · {settings.persona === "capri" ? "Capri" : "Gentle Dot"}</summary>
				<label className="capri-preference-row">
					<span>
						<strong>Personalidad Capri</strong>
						<small>
							{controls.connected
								? "Nombre y tono del agente. Se aplica en su siguiente respuesta."
								: "Conecta un agente para cambiar su personalidad. El tema sigue disponible."}
						</small>
					</span>
					<input
						type="checkbox"
						role="switch"
						aria-label="Personalidad Capri"
						checked={settings.persona === "capri"}
						aria-checked={settings.persona === "capri"}
						disabled={controls.pending || !controls.connected}
						onChange={(event) => void controls.setPersona(event.target.checked ? "capri" : "gentle")}
					/>
				</label>
				{controls.pending ? <p role="status">Confirmando con el agente…</p> : null}
			</details>
			{controls.error ? (
				<p role="alert">{controls.error}</p>
			) : controls.syncError ? (
				<p role="status">{controls.syncError}</p>
			) : null}
			{controls.storageFailed ? (
				<p role="status">Estos ajustes se conservarán mientras la app esté abierta.</p>
			) : null}
			{settings.mode === "capri" ? (
				<>
					{!desktop ? (
						<>
							<label className="capri-preference-row">
								<span>
									<strong>Visible sobre la app</strong>
									<small>Arrástrala o tócala para abrir sus controles.</small>
								</span>
								<input
									type="checkbox"
									role="switch"
									checked={settings.visible}
									aria-checked={settings.visible}
									onChange={(event) => change({ visible: event.target.checked, minimized: false })}
								/>
							</label>
							{settings.visible ? (
								<>
									<fieldset className="capri-preferences-mode" aria-label="Dónde se queda Capri">
										<button
											type="button"
											aria-pressed={!settings.pinned}
											onClick={() => change({ pinned: false })}
										>
											Libre
										</button>
										<button
											type="button"
											aria-pressed={settings.pinned}
											onClick={() => change({ pinned: true })}
										>
											Fija aquí
										</button>
									</fieldset>
									<p className="companion-help">
										{settings.pinned
											? "Se queda donde la pongas. Sigue gesticulando y reaccionando."
											: "Pasea dentro del área que elijas y se aparta mientras escribes."}
									</p>
									<details className="capri-area-details">
										<summary>Área donde puede estar</summary>
										<CompanionSpaceEditor
											rect={settings.space}
											onChange={(space) => change({ space })}
											label="Área de la pantalla"
											aspectRatio={3 / 4}
										/>
									</details>
								</>
							) : null}
						</>
					) : null}
					<details className="companion-ambience">
						<summary>{desktop ? "Colores de la app" : "Colores y animación"}</summary>
						{!desktop ? (
							<label className="capri-preference-row">
								<span>
									<strong>Animaciones</strong>
									<small>Gestos, reacciones y paseos.</small>
								</span>
								<input
									type="checkbox"
									role="switch"
									checked={settings.motion}
									aria-checked={settings.motion}
									onChange={(event) => change({ motion: event.target.checked })}
								/>
							</label>
						) : null}
						<label className="capri-preference-row">
							<span>Colores de la app</span>
							<select
								value={settings.ambience}
								onChange={(event) => change({ ambience: event.target.value as typeof settings.ambience })}
							>
								<option value="default">Original</option>
								<option value="hacker">Hacker · verde</option>
								<option value="afterlife">Afterlife · violeta</option>
								<option value="sunset">Atardecer · ámbar</option>
							</select>
						</label>
					</details>
				</>
			) : null}
		</section>
	);
}

/** Observes interaction events only; never reads or transmits a draft or screen content. */
export function CapriCompanion({
	controls,
	state,
	actionKind,
	connected,
	needsYou = false,
	speaking = false,
	onSettings,
	portalHost,
	attentionLabel,
	onAttention,
}: {
	controls: CompanionControls;
	state: AgentState;
	actionKind?: CapriActionKind;
	connected: boolean;
	sessions?: boolean;
	needsYou?: boolean;
	speaking?: boolean;
	onSettings?: () => void;
	portalHost?: HTMLElement;
	attentionLabel?: string;
	onAttention?(): void;
}) {
	const { settings } = controls;
	const [menu, setMenu] = useState(false);
	const handle = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLFieldSetElement>(null);
	const [menuSize, setMenuSize] = useState({ width: 240, height: 260 });
	const menuId = useId();
	const descriptionId = useId();
	const activity = useCompanionActivity(settings.visible && !settings.minimized);
	const interaction = activity.kind;
	const [outcome, setOutcome] = useState<{ kind: "done" | "error"; at: number }>();
	const [focused, setFocused] = useState(false);
	const [hovered, setHovered] = useState(false);
	const [awake, setAwake] = useState(() => !document.hidden);
	const previousBusy = useRef(false);
	const lastAmbience = useRef(settings.ambience);
	const [moodFlash, setMoodFlash] = useState<string>();
	useEffect(() => {
		if (lastAmbience.current === settings.ambience) return;
		lastAmbience.current = settings.ambience;
		setMoodFlash(settings.ambience);
		const timer = setTimeout(() => setMoodFlash(undefined), 6000);
		return () => clearTimeout(timer);
	}, [settings.ambience]);
	const [reducedMotion, setReducedMotion] = useState(
		() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	useEffect(() => {
		if (typeof matchMedia !== "function") return;
		const query = matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setReducedMotion(query.matches);
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	const alive = settings.motion && !reducedMotion && awake && !settings.minimized;
	const moving = alive && !settings.pinned && !focused && !hovered && !menu;
	useEffect(() => {
		const update = () => setAwake(!document.hidden);
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	useEffect(() => {
		const busy = state === "working" || state === "thinking";
		if (state === "error" || (previousBusy.current && state === "idle"))
			setOutcome({ kind: state === "error" ? "error" : "done", at: Date.now() });
		previousBusy.current = busy;
	}, [state]);
	useEffect(() => {
		if (!outcome) return;
		const timer = setTimeout(() => setOutcome(undefined), Math.max(0, outcome.at + CAPRI_OUTCOME_MS - Date.now()));
		return () => clearTimeout(timer);
	}, [outcome]);
	const attention = needsYou || state === "needs_you";
	const busy = state === "thinking" || state === "working";
	const behavior = capriBehavior({
		now: Date.now(),
		pendingQuestion: attention,
		outcome: interaction === "failed" ? { kind: "error", at: activity.at ?? Date.now() } : outcome,
		typingUntil: interaction === "typing" ? activity.expiresAt : undefined,
		agentWorking: busy || interaction === "sending" || interaction === "queued",
		actionKind: actionKind ?? (state === "thinking" ? "thinking" : undefined),
		reply: ["response", "reading", "submitted"].includes(interaction)
			? { kind: interaction === "submitted" ? "submitted" : "reply", at: activity.at ?? Date.now() } : undefined,
	});
	const pose = behavior.animation;

	const duo = pose.startsWith("duo-") || pose === "invite-rebecca";
	const character = duo ? "CAPRI + REBECCA" : pose.startsWith("rebecca-") ? "REBECCA" : "CAPRI";
	const message = !connected
		? "Esperando conexión con tu equipo"
		: attention
			? (attentionLabel ?? "Hay una pregunta para ti")
			: moodFlash
				? moodFlash === "hacker"
					? "Mood hacker. Verde encendido."
					: moodFlash === "afterlife"
						? "Neón violeta. Bienvenida a Afterlife."
						: moodFlash === "sunset"
							? "Bajamos las luces. Mood atardecer."
							: "De vuelta a nuestros colores."
				: interaction === "sending"
					? "Enviando… sigo al pendiente."
					: interaction === "queued"
						? "Está en cola. Espero contigo."
						: interaction === "failed"
							? "No se confirmó el envío. Tu mensaje sigue aquí."
							: interaction === "typing"
								? "Te escucho. A tu ritmo."
								: interaction === "greeting"
									? duo
										? sceneCaption(pose)
										: "Hey. ¿Qué hacemos hoy?"
									: busy && (pose === "face" || pose === "eyes" || pose === "thinking")
										? "En ello. Aquí sigo contigo."
										: sceneCaption(pose);
	const compact = pose === "eyes" || pose === "eyes-blink" || pose.startsWith("point-");
	const face = pose === "face" || pose === "face-talk";
	const naturalSize = settings.minimized
		? { width: 52, height: 52 }
		: compact
			? { width: 80, height: 60 }
			: face
				? { width: 80, height: 80 }
				: { width: duo ? 140 : 100, height: 108 };
	const floating = useCapriFloat({
		enabled: settings.visible,
		moving,
		pinned: settings.pinned,
		behaviorTarget: behavior.target,
		target: behavior.target === "editor" && interaction === "typing" ? activity.target
			: behavior.target === "attention-source" ? companionTarget(document.querySelector(".ask-card")) : undefined,
		space: settings.space,
		side: settings.side,
		size: naturalSize,
		position: settings.position,
		onPosition: (position) => controls.change({ position }),
	});
	const closeMenu = (restoreFocus = false) => {
		setMenu(false);
		if (restoreFocus) handle.current?.focus({ preventScroll: true });
	};
	useEffect(() => {
		if (!menu) return;
		menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
		const outside = (event: PointerEvent) => {
			if (
				event.target instanceof Node &&
				!menuRef.current?.contains(event.target) &&
				!handle.current?.contains(event.target)
			)
				setMenu(false);
		};
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			if (
				event.target instanceof Element &&
				event.target.closest("dialog[open], [aria-modal='true']") &&
				!menuRef.current?.contains(event.target) &&
				!handle.current?.contains(event.target)
			)
				return;
			event.preventDefault();
			event.stopPropagation();
			setMenu(false);
			handle.current?.focus({ preventScroll: true });
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", handleEscape);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", handleEscape);
		};
	}, [menu]);
	useLayoutEffect(() => {
		if (!menu || !menuRef.current) return;
		const element = menuRef.current;
		const measure = () => {
			const rect = element.getBoundingClientRect();
			setMenuSize((previous) =>
				previous.width === rect.width && previous.height === rect.height
					? previous
					: { width: rect.width, height: rect.height },
			);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [menu]);
	const { viewport, point, size } = floating;
	const menuLeft = Math.max(
		viewport.left + 8,
		Math.min(point.x, viewport.left + viewport.width - menuSize.width - 8),
	);
	const menuTop = Math.max(
		viewport.top + 8,
		Math.min(
			point.y + size.height + 8 + menuSize.height <= viewport.top + viewport.height - 8
				? point.y + size.height + 8
				: point.y - menuSize.height - 8,
			viewport.top + viewport.height - menuSize.height - 8,
		),
	);
	const captionVisible =
		!settings.minimized &&
		!floating.modalOpen &&
		!menu &&
		!floating.dragging &&
		(focused ||
			hovered ||
			speaking ||
			attention ||
			!!moodFlash ||
			["greeting", "submitted", "queued", "failed"].includes(interaction));
	const label =
		duo && !floating.compact
			? "Capri y Rebecca, tus acompañantes"
			: pose.startsWith("rebecca-")
				? "Rebecca, tu acompañante"
				: "Capri, tu acompañante";
	return createPortal(
		<aside
			className="capri-overlay"
			data-companion="capri"
			data-ambience={settings.ambience}
			aria-label={label}
			data-motion={moving && !floating.modalOpen && !floating.dragging}
			data-attention={attention}
			data-activity={interaction}
			data-duo={duo && !floating.compact}
			data-form={compact || floating.compact ? "glimpse" : face ? "face" : "body"}
			data-minimized={settings.minimized}
		>
			<div
				className="capri-float"
				ref={floating.floatRef}
				data-travelling={floating.travelling}
				data-dragging={floating.dragging}
				style={{
					width: size.width,
					height: size.height,
					transform: `translate3d(${point.x}px, ${point.y}px, 0)`,
				}}
			>
				<button
					ref={handle}
					onMouseEnter={() => {
						floating.freeze();
						setHovered(true);
					}}
					onMouseLeave={() => setHovered(false)}
					onFocusCapture={() => {
						floating.freeze();
						setFocused(true);
					}}
					onBlurCapture={(event) => {
						if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
					}}
					type="button"
					className="capri-drag-handle"
					aria-label={settings.minimized ? "Mostrar a Capri" : "Mover a Capri"}
					aria-describedby={descriptionId}
					aria-expanded={menu}
					aria-controls={menu ? menuId : undefined}
					title={settings.minimized ? "Mostrar a Capri" : "Arrastra para mover · Toca para interactuar"}
					{...floating.dragProps}
					onKeyDown={floating.handleKeyDown}
					onClick={() =>
						settings.minimized ? controls.change({ minimized: false }) : setMenu((value) => !value)
					}
				>
					<MobileAtlas
						behavior={behavior}
						playing={alive && !floating.dragging}
						fallback={<CapriSprite
							pose={settings.minimized || floating.compact ? "eyes" : pose}
							animated
							playing={alive && !floating.dragging}
							walking={floating.travelling && !compact && !face && !duo && !attention}
						/>}
					/>
				</button>
				<span id={descriptionId} className="capri-sr-only">
					{message}. Arrastra o usa las flechas para mover. Toca para abrir los controles.
				</span>
				<div
					className="capri-speech"
					aria-hidden={!captionVisible}
					data-actionable={attention && !!onAttention}
					data-visible={captionVisible}
					data-align={point.x > viewport.left + viewport.width / 2 ? "right" : "left"}
					data-below={point.y < viewport.top + 100}
				>
					{message}
					{attention && onAttention ? (
						<button type="button" tabIndex={captionVisible ? 0 : -1} onClick={onAttention}>
							Ver pregunta
						</button>
					) : null}
				</div>
			</div>
			{menu ? (
				<fieldset
					ref={menuRef}
					id={menuId}
					aria-label="Controles de Capri"
					className="capri-bubble-menu"
					style={{
						left: menuLeft,
						top: menuTop,
						maxHeight: Math.max(80, viewport.height - 16),
						maxWidth: Math.max(48, viewport.width - 16),
					}}
				>
					<div className="capri-menu-heading">
						<strong>{character}</strong>
						<button type="button" aria-label="Cerrar controles de Capri" onClick={() => closeMenu(true)}>
							×
						</button>
					</div>
					<p>{message}</p>
					<button
						type="button"
						onClick={() => {
							floating.nudge(
								point.x > viewport.left + viewport.width / 2 ? -viewport.width : viewport.width,
								0,
							);
							closeMenu();
						}}
					>
						Hazte a un lado
					</button>
					<button
						type="button"
						onClick={() => {
							controls.change({ pinned: !settings.pinned });
							closeMenu();
						}}
					>
						{settings.pinned ? "Dejar pasear" : "Fijar aquí"}
					</button>
					<button
						type="button"
						onClick={() => {
							controls.change({ minimized: true });
							closeMenu(true);
						}}
					>
						Ocultar a Capri
					</button>
					{onSettings ? (
						<button
							type="button"
							onClick={() => {
								closeMenu();
								onSettings();
							}}
						>
							Ajustes de Capri
						</button>
					) : null}
				</fieldset>
			) : null}
		</aside>,
		portalHost ?? document.body,
	);
}
