/** Desktop companion preferences belong to this computer, not to the mobile assistant mode. */
export interface DesktopCompanionRect {
	x: number;
	y: number;
	width: number;
	height: number;
}
export interface DesktopCompanionArea {
	/** Stable connector name; compositor numeric monitor IDs can change after reconnect. */
	monitor: string;
	enabled: boolean;
	rect: DesktopCompanionRect;
}
export interface DesktopCompanionMonitor extends DesktopCompanionRect {
	name: string;
}
export type DesktopCompanionContextKind =
	| "input-ready"
	| "typing"
	| "submitted"
	| "working"
	| "question"
	| "capture"
	| "download"
	| "notification"
	| "music"
	| "rest";
export interface DesktopCompanionCue {
	id: string;
	kind: DesktopCompanionContextKind;
	summary?: string;
	body?: string;
	sessionId?: string;
	paneId?: string;
	source?: DesktopNotificationSource;
	placement?: "perch" | "aside";
	expiresAt: number;
}
export interface DesktopNotificationSource {
	appName?: string;
	desktopEntry?: string;
	category?: string;
	sender?: string;
	conversation?: string;
}
export interface DesktopCompanionContext {
	musicPlaying: boolean;
	musicAvailable: boolean;
	notificationsAvailable: boolean;
	notificationService?: string;
	notification?: DesktopCompanionCue;
	cue?: DesktopCompanionCue;
}
export interface DesktopCompanionContextRequest {
	id?: string;
	kind: DesktopCompanionContextKind;
	summary?: string;
	body?: string;
	sessionId?: string;
	paneId?: string;
	/** Global logical desktop coordinates from a verified source. */
	target?: DesktopCompanionRect;
	placement?: "perch" | "aside";
}
export type DesktopRenderMode = "sprites" | "3d" | "2d";
export interface DesktopCompanionState {
 renderMode?: DesktopRenderMode;
	context?: DesktopCompanionContext;
	enabled: boolean;
	motion: boolean;
	appearances: boolean;
	pinned: boolean;
	areas: DesktopCompanionArea[];
	/** Available work areas in logical desktop coordinates. */
	monitors: DesktopCompanionMonitor[];
	visible: boolean;
	paused: boolean;
	/** Transient native travel; independent from the saved motion preference. */
	travelling?: boolean;
	available: boolean;
	reason?: string;
}
export type DesktopCompanionPatch = Partial<
	Pick<DesktopCompanionState, "enabled" | "motion" | "appearances" | "pinned" | "areas" | "renderMode">
