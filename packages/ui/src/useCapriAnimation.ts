import { useEffect, useRef, useState } from "react";
import { type CapriAnimationClip, nextAnimationFrame } from "./capri-animation.ts";

/** One clock per rendered sprite, with no app state updates or hidden-tab catch-up. */
export function useCapriAnimation(clip: CapriAnimationClip, enabled: boolean) {
	const [visible, setVisible] = useState(() => !document.hidden);
	const [reduced, setReduced] = useState(
		() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	const [frame, setFrame] = useState({ clip, index: 0, complete: false });
	const cursor = useRef({ clip, index: 0, complete: false, remaining: clip.frames[0]?.durationMs ?? 100 });
	useEffect(() => {
		const visibility = () => setVisible(!document.hidden);
		const query =
			typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;
		const motion = () => setReduced(query?.matches ?? false);
		document.addEventListener("visibilitychange", visibility);
		query?.addEventListener("change", motion);
		return () => {
			document.removeEventListener("visibilitychange", visibility);
			query?.removeEventListener("change", motion);
		};
	}, []);
	useEffect(() => {
		if (cursor.current.clip !== clip) {
			cursor.current = { clip, index: 0, complete: false, remaining: clip.frames[0]?.durationMs ?? 100 };
			setFrame({ clip, index: 0, complete: false });
		}
		const current = cursor.current;
		if (!enabled || !visible || reduced || current.complete) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let deadline = 0;
		let cancelled = false;
		const schedule = () => {
			deadline = performance.now() + current.remaining;
			timer = setTimeout(() => {
				if (cancelled) return;
				const next = nextAnimationFrame(clip, current.index);
				current.index = next.index;
				current.complete = next.complete;
				current.remaining = clip.frames[next.index]?.durationMs ?? 100;
				setFrame({ clip, ...next });
				if (!next.complete) schedule();
			}, current.remaining);
		};
		schedule();
		return () => {
			cancelled = true;
			clearTimeout(timer);
			if (!current.complete) current.remaining = Math.max(0, deadline - performance.now());
		};
	}, [clip, enabled, visible, reduced]);
	const value = frame.clip === clip ? frame : { index: 0, complete: false };
	return {
		index: value.index,
		complete: value.complete,
		playing: enabled && visible && !reduced && !value.complete,
	};
}
