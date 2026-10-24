import { useSyncExternalStore } from "react";

export type RequestMode = "inline" | "popup";
const KEY = "gentledot.request-presentation";
const EVENT = "gentledot-request-presentation";
function read(): RequestMode {
	try { return localStorage.getItem(KEY) === "popup" ? "popup" : "inline"; }
	catch { return "inline"; }
}
let fallback: RequestMode | undefined;
function subscribe(listener: () => void) {
	window.addEventListener("storage", listener);
	window.addEventListener(EVENT, listener);
	return () => {
		window.removeEventListener("storage", listener);
		window.removeEventListener(EVENT, listener);
	};
}
export function useRequestPresentation() {
	const mode = useSyncExternalStore(subscribe, () => fallback ?? read(), () => "inline" as const);
	return [mode, (next: RequestMode) => {
		try { localStorage.setItem(KEY, next); fallback = undefined; }
		catch { fallback = next; }
		window.dispatchEvent(new Event(EVENT));
	}] as const;
}
