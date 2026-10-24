import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type CompanionSpaceRect, FULL_COMPANION_SPACE, normalizeCompanionSpace } from "./companion-space.ts";

export interface FloatPoint {
	x: number;
	y: number;
}
export interface FloatSize {
	width: number;
	height: number;
}
/** Usable layout-viewport coordinates, already inset from screen cutouts. */
export interface FloatViewport extends FloatSize {
	left: number;
	top: number;
}
interface Options {
	enabled: boolean;
	moving: boolean;
	pinned?: boolean;
	/** Actual input/message geometry, local to this document. Never a screen estimate. */
	target?: { x: number; y: number; width: number; height: number };
	space?: CompanionSpaceRect;
	side: "auto" | "left" | "right";
	size: FloatSize;
	naturalSize?: FloatSize;
	position: FloatPoint | null;
	onPosition(position: FloatPoint): void;
}
const finite = (value: number, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const unit = (value: number) => Math.min(1, Math.max(0, finite(value)));
export function companionBounds(viewport: FloatViewport, space = FULL_COMPANION_SPACE): FloatViewport {
	const area = normalizeCompanionSpace(space);
	return {
		left: viewport.left + area.x * viewport.width,
		top: viewport.top + area.y * viewport.height,
		width: area.width * viewport.width,
		height: area.height * viewport.height,
	};
}
const ranges = (viewport: FloatViewport, size: FloatSize) => ({
	x: Math.max(0, viewport.width - Math.max(0, finite(size.width))),
	y: Math.max(0, viewport.height - Math.max(0, finite(size.height))),
});
function fittedSize(viewport: FloatViewport, requested: FloatSize): FloatSize {
	const scale = Math.min(1, viewport.width / requested.width, viewport.height / requested.height);
	return { width: requested.width * scale, height: requested.height * scale };
}
export function clampFloat(point: FloatPoint, viewport: FloatViewport, size: FloatSize): FloatPoint {
	const range = ranges(viewport, size);
	return {
		x: Math.min(viewport.left + range.x, Math.max(viewport.left, finite(point.x, viewport.left))),
		y: Math.min(viewport.top + range.y, Math.max(viewport.top, finite(point.y, viewport.top))),
	};
}
export function normalizeFloat(point: FloatPoint, viewport: FloatViewport, size: FloatSize): FloatPoint {
	const bounded = clampFloat(point, viewport, size);
	const range = ranges(viewport, size);
	return {
		x: range.x ? unit((bounded.x - viewport.left) / range.x) : 0,
		y: range.y ? unit((bounded.y - viewport.top) / range.y) : 0,
	};
}
function locate(point: FloatPoint, viewport: FloatViewport, size: FloatSize): FloatPoint {
	const range = ranges(viewport, size);
	return { x: viewport.left + unit(point.x) * range.x, y: viewport.top + unit(point.y) * range.y };
}
const home = (side: Options["side"]): FloatPoint => ({ x: side === "left" ? 0 : 1, y: 0.48 });
function measureViewport(probe?: HTMLElement): FloatViewport {
	const visual = window.visualViewport;
	const style = probe ? getComputedStyle(probe) : undefined;
	const inset = (value?: string) => Math.max(8, finite(Number.parseFloat(value ?? "0")));
	const left = inset(style?.paddingLeft),
		right = inset(style?.paddingRight);
	const top = inset(style?.paddingTop),
		bottom = inset(style?.paddingBottom);
	return {
		left: (visual?.offsetLeft ?? 0) + left,
		top: (visual?.offsetTop ?? 0) + top,
		width: Math.max(0, (visual?.width ?? window.innerWidth) - left - right),
		height: Math.max(0, (visual?.height ?? window.innerHeight) - top - bottom),
	};
}
function activeModal(): HTMLDialogElement | undefined {
	const dialogs = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].filter((dialog) => {
		try {
			return dialog.matches(":modal");
		} catch {
			return dialog.open;
		}
	});
	const focused = document.activeElement?.closest("dialog");
	return dialogs.find((dialog) => dialog === focused) ?? dialogs.at(-1);
}
interface AvoidBox {
	left: number;
	top: number;
	right: number;
	bottom: number;
}
const overlapArea = (point: FloatPoint, size: FloatSize, box: AvoidBox) =>
	Math.max(0, Math.min(point.x + size.width, box.right) - Math.max(point.x, box.left)) *
	Math.max(0, Math.min(point.y + size.height, box.bottom) - Math.max(point.y, box.top));
