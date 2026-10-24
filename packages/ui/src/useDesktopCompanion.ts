import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	DEFAULT_DESKTOP_COMPANION,
	type DesktopCompanionContextRequest,
	type DesktopCompanionControls,
	type DesktopCompanionPatch,
	parseDesktopCompanion,
} from "./desktop-companion.ts";

/** Native events keep the panel and roaming window in sync; no polling or mobile requests. */
export function useDesktopCompanion(enabled: boolean): DesktopCompanionControls {
	const [state, setState] = useState(DEFAULT_DESKTOP_COMPANION);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const active = useRef(false);
	const generation = useRef(0);
	const revision = useRef(0);
	const busy = useRef<object | undefined>(undefined);
	const interactionRevision = useRef(0);
	const fail = useCallback(
		(reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)),
		[],
	);
	useEffect(() => {
		generation.current++;
		setPending(false);
		if (!enabled || !isTauri()) {
			setState(DEFAULT_DESKTOP_COMPANION);
			setError(undefined);
			return;
		}
		active.current = true;
		let live = true;
		let unlisten: (() => void) | undefined;
		void (async () => {
			try {
				const { listen } = await import("@tauri-apps/api/event");
				const stop = await listen("dot://desktop-companion", (event) => {
					if (!live) return;
					try {
						const next = parseDesktopCompanion(event.payload);
						revision.current++;
						setState(next);
						setError(undefined);
					} catch (reason) {
						fail(reason);
					}
				});
				if (!live) {
					stop();
					return;
				}
				unlisten = stop;
				const request = ++revision.current;
				const value = await invoke("desktop_companion_get");
				if (live && request === revision.current) {
					setState(parseDesktopCompanion(value));
					setError(undefined);
				}
			} catch (reason) {
				if (live) fail(reason);
			}
		})();
		return () => {
			live = false;
			active.current = false;
			generation.current++;
			revision.current++;
			interactionRevision.current++;
			busy.current = undefined;
			unlisten?.();
		};
	}, [enabled, fail]);
	const command = useCallback(
		async (name: string, args?: Record<string, unknown>, exclusive = false) => {
			if (!active.current || !isTauri() || (exclusive && busy.current)) return;
			const owner = {};
			const lifetime = generation.current;
			if (exclusive) {
				busy.current = owner;
				setPending(true);
			}
			const request = ++revision.current;
			try {
				const value = await invoke(name, args);
				if (active.current && request === revision.current) {
					setState(parseDesktopCompanion(value));
					setError(undefined);
				}
			} catch (reason) {
				if (active.current && lifetime === generation.current && (exclusive || request === revision.current))
					fail(reason);
			} finally {
				if (exclusive && busy.current === owner) {
					busy.current = undefined;
					if (active.current) setPending(false);
				}
			}
		},
		[fail],
	);
	const change = useCallback(
		(patch: DesktopCompanionPatch) => command("desktop_companion_set", { patch }, true),
		[command],
	);
	const recall = useCallback(() => command("desktop_companion_recall", undefined, true), [command]);
	const hide = useCallback(() => command("desktop_companion_hide", undefined, true), [command]);
	const menu = useCallback(() => command("desktop_companion_menu"), [command]);
	const move = useCallback(
		(dx: number, dy: number) => command("desktop_companion_move", { dx, dy }),
		[command],
	);
	// Serialize pause/resume signals so a late pointer-enter cannot leave the native pet paused.
	const interactionQueue = useRef(Promise.resolve());
	const interact = useCallback(
		(interaction: boolean) => {
			const request = ++interactionRevision.current;
			interactionQueue.current = interactionQueue.current.then(async () => {
				if (request !== interactionRevision.current) return;
				await command("desktop_companion_interaction", { active: interaction });
			});
			return interactionQueue.current;
		},
		[command],
	);
	const context = useCallback(
		(request: DesktopCompanionContextRequest) => command("desktop_companion_context", { request }),
		[command],
	);
	const dismissContext = useCallback(
		(id?: string) => command("desktop_companion_context_dismiss", { id: id ?? null }),
		[command],
	);
	const openContext = useCallback(() => command("desktop_companion_context_open"), [command]);
	const contextReady = useCallback(
		(id: string) => command("desktop_companion_context_ready", { id }),
		[command],
	);
	return {
		state,
		pending,
		error,
		change,
		interact,
		recall,
		hide,
		menu,
		move,
		context,
		dismissContext,
		openContext,
		contextReady,
	};
}
