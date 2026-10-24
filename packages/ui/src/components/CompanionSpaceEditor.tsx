import { type KeyboardEvent, type PointerEvent, useEffect, useId, useRef, useState } from "react";
import {
	type CompanionSpaceRect,
	FULL_COMPANION_SPACE,
	normalizeCompanionSpace,
} from "../companion-space.ts";
import "../companion-space.css";

export {
	type CompanionSpaceRect,
	FULL_COMPANION_SPACE,
	normalizeCompanionSpace,
} from "../companion-space.ts";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
type Gesture = {
	id: number;
	kind: "move" | "resize";
	x: number;
	y: number;
	width: number;
	height: number;
	rect: CompanionSpaceRect;
	current: CompanionSpaceRect;
	moved: boolean;
	target: HTMLButtonElement;
};

/** A local preview commits once per gesture; the owner confirms and persists the resulting area. */
export function CompanionSpaceEditor({
	rect,
	onChange,
	label = "Espacio para Capri",
	disabled = false,
	aspectRatio = 16 / 9,
}: {
	rect: CompanionSpaceRect;
	onChange(rect: CompanionSpaceRect): void;
	label?: string;
	disabled?: boolean;
	aspectRatio?: number;
}) {
	const hint = useId();
	const ratio = clamp(finite(aspectRatio, 16 / 9), 0.3, 4);
	const map = useRef<HTMLDivElement>(null);
	const gesture = useRef<Gesture | undefined>(undefined);
	const [preview, setPreview] = useState(() => normalizeCompanionSpace(rect));
	const [dragging, setDragging] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Native updates can replace the rect object without changing its coordinates; only geometry or disabled changes cancel a gesture.
	useEffect(() => {
		const active = gesture.current;
		gesture.current = undefined;
		try {
			if (active?.target.hasPointerCapture?.(active.id)) active.target.releasePointerCapture(active.id);
		} catch {
			/* Capture already released. */
		}
		setDragging(false);
		setPreview(normalizeCompanionSpace(rect));
	}, [rect.x, rect.y, rect.width, rect.height, disabled]);
	const apply = (next: CompanionSpaceRect) => {
		if (disabled) return;
		const value = normalizeCompanionSpace(next);
		setPreview(value);
		onChange(value);
	};
	const start = (event: PointerEvent<HTMLButtonElement>, kind: Gesture["kind"]) => {
		if (disabled || event.button !== 0 || event.isPrimary === false) return;
		const bounds = map.current?.getBoundingClientRect();
		if (!bounds?.width || !bounds.height) return;
		event.stopPropagation();
		gesture.current = {
			id: event.pointerId,
			kind,
			x: event.clientX,
			y: event.clientY,
			width: bounds.width,
			height: bounds.height,
			rect: preview,
			current: preview,
			moved: false,
			target: event.currentTarget,
		};
		setDragging(true);
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			/* Older embedded browser. */
		}
	};
	const move = (event: PointerEvent<HTMLButtonElement>) => {
		const active = gesture.current;
		if (!active || active.id !== event.pointerId) return;
		if (!active.moved && Math.hypot(event.clientX - active.x, event.clientY - active.y) < 4) return;
		active.moved = true;
		const dx = (event.clientX - active.x) / active.width;
		const dy = (event.clientY - active.y) / active.height;
		active.current = normalizeCompanionSpace(
			active.kind === "move"
				? { ...active.rect, x: active.rect.x + dx, y: active.rect.y + dy }
				: {
						...active.rect,
						width: clamp(active.rect.width + dx, 0.2, 1 - active.rect.x),
						height: clamp(active.rect.height + dy, 0.2, 1 - active.rect.y),
					},
		);
		setPreview(active.current);
	};
	const finish = (commit: boolean) => {
		const active = gesture.current;
		if (!active) return;
		gesture.current = undefined;
		setDragging(false);
		try {
			if (active.target.hasPointerCapture?.(active.id)) active.target.releasePointerCapture(active.id);
		} catch {
			/* Capture already released. */
		}
		if (commit && active.moved) apply(active.current);
		else setPreview(normalizeCompanionSpace(rect));
	};
	const keys = (event: KeyboardEvent<HTMLButtonElement>, kind: Gesture["kind"]) => {
		if (disabled) return;
		if (event.key === "Escape" && gesture.current) {
			event.preventDefault();
			event.stopPropagation();
			finish(false);
			return;
		}
		if (!event.key.startsWith("Arrow")) return;
		event.preventDefault();
		event.stopPropagation();
		const step = event.shiftKey ? 0.1 : 0.025;
		const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
		const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
		apply(
			kind === "move"
				? { ...preview, x: preview.x + dx, y: preview.y + dy }
				: {
						...preview,
						width: clamp(preview.width + dx, 0.2, 1 - preview.x),
						height: clamp(preview.height + dy, 0.2, 1 - preview.y),
					},
		);
	};
	const changeSize = (delta: number) => {
		const width = clamp(preview.width + delta, 0.2, 1);
		const height = clamp(preview.height + delta, 0.2, 1);
		apply({
			width,
			height,
			x: preview.x + (preview.width - width) / 2,
			y: preview.y + (preview.height - height) / 2,
		});
	};
	return (
		<fieldset className="companion-space-editor" aria-label={label} data-disabled={disabled}>
			<fieldset className="companion-space-presets" aria-label="Zonas rápidas">
				{(
					[
						["Toda la pantalla", FULL_COMPANION_SPACE],
						["Izquierda", { x: 0, y: 0, width: 0.5, height: 1 }],
						["Derecha", { x: 0.5, y: 0, width: 0.5, height: 1 }],
					] as const
				).map(([name, value]) => (
					<button
						key={name}
						type="button"
						disabled={disabled}
						onClick={() => apply(value)}
						aria-pressed={Object.keys(value).every(
							(key) =>
								Math.abs(preview[key as keyof CompanionSpaceRect] - value[key as keyof CompanionSpaceRect]) <
								0.001,
						)}
					>
						{name}
					</button>
				))}
			</fieldset>
			<div
				ref={map}
				className="companion-space-map"
				data-dragging={dragging}
				style={{ aspectRatio: ratio, maxWidth: `${ratio * 320}px` }}
			>
				<button
					type="button"
					className="companion-space-target"
					aria-label="Situar zona en el mapa"
					aria-describedby={hint}
					disabled={disabled}
					onClick={(event) => {
						const bounds = map.current?.getBoundingClientRect();
						if (!bounds) return;
						if (!bounds.width || !bounds.height) return;
						apply({
							...preview,
							x:
								event.detail === 0
									? 0.5 - preview.width / 2
									: (event.clientX - bounds.left) / bounds.width - preview.width / 2,
							y:
								event.detail === 0
									? 0.5 - preview.height / 2
									: (event.clientY - bounds.top) / bounds.height - preview.height / 2,
						});
					}}
				/>
				<div
					className="companion-space-selection"
					style={{
						left: `${preview.x * 100}%`,
						top: `${preview.y * 100}%`,
						width: `${preview.width * 100}%`,
						height: `${preview.height * 100}%`,
					}}
				>
					<button
						type="button"
						className="companion-space-drag"
						disabled={disabled}
						aria-label="Mover la zona permitida"
						aria-describedby={hint}
						onPointerDown={(event) => start(event, "move")}
						onPointerMove={move}
						onPointerUp={(event) => {
							if (gesture.current?.id === event.pointerId) finish(true);
						}}
						onPointerCancel={(event) => {
							if (gesture.current?.id === event.pointerId) finish(false);
						}}
						onLostPointerCapture={(event) => {
							if (gesture.current?.id === event.pointerId) finish(false);
						}}
						onKeyDown={(event) => keys(event, "move")}
					>
						<svg
							aria-hidden="true"
							className="companion-space-mark"
							width="24"
							height="24"
							viewBox="0 0 24 24"
						>
							<path
								d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6Z"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.6"
								strokeLinejoin="round"
							/>
						</svg>
						<span className="companion-space-zone-label" aria-hidden="true">
							Su espacio
						</span>
					</button>
					<button
						type="button"
						className="companion-space-resize"
						disabled={disabled}
						aria-label="Cambiar tamaño de la zona"
						aria-describedby={hint}
						onPointerDown={(event) => start(event, "resize")}
						onPointerMove={move}
						onPointerUp={(event) => {
							if (gesture.current?.id === event.pointerId) finish(true);
						}}
						onPointerCancel={(event) => {
							if (gesture.current?.id === event.pointerId) finish(false);
						}}
						onLostPointerCapture={(event) => {
							if (gesture.current?.id === event.pointerId) finish(false);
						}}
						onKeyDown={(event) => keys(event, "resize")}
					>
						<svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20">
							<path
								d="m7 15 8-8m-3 8 3-3"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
							/>
						</svg>
					</button>
				</div>
			</div>
			<div className="companion-space-footer">
				<p id={hint}>
					Arrastra la zona o toca el mapa para moverla. Usa la esquina para ajustar su tamaño. Con teclado,
					usa las flechas.
				</p>
				<fieldset className="companion-space-size" aria-label="Tamaño de la zona">
					<button
						type="button"
						aria-label="Reducir zona"
						disabled={disabled || (preview.width <= 0.2 && preview.height <= 0.2)}
						onClick={() => changeSize(-0.1)}
					>
						−
					</button>
					<button
						type="button"
						aria-label="Ampliar zona"
						disabled={disabled || (preview.width >= 1 && preview.height >= 1)}
						onClick={() => changeSize(0.1)}
					>
						+
					</button>
				</fieldset>
			</div>
		</fieldset>
	);
}