const protectedBox = (rect: DOMRect): AvoidBox => ({
	left: rect.left - 12,
	top: rect.top - 12,
	right: rect.right + 12,
	bottom: rect.bottom + 12,
});
function avoidFocus(
	point: FloatPoint,
	viewport: FloatViewport,
	size: FloatSize,
	modal = activeModal(),
): FloatPoint {
	const active = document.activeElement;
	const elements = new Set<HTMLElement>(document.querySelectorAll(".composer, .agent-composer"));
	if (
		active instanceof HTMLElement &&
		!active.closest(".capri-overlay") &&
		active.matches(
			"input, textarea, select, button, a[href], [tabindex], [contenteditable='true'], [role='textbox']",
		)
	)
		elements.add(active.closest<HTMLElement>(".composer, .agent-composer") ?? active);
	// Full-screen dialogs have no outside margin. Prefer their quiet edges and keep actions,
	// headings and text clear instead of remaining in the middle of the question.
	if (modal)
		for (const element of modal.querySelectorAll<HTMLElement>(
			"button, input, textarea, select, a[href], h1, h2, h3, h4, legend, p, .ask-title, .ask-message",
		)) {
			if (!element.closest("[data-companion-layer], .capri-overlay")) elements.add(element);
		}
	const boxes = [...elements]
		.map((element) => element.getBoundingClientRect())
		.filter((rect) => rect.width > 0 && rect.height > 0)
		.map(protectedBox);
	const dialogBox = modal ? protectedBox(modal.getBoundingClientRect()) : undefined;
	const overlap = (p: FloatPoint) => boxes.reduce((total, box) => total + overlapArea(p, size, box), 0);
	const modalOverlap = (p: FloatPoint) => (dialogBox ? overlapArea(p, size, dialogBox) : 0);
	if (!overlap(point) && !modalOverlap(point)) return point;
	const right = viewport.left + Math.max(0, viewport.width - size.width);
	const bottom = viewport.top + Math.max(0, viewport.height - size.height);
	const candidates = [
		point,
		...[...boxes, ...(dialogBox ? [dialogBox] : [])].flatMap((box) => [
			{ x: point.x, y: box.top - size.height },
			{ x: point.x, y: box.bottom },
			{ x: box.left - size.width, y: point.y },
			{ x: box.right, y: point.y },
		]),
		{ x: viewport.left, y: viewport.top },
		{ x: right, y: viewport.top },
		{ x: viewport.left, y: bottom },
		{ x: right, y: bottom },
	].map((p) => clampFloat(p, viewport, size));
	const edgeDistance = (p: FloatPoint) =>
		dialogBox ? Math.min(p.x - viewport.left, right - p.x, p.y - viewport.top, bottom - p.y) : 0;
	return (
		candidates.sort(
			(a, b) =>
				overlap(a) - overlap(b) ||
				modalOverlap(a) - modalOverlap(b) ||
				edgeDistance(a) - edgeDistance(b) ||
				Math.hypot(a.x - point.x, a.y - point.y) - Math.hypot(b.x - point.x, b.y - point.y),
		)[0] ?? point
	);
}

interface Drag {
	id: number;
	target: HTMLElement;
	start: FloatPoint;
	pointer: FloatPoint;
	crossed: boolean;
}

