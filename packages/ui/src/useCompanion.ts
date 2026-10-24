import { useCallback, useEffect, useRef, useState } from "react";
import type { CapriPose } from "./capri-art.ts";
import type { CompanionAmbience, CompanionCompany } from "./capri-scenes.ts";
import type { CompanionClient, CompanionMode } from "./companion.ts";
import { type CompanionSpaceRect, FULL_COMPANION_SPACE, normalizeCompanionSpace } from "./companion-space.ts";

export const COMPANION_KEY = "gentle-dot-companion-v1";
const CHANGED = "gentle-dot-companion-change";
export interface CompanionSettings {
	/** Local appearance; legacy field and storage key are preserved. */
	mode: CompanionMode;
	/** Agent identity, independent of appearance and confirmed by its connection. */
	persona: CompanionMode;
	form: "auto" | "body" | "face" | "eyes" | "hands";
	motion: boolean;
	visible: boolean;
	side: "auto" | "left" | "right";
	company: CompanionCompany;
	ambience: CompanionAmbience;
	scene: "auto" | CapriPose;
	position: { x: number; y: number } | null;
	minimized: boolean;
	pinned: boolean;
	space: CompanionSpaceRect;
}
export const DEFAULT_COMPANION: CompanionSettings = {
	mode: "gentle",
	persona: "gentle",
	form: "auto",
	motion: true,
	visible: true,
	side: "auto",
	company: "visits",
	ambience: "default",
	scene: "auto",
	position: null,
	minimized: false,
	pinned: false,
	space: FULL_COMPANION_SPACE,
};
export function parseCompanion(value: unknown): CompanionSettings {
	const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const point = v.position as { x?: unknown; y?: unknown } | null;
	return {
		mode: v.mode === "capri" ? "capri" : "gentle",
		persona: v.persona === "capri" || (v.persona === undefined && v.mode === "capri") ? "capri" : "gentle",
		// Older releases exposed pose selectors. New sessions always let Capri choose her form.
		form: "auto",
		motion: v.motion !== false,
		visible: v.visible !== false,
		side: "auto",
		company: "visits",
		ambience: ["hacker", "afterlife", "sunset"].includes(String(v.ambience))
			? (v.ambience as CompanionAmbience)
			: "default",
		scene: "auto",
		position:
			point &&
			typeof point.x === "number" &&
			Number.isFinite(point.x) &&
			typeof point.y === "number" &&
			Number.isFinite(point.y)
				? { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) }
				: null,
		minimized: v.minimized === true,
		pinned: v.pinned === true,
		space: normalizeCompanionSpace(
			v.space && typeof v.space === "object" ? (v.space as CompanionSpaceRect) : FULL_COMPANION_SPACE,
		),
	};
}
function read(): CompanionSettings {
	try {
		return parseCompanion(JSON.parse(localStorage.getItem(COMPANION_KEY) ?? "null"));
	} catch {
		return { ...DEFAULT_COMPANION };
	}
}
export function useCompanion(client?: CompanionClient, connected = true) {
	const [settings, setSettings] = useState(read);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const [syncError, setSyncError] = useState<string>();
	const [storageFailed, setStorageFailed] = useState(false);
	const current = useRef(settings);
	current.current = settings;
	const sequence = useRef(0);
	const busy = useRef(false);
	const save = useCallback((value: CompanionSettings) => {
		current.current = value;
		setSettings(value);
		try {
			localStorage.setItem(COMPANION_KEY, JSON.stringify(value));
			setStorageFailed(false);
		} catch {
			setStorageFailed(true);
		}
		window.dispatchEvent(new CustomEvent(CHANGED, { detail: value }));
	}, []);
	useEffect(() => {
		const update = (event: Event) => {
			if (!(event instanceof CustomEvent)) return;
			const mood = event.detail?.mood;
			if (mood !== null && !["hacker", "afterlife", "sunset", "restore"].includes(mood)) return;
			save({ ...current.current, ambience: mood === "restore" || mood === null ? "default" : mood });
		};
		window.addEventListener("gentle-dot-terminal-mood", update);
		return () => window.removeEventListener("gentle-dot-terminal-mood", update);
	}, [save]);
	useEffect(() => {
		const update = (event: Event) => {
			if (event instanceof StorageEvent && event.key !== null && event.key !== COMPANION_KEY) return;
			const next = event instanceof CustomEvent ? parseCompanion(event.detail) : read();
			// Another event in this batch (for example a mood change) must use the new theme.
			current.current = next;
			setSettings(next);
		};
		window.addEventListener("storage", update);
		window.addEventListener(CHANGED, update);
		return () => {
			window.removeEventListener("storage", update);
			window.removeEventListener(CHANGED, update);
		};
	}, []);
	useEffect(() => {
		busy.current = false;
		setPending(false);
		if (!client || !connected) return;
		let abort: AbortController | undefined;
		const refresh = () => {
			if (document.hidden || busy.current) return;
			abort?.abort();
			const controller = new AbortController();
			abort = controller;
			const revision = ++sequence.current;
			void client.read(controller.signal).then(
				(mode) => {
					if (!controller.signal.aborted && revision === sequence.current) {
						save({ ...current.current, persona: mode });
						setSyncError(undefined);
					}
				},
				(reason: unknown) => {
					if (!controller.signal.aborted && revision === sequence.current)
						setSyncError(reason instanceof Error ? reason.message : "No se pudo consultar el modo.");
				},
			);
		};
		refresh();
		document.addEventListener("visibilitychange", refresh);
		window.addEventListener("gentledot-resume", refresh);
		return () => {
			abort?.abort();
			sequence.current++;
			document.removeEventListener("visibilitychange", refresh);
			window.removeEventListener("gentledot-resume", refresh);
		};
	}, [client, connected, save]);
	const change = (patch: Partial<Omit<CompanionSettings, "mode" | "persona">>) =>
		save(parseCompanion({ ...current.current, ...patch }));
	// Appearance never waits for a computer or changes its instructions.
	const setMode = async (mode: CompanionMode) => {
		save({ ...current.current, mode });
	};
	const setPersona = async (mode: CompanionMode) => {
		if (busy.current || !connected) return;
		busy.current = true;
		const revision = ++sequence.current;
		setPending(true);
		setError(undefined);
		try {
			const confirmed = client ? await client.set(mode) : mode;
			if (revision === sequence.current) {
				save({ ...current.current, persona: confirmed });
				setSyncError(undefined);
			}
		} catch (reason) {
			if (revision === sequence.current)
				setError(reason instanceof Error ? reason.message : "No se pudo cambiar el modo.");
		} finally {
			if (revision === sequence.current) {
				busy.current = false;
				setPending(false);
			}
		}
	};
	return { settings, change, setMode, setPersona, pending, error, syncError, storageFailed, connected };
}
export type CompanionControls = ReturnType<typeof useCompanion>;
