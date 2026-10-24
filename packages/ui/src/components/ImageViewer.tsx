import { type PointerEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

type Point = { x: number; y: number };
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const clamp = (value: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));

/** One authenticated preview, reused at every zoom level; gestures never download the image again. */
export function ImageViewer({
	url,
	name,
	description,
	close,
	save,
	share,
	busy = false,
	status,
	error,
	cancelTransfer,
	restoreFocus,
}: {
	url?: string | undefined;
	name: string;
	description?: string | undefined;
	close(): void;
	save?: (() => void) | undefined;
	share?: (() => void) | undefined;
	busy?: boolean;
	status?: string | undefined;
	error?: string | undefined;
	cancelTransfer?: (() => void) | undefined;
	restoreFocus?: (() => void) | undefined;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const viewport = useRef<HTMLElement>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const [ratio, setRatio] = useState(1);
	const [zoom, setZoom] = useState(1);
	const zoomRef = useRef(1);
	const pointers = useRef(new Map<number, Point>());
	const pendingScroll = useRef<Point | undefined>(undefined);
	const hint = useId();
	const width = Math.min(size.width, size.height * ratio);
	const height = width / ratio;
	useEffect(() => {
		const previous = document.activeElement;
		dialog.current?.showModal();
		const back = (event: Event) => {
			if (!event.defaultPrevented) {
				event.preventDefault();
				close();
			}
		};
		window.addEventListener("gentledot-back", back, true);
		return () => {
			window.removeEventListener("gentledot-back", back, true);
			if (restoreFocus) restoreFocus();
			else if (previous instanceof HTMLElement && previous.isConnected)
				previous.focus({ preventScroll: true });
		};
	}, [close, restoreFocus]);
	useEffect(() => {
		const element = viewport.current;
		if (!element) return;
		const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Apply anchored scroll only after the new zoom geometry is committed.
	useLayoutEffect(() => {
		const target = pendingScroll.current;
		if (target && viewport.current) {
			viewport.current.scrollLeft = target.x;
			viewport.current.scrollTop = target.y;
			pendingScroll.current = undefined;
		}
	}, [zoom]);
	const scaleTo = (value: number, anchor?: Point, movedAnchor = anchor) => {
		const element = viewport.current;
		if (!element || !width || !height) return;
		const next = clamp(value);
		const old = zoomRef.current;
		const point = anchor ?? { x: size.width / 2, y: size.height / 2 };
		const target = movedAnchor ?? point;
		const x = (element.scrollLeft + point.x - Math.max(0, (size.width - width * old) / 2)) / old;
		const y = (element.scrollTop + point.y - Math.max(0, (size.height - height * old) / 2)) / old;
		const scroll = {
			x: x * next + Math.max(0, (size.width - width * next) / 2) - target.x,
			y: y * next + Math.max(0, (size.height - height * next) / 2) - target.y,
		};
		zoomRef.current = next;
		if (old === next) {
			element.scrollLeft = scroll.x;
			element.scrollTop = scroll.y;
		} else {
			pendingScroll.current = scroll;
			setZoom(next);
		}
	};
	const pointAt = (event: PointerEvent<HTMLElement>): Point => {
		const rect = event.currentTarget.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	};
	const move = (event: PointerEvent<HTMLElement>) => {
		const oldPoint = pointers.current.get(event.pointerId);
		if (!oldPoint) return;
		const before = [...pointers.current.values()];
		const nextPoint = pointAt(event);
		pointers.current.set(event.pointerId, nextPoint);
		const after = [...pointers.current.values()];
		if (before.length === 2 && after.length === 2) {
			const [a, b] = before as [Point, Point];
			const [c, d] = after as [Point, Point];
			const distance = Math.hypot(a.x - b.x, a.y - b.y);
			if (distance > 0)
				scaleTo(
					(zoomRef.current * Math.hypot(c.x - d.x, c.y - d.y)) / distance,
					{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
					{ x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 },
				);
		} else if (after.length === 1 && viewport.current) {
			viewport.current.scrollLeft += oldPoint.x - nextPoint.x;
			viewport.current.scrollTop += oldPoint.y - nextPoint.y;
		}
	};
	return (
		<dialog
			className="shared-image-viewer"
			ref={dialog}
			aria-label={name}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					close();
				}
			}}
		>
			<header>
				<strong title={name}>{name}</strong>
				<div className="image-viewer-actions">
					{save ? (
						<button
							type="button"
							title="Descargar imagen"
							aria-label="Descargar imagen"
							disabled={busy}
							onClick={save}
						>
							<ImageIcon kind="download" />
						</button>
					) : null}
					{share ? (
						<button
							type="button"
							title="Compartir imagen"
							aria-label="Compartir imagen"
							disabled={busy}
							onClick={share}
						>
							<ImageIcon kind="share" />
						</button>
					) : null}
					<button type="button" title="Cerrar imagen" aria-label="Cerrar imagen" onClick={close}>
						<ImageIcon kind="close" />
					</button>
				</div>
			</header>
			{/* Keyboard scrolling and visible native scrollbars complement touch/mouse dragging. */}
			<section
				className="image-viewer-viewport"
				ref={viewport}
				aria-label="Área de imagen"
				aria-describedby={hint}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: This scroll region supports keyboard panning and zoom.
				tabIndex={0}
				data-zoomed={zoom > 1}
				onKeyDown={(event) => {
					if (event.key === "+" || event.key === "=") {
						event.preventDefault();
						scaleTo(zoomRef.current + 0.5);
					} else if (event.key === "-") {
						event.preventDefault();
						scaleTo(zoomRef.current - 0.5);
					} else if (event.key === "0" || event.key === "Home") {
						event.preventDefault();
						scaleTo(1);
					}
				}}
				onPointerDown={(event) => {
					if (event.button !== 0 || pointers.current.size >= 2) return;
					pointers.current.set(event.pointerId, pointAt(event));
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={move}
				onPointerUp={(event) => pointers.current.delete(event.pointerId)}
				onPointerCancel={(event) => pointers.current.delete(event.pointerId)}
				onLostPointerCapture={(event) => pointers.current.delete(event.pointerId)}
			>
				{url ? (
					<div
						className="image-viewer-canvas"
						style={{
							width: Math.max(size.width, width * zoom),
							height: Math.max(size.height, height * zoom),
						}}
					>
						<img
							src={url}
							alt={description || name}
							draggable={false}
							referrerPolicy="no-referrer"
							style={{ width: width * zoom || undefined, height: height * zoom || undefined }}
							onLoad={(event) =>
								setRatio(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight || 1)
							}
						/>
					</div>
				) : (
					<p className="image-viewer-unavailable">
						Esta imagen no tiene vista previa. Puedes descargarla para verla completa.
					</p>
				)}
			</section>
			<footer>
				<fieldset className="image-viewer-zoom" aria-label="Zoom de imagen">
					<button
						type="button"
						title="Reducir imagen"
						aria-label="Reducir imagen"
						disabled={!url || zoom <= MIN_ZOOM}
						onClick={() => scaleTo(zoomRef.current - 0.5)}
					>
						<ImageIcon kind="minus" />
					</button>
					<button
						type="button"
						title="Ajustar imagen a la pantalla"
						aria-label="Ajustar imagen a la pantalla"
						onClick={() => scaleTo(1)}
					>
						{Math.round(zoom * 100)}%
					</button>
					<button
						type="button"
						title="Ampliar imagen"
						aria-label="Ampliar imagen"
						disabled={!url || zoom >= MAX_ZOOM}
						onClick={() => scaleTo(zoomRef.current + 0.5)}
					>
						<ImageIcon kind="plus" />
					</button>
				</fieldset>
				<span id={hint} className="image-viewer-hint">
					Pellizca para ampliar · Arrastra para mover. Con teclado: +, − y flechas.
				</span>
				{status ? (
					<p role="status" className="image-viewer-status">
						{status}
					</p>
				) : null}
				{error ? (
					<p role="alert" className="shared-file-error">
						{error}
					</p>
				) : null}
				{busy && cancelTransfer ? (
					<button type="button" className="image-viewer-cancel" onClick={cancelTransfer}>
						Cancelar descarga
					</button>
				) : null}
			</footer>
		</dialog>
	);
}

function ImageIcon({ kind }: { kind: "download" | "share" | "close" | "minus" | "plus" }) {
	return (
		<svg
			viewBox="0 0 24 24"
			width="20"
			height="20"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{kind === "download" ? (
				<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4" />
			) : kind === "share" ? (
				<>
					<circle cx="18" cy="5" r="3" />
					<circle cx="6" cy="12" r="3" />
					<circle cx="18" cy="19" r="3" />
					<path d="m9 10 6-3m-6 7 6 3" />
				</>
			) : kind === "close" ? (
				<path d="m6 6 12 12M6 18 18 6" />
			) : (
				<>
					<path d="M5 12h14" />
					{kind === "plus" ? <path d="M12 5v14" /> : null}
				</>
			)}
		</svg>
	);
}
