import { useCallback, useEffect, useRef, useState } from "react";
import { COMPANION_KEY } from "../../../packages/ui/src/useCompanion.ts";
import { GentleMobile, type NativeCompanionState, nativeAndroid } from "./native.ts";

export type NativeTheme = NativeCompanionState["theme"];
type Options = { enabled?: boolean; pinned?: boolean };
const CHANGED = "gentle-dot-companion-change";

function appearance(value: unknown): NativeTheme | undefined {
	if (!value || typeof value !== "object") return;
	const mode = (value as Record<string, unknown>).mode;
	return mode === "capri" ? "capri" : mode === "gentle" ? "gentle-dot" : undefined;
}

function preference() {
	let raw: string | null | undefined;
	let value: Record<string, unknown> = {};
	try {
		raw = localStorage.getItem(COMPANION_KEY);
		const parsed: unknown = JSON.parse(raw ?? "null");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			value = parsed as Record<string, unknown>;
	} catch {
		// Native preferences can restore the appearance when web storage is unavailable.
	}
	return { raw, value, theme: appearance(value) };
}

function renderFailed(state: NativeCompanionState, selected: NativeTheme) {
	return (
		(state.active && "renderReady" in state && state.renderReady === false) ||
		("appliedTheme" in state && typeof state.appliedTheme === "string" && state.appliedTheme !== selected)
	);
}

function verify(state: NativeCompanionState, selected: NativeTheme) {
	if (state.renderError) throw new Error(state.renderError);
	if (state.theme !== selected)
		throw new Error("Android no confirmó el tema del acompañante. Inténtalo de nuevo.");
	if (renderFailed(state, selected)) {
		throw new Error("Android no pudo mostrar el personaje seleccionado. Inténtalo de nuevo.");
	}
}

