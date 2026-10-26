import type { MobileNotification } from "./mobile.ts";
import { COMPANION_KEY, parseCompanion } from "./useCompanion.ts";

/** Read the existing appearance setting at delivery time; never cache a second persona preference. */
export function foregroundNotification<T extends Pick<MobileNotification, "title" | "body">>(notice: T): T {
	let mode = "gentle";
	try {
		mode = parseCompanion(JSON.parse(localStorage.getItem(COMPANION_KEY) ?? "null")).mode;
	} catch { /* Storage may be unavailable; preserve the default persona. */ }
	return { ...notice, title: mode === "capri" ? "Capri" : "Gentle Dot" };
}
