import { useEffect, useReducer } from "react";

/** A single deadline timer, not a polling clock. Invalid deadlines never enable an approval. */
export function requestExpired(expiresAt: string, allowNoDeadline = false): boolean {
	if (allowNoDeadline && expiresAt === "") return false;
	const deadline = Date.parse(expiresAt);
	return !Number.isFinite(deadline) || deadline <= Date.now();
}
export function useRequestExpiry(expiresAt: string, allowNoDeadline = false): boolean {
	const [, refresh] = useReducer((value) => value + 1, 0);
	useEffect(() => {
		const deadline = Date.parse(expiresAt);
		if (!Number.isFinite(deadline) || deadline <= Date.now()) return;
		let timer: ReturnType<typeof setTimeout>;
		const update = () => {
			clearTimeout(timer);
			refresh();
			const remaining = deadline - Date.now();
			if (remaining > 0) timer = setTimeout(update, Math.min(remaining + 1, 2_147_483_647));
		};
		timer = setTimeout(update, Math.min(deadline - Date.now() + 1, 2_147_483_647));
		document.addEventListener("visibilitychange", update);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", update);
		};
	}, [expiresAt]);
	return requestExpired(expiresAt, allowNoDeadline);
}