/** Local geometry only: never reads input values, transmits drafts, or moves focus. */
export function useCapriFloat(options: Options) {
	const latest = useRef(options);
	latest.current = options;
	const initialViewport = useRef<FloatViewport>(measureViewport());
	const anchor = useRef<FloatPoint>(options.position ?? home(options.side));
	const [viewport, setViewport] = useState(initialViewport.current);
	const bounds = useRef(companionBounds(viewport, options.space));
	const [point, setPoint] = useState(() => locate(anchor.current, bounds.current, options.size));
	const current = useRef(point);
	const sizeRef = useRef(options.size);
	const [size, setSize] = useState(options.size);
	const [modalState, setModalState] = useState({ modalOpen: false, compact: false });
	const modalRef = useRef<HTMLDialogElement | undefined>(undefined);
	const beforeModal = useRef<FloatPoint | undefined>(undefined);
	const modalResize = useRef<ResizeObserver | undefined>(undefined);
	const [dragging, setDragging] = useState(false);
	const [travelling, setTravelling] = useState(false);
	const travellingNow = useRef(false);
	const travelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const floatRef = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(() => !document.hidden);
	const drag = useRef<Drag | undefined>(undefined);
	const frame = useRef<number | undefined>(undefined);
	const cooldown = useRef(0);
	const suppressClick = useRef(false);
	const probe = useRef<HTMLElement | undefined>(undefined);
	const walk = useRef(0);
	const paint = useCallback((next: FloatPoint, immediate = false) => {
		current.current = next;
		if (immediate) {
			if (frame.current !== undefined) cancelAnimationFrame(frame.current);
			frame.current = undefined;
			setPoint((previous) => (previous.x === next.x && previous.y === next.y ? previous : next));
		} else if (frame.current === undefined && !document.hidden) {
			frame.current = requestAnimationFrame(() => {
				frame.current = undefined;
				const value = current.current;
				setPoint((previous) => (previous.x === value.x && previous.y === value.y ? previous : value));
			});
		}
	}, []);
	const travel = useCallback((value: boolean) => {
		clearTimeout(travelTimer.current);
		travelTimer.current = undefined;
		travellingNow.current = value;
		setTravelling(value);
		// Match the 1400ms transform transition, with a small allowance for its first paint.
		// The walk cycle must stop even if the browser omits transitionend.
		if (value)
			travelTimer.current = setTimeout(() => {
				travellingNow.current = false;
				setTravelling(false);
				travelTimer.current = undefined;
			}, 1500);
	}, []);
	/** Read the rendered position before removing the CSS transition. */
	const freeze = useCallback(() => {
		const rect = floatRef.current?.getBoundingClientRect();
		const visual =
			rect && rect.width > 0 && rect.height > 0 && Number.isFinite(rect.left) && Number.isFinite(rect.top)
				? { x: rect.left, y: rect.top }
				: current.current;
		const next = clampFloat(visual, bounds.current, sizeRef.current);
		anchor.current = normalizeFloat(next, bounds.current, sizeRef.current);
		travel(false);
		paint(next, true);
	}, [paint, travel]);
	const previousMoving = useRef(options.moving);
	const previousPinned = useRef(options.pinned);
	useLayoutEffect(() => {
		if (options.pinned && !previousPinned.current) {
			freeze();
			const config = latest.current;
			let saved = anchor.current;
			if (modalRef.current) {
				// The modal's compact sprite has different normalized coordinates. Save the
				// chosen place for the normal sprite, while retaining its protected live position.
				const normalSize = fittedSize(bounds.current, config.naturalSize ?? config.size);
				saved = normalizeFloat(current.current, bounds.current, normalSize);
				beforeModal.current = saved;
			}
			config.onPosition(saved);
		}
		previousPinned.current = options.pinned;
	}, [options.pinned, freeze]);
	useLayoutEffect(() => {
		if (previousMoving.current && !options.moving) freeze();
		previousMoving.current = options.moving;
	}, [options.moving, freeze]);
	const release = useCallback((value: Drag) => {
		try {
			if (value.target.hasPointerCapture?.(value.id)) value.target.releasePointerCapture(value.id);
		} catch {
			/* Pointer already ended. */
		}
	}, []);
	const cancel = useCallback(() => {
		const value = drag.current;
		if (!value) return;
		drag.current = undefined;
		release(value);
		if (value.crossed) {
			cooldown.current = Date.now() + 60_000;
			suppressClick.current = true;
		}
		travel(false);
		const start = clampFloat(value.start, bounds.current, sizeRef.current);
		anchor.current = normalizeFloat(start, bounds.current, sizeRef.current);
		paint(start, true);
		setDragging(false);
	}, [paint, release, travel]);
	const refresh = useCallback(() => {
		if (document.hidden || !latest.current.enabled) return;
		if (!drag.current && travellingNow.current) freeze();
		const measured = measureViewport(probe.current);
		const next = companionBounds(measured, latest.current.space);
		const sameBounds =
			bounds.current.left === next.left &&
			bounds.current.top === next.top &&
			bounds.current.width === next.width &&
			bounds.current.height === next.height;
		bounds.current = next;
		setViewport((previous) =>
			previous.left === measured.left &&
			previous.top === measured.top &&
			previous.width === measured.width &&
			previous.height === measured.height
				? previous
				: measured,
		);
		const modal = activeModal();
		const modalChanged = modal !== modalRef.current;
		if (modalChanged) {
			if (drag.current) cancel();
			if (modal && !modalRef.current) beforeModal.current = { ...anchor.current };
			if (!modal && beforeModal.current) {
				anchor.current = beforeModal.current;
				beforeModal.current = undefined;
			}
			modalRef.current = modal;
			modalResize.current?.disconnect();
			if (modal) modalResize.current?.observe(modal);
		}
		const naturalSize = fittedSize(next, latest.current.naturalSize ?? latest.current.size);
		const natural = avoidFocus(locate(anchor.current, next, naturalSize), next, naturalSize, modal);
		const compact = Boolean(
			modal && overlapArea(natural, naturalSize, protectedBox(modal.getBoundingClientRect())) > 0,
		);
		const actualSize = compact
			? { width: Math.min(80, naturalSize.width), height: Math.min(60, naturalSize.height) }
			: naturalSize;
		sizeRef.current = actualSize;
		setSize((previous) =>
			previous.width === actualSize.width && previous.height === actualSize.height ? previous : actualSize,
		);
		setModalState((previous) =>
			previous.modalOpen === Boolean(modal) && previous.compact === compact
				? previous
				: { modalOpen: Boolean(modal), compact },
		);
		const desired =
			drag.current || (latest.current.pinned && sameBounds && !modal && !modalChanged)
				? clampFloat(current.current, next, actualSize)
				: avoidFocus(locate(anchor.current, next, actualSize), next, actualSize, modal);
		travel(false);
		paint(desired, true);
	}, [cancel, freeze, paint, travel]);
	useLayoutEffect(() => {
		if (!options.enabled) {
			freeze();
			cancel();
			setDragging(false);
			return;
		}
		setVisible(!document.hidden);
		const element = document.createElement("div");
		element.setAttribute("aria-hidden", "true");
		element.style.cssText =
			"position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;" +
			"padding-top:var(--safe-area-inset-top,env(safe-area-inset-top,0px));padding-right:var(--safe-area-inset-right,env(safe-area-inset-right,0px));" +
			"padding-bottom:var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px));padding-left:var(--safe-area-inset-left,env(safe-area-inset-left,0px));";
		document.body.append(element);
		probe.current = element;
		if (typeof ResizeObserver === "function") modalResize.current = new ResizeObserver(refresh);
		refresh();
		const modalChanges = new MutationObserver((records) => {
			if (
				records.some(
					(record) =>
						record.target instanceof HTMLDialogElement ||
						[...record.addedNodes, ...record.removedNodes].some(
							(node) => node instanceof Element && (node.matches("dialog") || node.querySelector("dialog")),
						),
				)
			)
				refresh();
		});
		modalChanges.observe(document.body, {
			attributes: true,
			attributeFilter: ["open"],
			childList: true,
			subtree: true,
		});
		const visibility = () => {
			setVisible(!document.hidden);
			if (document.hidden) {
				if (drag.current) cancel();
				else freeze();
				if (frame.current !== undefined) cancelAnimationFrame(frame.current);
				frame.current = undefined;
			} else refresh();
		};
		const visual = window.visualViewport;
		visual?.addEventListener("resize", refresh);
		visual?.addEventListener("scroll", refresh);
		window.addEventListener("resize", refresh);
		document.addEventListener("focusin", refresh);
		document.addEventListener("input", refresh);
		document.addEventListener("visibilitychange", visibility);
		return () => {
			clearTimeout(travelTimer.current);
			modalChanges.disconnect();
			modalResize.current?.disconnect();
			modalResize.current = undefined;
			visual?.removeEventListener("resize", refresh);
			visual?.removeEventListener("scroll", refresh);
			window.removeEventListener("resize", refresh);
			document.removeEventListener("focusin", refresh);
			document.removeEventListener("input", refresh);
			document.removeEventListener("visibilitychange", visibility);
			element.remove();
			probe.current = undefined;
			if (frame.current !== undefined) cancelAnimationFrame(frame.current);
			frame.current = undefined;
			const value = drag.current;
			drag.current = undefined;
			if (value) release(value);
		};
	}, [options.enabled, cancel, freeze, refresh, release]);
	const positionX = options.position?.x;
	const positionY = options.position?.y;
	useLayoutEffect(() => {
		const config = latest.current;
		const nextAnchor =
			positionX === undefined || positionY === undefined
				? home(config.side)
				: { x: unit(positionX), y: unit(positionY) };
		if (modalRef.current) {
			// A persisted pin can be echoed synchronously by the settings owner. Applying
			// its normal-size coordinates to the compact sprite would jump into the dialog.
			beforeModal.current = nextAnchor;
			return;
		}
		anchor.current = nextAnchor;
		if (config.enabled && !document.hidden && !drag.current) {
			travel(false);
			paint(locate(anchor.current, bounds.current, sizeRef.current), true);
		}
	}, [positionX, positionY, paint, travel]);
	const previousSide = useRef(options.side);
	// biome-ignore lint/correctness/useExhaustiveDependencies: A changed sprite size must remeasure; refresh reads the latest size through its ref.
	useLayoutEffect(() => {
		if (previousSide.current !== options.side) {
			previousSide.current = options.side;
			anchor.current = { ...anchor.current, x: home(options.side).x };
		}
		refresh();
	}, [
		options.side,
		options.size.width,
		options.size.height,
		options.naturalSize?.width,
		options.naturalSize?.height,
		options.space?.x,
		options.space?.y,
		options.space?.width,
		options.space?.height,
		options.pinned,
		refresh,
	]);
	useEffect(() => {
		if (!options.enabled || !options.moving || options.pinned || !visible) return;
		const interval = window.setInterval(() => {
			const config = latest.current;
			if (
				document.hidden ||
				drag.current ||
				modalRef.current ||
				config.target ||
				Date.now() < cooldown.current
			)
				return;
			walk.current++;
			anchor.current = {
				x: config.side === "auto" ? (anchor.current.x >= 0.5 ? 0 : 1) : config.side === "left" ? 0 : 1,
				y: [0.18, 0.42, 0.64, 0.3][walk.current % 4] ?? 0.48,
			};
			travel(true);
			paint(
				avoidFocus(locate(anchor.current, bounds.current, sizeRef.current), bounds.current, sizeRef.current),
			);
		}, 20_000);
		return () => window.clearInterval(interval);
	}, [options.enabled, options.moving, options.pinned, visible, paint, travel]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Target geometry and movement gates are read through latest to avoid stale pointer state.
	useEffect(() => {
		const config = latest.current,
			target = config.target;
		if (
			!config.enabled ||
			!config.moving ||
			config.pinned ||
			!visible ||
			!target ||
			drag.current ||
			modalRef.current ||
			Date.now() < cooldown.current ||
			![target.x, target.y, target.width, target.height].every(Number.isFinite) ||
			target.width <= 0 ||
			target.height <= 0
		)
			return;
		const size = sizeRef.current,
			area = bounds.current;
		const protectedTarget = {
			left: target.x - 12,
			top: target.y - 12,
			right: target.x + target.width + 12,
			bottom: target.y + target.height + 12,
		};
		const candidates = [
			{ x: target.x + target.width - size.width, y: target.y - size.height - 14 },
			{ x: target.x + target.width + 14, y: target.y - size.height / 2 },
			{ x: target.x - size.width - 14, y: target.y - size.height / 2 },
		].map((p) => avoidFocus(clampFloat(p, area, size), area, size));
		const next = candidates.sort(
			(a, b) =>
				overlapArea(a, size, protectedTarget) - overlapArea(b, size, protectedTarget) ||
				Math.hypot(a.x - target.x, a.y - target.y) - Math.hypot(b.x - target.x, b.y - target.y),
		)[0];
		if (!next || Math.hypot(next.x - current.current.x, next.y - current.current.y) < 4) return;
		anchor.current = normalizeFloat(next, area, size);
		travel(true);
		paint(next);
	}, [
		options.target?.x,
		options.target?.y,
		options.target?.width,
		options.target?.height,
		options.moving,
		options.enabled,
		options.pinned,
		visible,
		paint,
		travel,
	]);
	const commit = useCallback(
		(value: FloatPoint) => {
			const config = latest.current;
			const next = avoidFocus(
				clampFloat(value, bounds.current, sizeRef.current),
				bounds.current,
				sizeRef.current,
			);
			anchor.current = normalizeFloat(next, bounds.current, sizeRef.current);
			cooldown.current = Date.now() + 60_000;
			travel(false);
			paint(next, true);
			if (!modalRef.current) config.onPosition(anchor.current);
		},
		[paint, travel],
	);
	const move = useCallback(
		(event: PointerEvent<HTMLElement>) => {
			const value = drag.current;
			if (!value || value.id !== event.pointerId) return;
			const dx = event.clientX - value.pointer.x,
				dy = event.clientY - value.pointer.y;
			if (!value.crossed && Math.hypot(dx, dy) < 6) return;
			if (!value.crossed) {
				value.crossed = true;
				setDragging(true);
			}
			event.preventDefault();
			paint(clampFloat({ x: value.start.x + dx, y: value.start.y + dy }, bounds.current, sizeRef.current));
		},
		[paint],
	);
	const nudge = useCallback(
		(dx: number, dy: number) => {
			if (!latest.current.enabled || document.hidden || drag.current) return;
			freeze();
			commit({ x: current.current.x + finite(dx), y: current.current.y + finite(dy) });
		},
		[commit, freeze],
	);
	return {
		point,
		size,
		...modalState,
		viewport,
		dragging,
		travelling,
		floatRef,
		freeze,
		nudge,
		dragProps: {
			onPointerDown(event: PointerEvent<HTMLElement>) {
				if (
					!latest.current.enabled ||
					document.hidden ||
					drag.current ||
					event.isPrimary === false ||
					event.button !== 0
				)
					return;
				freeze();
				suppressClick.current = false;
				drag.current = {
					id: event.pointerId,
					target: event.currentTarget,
					start: current.current,
					pointer: { x: event.clientX, y: event.clientY },
					crossed: false,
				};
				try {
					event.currentTarget.setPointerCapture(event.pointerId);
				} catch {
					/* Older test/browser surface. */
				}
			},
			onPointerMove: move,
			onPointerUp(event: PointerEvent<HTMLElement>) {
				const value = drag.current;
				if (!value || value.id !== event.pointerId) return;
				move(event);
				drag.current = undefined;
				release(value);
				setDragging(false);
				if (value.crossed) {
					suppressClick.current = true;
					commit(current.current);
				}
			},
			onPointerCancel(event: PointerEvent<HTMLElement>) {
				if (drag.current?.id === event.pointerId) cancel();
			},
			onLostPointerCapture(event: PointerEvent<HTMLElement>) {
				if (drag.current?.id === event.pointerId) cancel();
			},
			onClickCapture(event: MouseEvent<HTMLElement>) {
				if (suppressClick.current && event.detail !== 0) {
					suppressClick.current = false;
					event.preventDefault();
					event.stopPropagation();
				}
			},
		},
		handleKeyDown(event: KeyboardEvent<HTMLElement>) {
			if (!latest.current.enabled || document.hidden || event.altKey || event.ctrlKey || event.metaKey)
				return;
			const step = event.shiftKey ? 64 : 24;
			const delta: Record<string, FloatPoint> = {
				ArrowLeft: { x: -step, y: 0 },
				ArrowRight: { x: step, y: 0 },
				ArrowUp: { x: 0, y: -step },
				ArrowDown: { x: 0, y: step },
			};
			const direction = delta[event.key];
			if (!direction && event.key !== "Home") return;
			event.preventDefault();
			event.stopPropagation();
			if (event.key === "Home") commit(locate(home(latest.current.side), bounds.current, sizeRef.current));
			else if (direction) nudge(direction.x, direction.y);
		},
	};
}