/** One instance per WebView. contentReady marks when the shared companion UI can receive memory-only preferences. */
export function useNativeCompanionTheme(contentReady = true) {
	const [theme, setTheme] = useState<NativeTheme>();
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	const operations = useRef<
		| {
				setCompanion(options: Options): Promise<void>;
				retry(): Promise<void>;
				restoreAppearance(): void;
		  }
		| undefined
	>(undefined);
	useEffect(() => {
		if (!nativeAndroid) return;
		let alive = true;
		let foreground = !document.hidden;
		let hydrating = false;
		let selected: NativeTheme | undefined;
		let revision = 0;
		let waiting = 0;
		let tail = Promise.resolve();
		// A failed localStorage write must not undo the choice delivered in the event.
		let memoryChoice:
			| { theme: NativeTheme; raw: string | null | undefined; value: Record<string, unknown> }
			| undefined;
		const choose = (next: NativeTheme | undefined) => {
			selected = next;
			if (alive) setTheme(next);
		};
		const hydrate = (nativeTheme: NativeTheme) => {
			const stored = preference();
			const value = {
				...stored.value,
				mode: nativeTheme === "capri" ? "capri" : "gentle",
				// Restoring appearance must never opt into the agent's Capri identity.
				persona: stored.value.persona ?? "gentle",
			};
			try {
				localStorage.setItem(COMPANION_KEY, JSON.stringify(value));
			} catch {
				memoryChoice = { theme: nativeTheme, raw: stored.raw, value };
			}
			hydrating = true;
			try {
				window.dispatchEvent(new CustomEvent(CHANGED, { detail: value }));
			} finally {
				hydrating = false;
			}
		};
		const synchronize = async (options?: Options, refresh = false) => {
			if (!alive || (!options && !foreground)) return;
			const started = revision;
			if (refresh) {
				const stored = preference();
				if (memoryChoice && memoryChoice.raw !== stored.raw) memoryChoice = undefined;
				choose(memoryChoice?.theme ?? stored.theme);
			}
			let state = await GentleMobile.companionState();
			if (!alive || (!options && !foreground)) return;
			if (!selected && started === revision) {
				choose(state.theme);
				hydrate(state.theme);
			}
			let action = options;
			while (alive && (options || foreground)) {
				const target = selected ?? state.theme;
				if (action || state.theme !== target || renderFailed(state, target)) {
					await GentleMobile.setCompanion({ ...action, theme: target });
					action = undefined;
					if (!alive) return;
					state = await GentleMobile.companionState();
					if (!alive) return;
				}
				// A later selection wins, including when it arrived during a native call.
				if (selected && selected !== target) continue;
				verify(state, target);
				// Also reconcile persisted Android aliases on first load/resume, even with the overlay off.
				await GentleMobile.setAppIcon({ theme: target });
				if (selected && selected !== target) continue;
				return;
			}
		};
		const enqueue = (options?: Options, refresh = false) => {
			waiting++;
			setPending(true);
			const result = tail.then(() => synchronize(options, refresh));
			tail = result.catch(() => {});
			return result
				.then(
					() => {
						if (alive) setError("");
					},
					(cause: unknown) => {
						if (alive)
							setError(
								cause instanceof Error ? cause.message : "No se pudo sincronizar el personaje con Android.",
							);
						throw cause;
					},
				)
				.finally(() => {
					waiting--;
					if (alive) setPending(waiting > 0);
				});
		};
		const refresh = () => {
			if (foreground) void enqueue(undefined, true).catch(() => {});
		};
		const changed = (event: Event) => {
			if (hydrating || !foreground || !(event instanceof CustomEvent)) return;
			const next = appearance(event.detail);
			if (!next) return;
			const stored = preference();
			memoryChoice =
				stored.theme === next ? undefined : { theme: next, raw: stored.raw, value: { ...event.detail } };
			if (next === selected) return;
			revision++;
			choose(next);
			void enqueue().catch(() => {});
		};
		const storage = (event: StorageEvent) => {
			if (event.key !== null && event.key !== COMPANION_KEY) return;
			if (event.storageArea && event.storageArea !== localStorage) return;
			memoryChoice = undefined;
			const next = preference().theme;
			if (next && next === selected) return;
			revision++;
			choose(next);
			refresh();
		};
		const resume = () => {
			foreground = true;
			refresh();
		};
		const pause = () => {
			foreground = false;
		};
		const visibility = () => {
			if (document.hidden) pause();
			else resume();
		};
		const api = {
			setCompanion: (options: Options) => enqueue(options, true),
			retry: () => enqueue(undefined, true),
			restoreAppearance: () => {
				if (!alive || !foreground || !memoryChoice || memoryChoice.theme !== selected) return;
				const stored = preference();
				if (stored.raw !== memoryChoice.raw) return;
				hydrating = true;
				try {
					window.dispatchEvent(
						new CustomEvent(CHANGED, {
							detail: {
								...memoryChoice.value,
								persona: memoryChoice.value.persona ?? stored.value.persona ?? "gentle",
							},
						}),
					);
				} finally {
					hydrating = false;
				}
			},
		};
		operations.current = api;
		window.addEventListener(CHANGED, changed);
		window.addEventListener("storage", storage);
		window.addEventListener("gentledot-resume", resume);
		window.addEventListener("gentledot-pause", pause);
		document.addEventListener("visibilitychange", visibility);
		refresh();
		return () => {
			alive = false;
			if (operations.current === api) operations.current = undefined;
			window.removeEventListener(CHANGED, changed);
			window.removeEventListener("storage", storage);
			window.removeEventListener("gentledot-resume", resume);
			window.removeEventListener("gentledot-pause", pause);
			document.removeEventListener("visibilitychange", visibility);
		};
	}, []);
	useEffect(() => {
		// Child effects install useCompanion's listener before this parent effect.
		// Replaying here also covers a connection that finishes after native hydration.
		if (contentReady && theme) operations.current?.restoreAppearance();
	}, [contentReady, theme]);
	const setCompanion = useCallback((options: Options) => {
		if (!operations.current)
			return Promise.reject(new Error("La sincronización con Android no está disponible."));
		return operations.current.setCompanion(options);
	}, []);
	const retry = useCallback(() => operations.current?.retry() ?? Promise.resolve(), []);
	return { theme, error, pending, setCompanion, retry };
}

export type NativeCompanionThemeControls = ReturnType<typeof useNativeCompanionTheme>;