>;
export interface DesktopCompanionControls {
	state: DesktopCompanionState;
	pending: boolean;
	error?: string;
	change(patch: DesktopCompanionPatch): Promise<void>;
	interact(active: boolean): Promise<void>;
	recall(): Promise<void>;
	hide(): Promise<void>;
	menu(): Promise<void>;
	move(dx: number, dy: number): Promise<void>;
	context?(request: DesktopCompanionContextRequest): Promise<void>;
	dismissContext?(id?: string): Promise<void>;
	openContext?(): Promise<void>;
	contextReady?(id: string): Promise<void>;
}
export const DEFAULT_DESKTOP_COMPANION: DesktopCompanionState = {
	enabled: false,
	motion: true,
	appearances: true,
	pinned: false,
	areas: [],
	monitors: [],
	visible: false,
	paused: false,
	travelling: false,
	available: false,
};
const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const name = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 128 && !value.includes("\0");
function rect(value: unknown, normalized: boolean): value is DesktopCompanionRect {
	if (!object(value)) return false;
	const { x, y, width, height } = value;
	return (
		finite(x) &&
		finite(y) &&
		finite(width) &&
		finite(height) &&
		width > 0 &&
		height > 0 &&
		(!normalized || (x >= 0 && y >= 0 && x + width <= 1.000001 && y + height <= 1.000001))
	);
}
const CONTEXT_KINDS = new Set([
	"input-ready",
	"typing",
	"submitted",
	"working",
	"question",
	"capture",
	"download",
	"notification",
	"music",
	"rest",
]);
function parseNotificationSource(value: unknown): DesktopNotificationSource | undefined {
	if (!object(value)) return undefined;
	const source: DesktopNotificationSource = {};
	for (const key of ["appName", "desktopEntry", "category", "sender", "conversation"] as const) {
		if (typeof value[key] === "string") {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: strip transport control bytes from source labels.
			const clean = value[key].replace(/[\u0000-\u001f\u007f]/g, " ");
			const text = clean.trim().slice(0, 128);
			if (text) source[key] = text;
		}
	}
	return Object.keys(source).length ? source : undefined;
}
function parseCue(value: unknown): DesktopCompanionCue | undefined {
	if (
		!object(value) ||
		typeof value.id !== "string" ||
		value.id.length > 160 ||
		!CONTEXT_KINDS.has(String(value.kind)) ||
		!finite(value.expiresAt)
	)
		return undefined;
	if (
		[value.summary, value.body, value.sessionId, value.paneId].some(
			(v) => v !== undefined && typeof v !== "string",
		)
	)
		return undefined;
	return {
		id: value.id,
		kind: value.kind as DesktopCompanionContextKind,
		expiresAt: value.expiresAt,
		...(typeof value.summary === "string" ? { summary: value.summary.slice(0, 240) } : {}),
		...(typeof value.body === "string" ? { body: value.body.slice(0, 480) } : {}),
		...(typeof value.sessionId === "string" ? { sessionId: value.sessionId.slice(0, 128) } : {}),
		...(typeof value.paneId === "string" ? { paneId: value.paneId.slice(0, 128) } : {}),
		...(parseNotificationSource(value.source) ? { source: parseNotificationSource(value.source) } : {}),
		...(value.placement === "perch" || value.placement === "aside" ? { placement: value.placement } : {}),
	};
}
function parseContext(value: unknown): DesktopCompanionContext | undefined {
	if (!object(value)) return undefined;
	return {
		musicPlaying: value.musicPlaying === true,
		musicAvailable: value.musicAvailable === true,
		notificationsAvailable: value.notificationsAvailable === true,
		...(typeof value.notificationService === "string"
			? { notificationService: value.notificationService.slice(0, 128) }
			: {}),
		...(parseCue(value.notification) ? { notification: parseCue(value.notification) } : {}),
		...(parseCue(value.cue) ? { cue: parseCue(value.cue) } : {}),
	};
}
export function parseDesktopCompanion(value: unknown): DesktopCompanionState {
	if (!object(value)) throw new Error("No se pudo consultar a Capri en este equipo.");
	const data = value;
	for (const key of ["enabled", "motion", "appearances", "visible", "paused", "available"])
		if (typeof data[key] !== "boolean") throw new Error("El equipo no confirmó el estado de Capri.");
	if (data.pinned !== undefined && typeof data.pinned !== "boolean")
		throw new Error("El equipo no confirmó la posición fija de Capri.");
	const areas = data.areas ?? [];
	const monitors = data.monitors ?? [];
	if (
		!Array.isArray(areas) ||
		areas.length > 64 ||
		areas.some(
			(a) => !object(a) || !name(a.monitor) || typeof a.enabled !== "boolean" || !rect(a.rect, true),
		) ||
		new Set(areas.map((a) => a.monitor)).size !== areas.length
	)
		throw new Error("El equipo no confirmó las zonas de Capri.");
	if (
		!Array.isArray(monitors) ||
		monitors.length > 32 ||
		monitors.some((m) => !object(m) || !name(m.name) || !rect(m, false)) ||
		new Set(monitors.map((m) => m.name)).size !== monitors.length
	)
		throw new Error("El equipo no confirmó sus pantallas.");
	return {
		enabled: data.enabled as boolean,
		...(parseContext(data.context) ? { context: parseContext(data.context) } : {}),
        ...(data.renderMode === "2d" || data.renderMode === "3d" || data.renderMode === "sprites" ? { renderMode: data.renderMode } : {}),
		motion: data.motion as boolean,
		appearances: data.appearances as boolean,
		pinned: data.pinned === true,
		areas: areas as DesktopCompanionArea[],
		monitors: monitors as DesktopCompanionMonitor[],
		visible: data.visible as boolean,
		paused: data.paused as boolean,
		travelling: data.travelling === true,
		available: data.available as boolean,
		...(typeof data.reason === "string" ? { reason: data.reason } : {}),
	};
}
