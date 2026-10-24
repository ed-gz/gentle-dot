import type { CompanionActivityKind } from "@gentle-dot/protocol";

export type { CompanionActivityKind } from "@gentle-dot/protocol";

import { useEffect, useRef, useState } from "react";

export interface CompanionTarget {
	x: number;
	y: number;
	width: number;
	height: number;
}
export interface CompanionLocalActivity {
	kind: CompanionActivityKind;
	/** Changes on a new activity, not on every keystroke. */
	sequence: number;
	target?: CompanionTarget;
}
export const COMPANION_ACTIVITY_EVENT = "gentle-dot-companion-activity";
const durations: Record<CompanionActivityKind, number> = {
	rest: 0,
	greeting: 4500,
	typing: 4000,
	reading: 5000,
	response: 6000,
	sending: 12_000,
	submitted: 4500,
	queued: 6000,
	failed: 7000,
};
export function companionTarget(element?: Element | null): CompanionTarget | undefined {
	if (!element) return;
	const rect = element.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return;
	return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}
/** Only a coarse action and local geometry cross this event. Never include a draft or message. */
export function publishCompanionActivity(kind: CompanionActivityKind, element?: Element | null) {
	window.dispatchEvent(
		new CustomEvent(COMPANION_ACTIVITY_EVENT, { detail: { kind, target: companionTarget(element) } }),
	);
}
function editable(target: EventTarget | null): HTMLElement | undefined {
	if (!(target instanceof HTMLElement) || target.closest(".capri-overlay, [data-companion-layer]")) return;
	if (target instanceof HTMLTextAreaElement) return target;
	if (
		target instanceof HTMLInputElement &&
		["text", "search", "email", "url"].includes(target.type) &&
		!/(?:password|cc-|one-time-code)/i.test(target.autocomplete)
	)
		return target;
	return target.closest<HTMLElement>("[contenteditable='true'], [role='textbox']") ?? undefined;
}

/** Event driven: observes activity without reading values or listening to global keyboard input. */
export function useCompanionActivity(enabled: boolean): CompanionLocalActivity {
	const [activity, setActivity] = useState<CompanionLocalActivity>({ kind: "greeting", sequence: 0 });
	const current = useRef(activity);
	current.current = activity;
	useEffect(() => {
		if (!enabled) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let lastMeasure = 0;
		const update = (kind: CompanionActivityKind, element?: Element, supplied?: CompanionTarget) => {
			if (document.hidden) return;
			clearTimeout(timer);
			const changed = current.current.kind !== kind;
			// Long typing runs get gentle variation, without rendering on each key.
			const measured = changed || Date.now() - lastMeasure > 750;
			if (measured) {
				lastMeasure = Date.now();
				const next = {
					kind,
					sequence: current.current.sequence + (changed ? 1 : 0),
					target: supplied ?? companionTarget(element),
				};
				current.current = next;
				setActivity(next);
			}
			if (durations[kind])
				timer = setTimeout(() => {
					const next: CompanionLocalActivity = { kind: "rest", sequence: current.current.sequence };
					current.current = next;
					setActivity(next);
				}, durations[kind]);
		};
		const input = (event: Event) => {
			const target = editable(event.target);
			if (target) update("typing", target);
		};
		const scroll = () => {
			if (
				["sending", "submitted", "queued", "failed"].includes(current.current.kind) ||
				(current.current.kind === "typing" && editable(document.activeElement))
			)
				return;
			update("reading");
		};
		const explicit = (event: Event) => {
			const detail = (event as CustomEvent<{ kind?: CompanionActivityKind; target?: CompanionTarget }>)
				.detail;
			if (detail?.kind === "response" && ["typing", "sending", "submitted"].includes(current.current.kind))
				return;
			if (detail && detail.kind && Object.hasOwn(durations, detail.kind))
				update(detail.kind, undefined, detail.target);
		};
		const visibility = () => {
			if (document.hidden) {
				clearTimeout(timer);
				const next = { kind: "rest" as const, sequence: current.current.sequence };
				current.current = next;
				setActivity(next);
			}
		};
		update("greeting");
		document.addEventListener("input", input, { passive: true });
		document.addEventListener("scroll", scroll, { capture: true, passive: true });
		document.addEventListener("visibilitychange", visibility);
		window.addEventListener(COMPANION_ACTIVITY_EVENT, explicit);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("input", input);
			document.removeEventListener("scroll", scroll, true);
			document.removeEventListener("visibilitychange", visibility);
			window.removeEventListener(COMPANION_ACTIVITY_EVENT, explicit);
		};
	}, [enabled]);
	return activity;
}

/** Reacts only to a new response after the initial history, without reading its contents. */
export function useCompanionResponse(
	id: string | undefined,
	identity: string | undefined,
	active: boolean,
	selector: string,
) {
	const previous = useRef<{ id?: string; identity?: string }>({});
	useEffect(() => {
		const before = previous.current;
		previous.current = { id, identity };
		if (!active || !id || !before.id || before.identity !== identity || before.id === id) return;
		const element = [...document.querySelectorAll(selector)]
			.filter((e) => {
				const r = e.getBoundingClientRect();
				return r.width > 0 && r.height > 0;
			})
			.at(-1);
		const rect = element?.getBoundingClientRect();
		const visible =
			rect &&
			rect.bottom > 0 &&
			rect.right > 0 &&
			rect.top < window.innerHeight &&
			rect.left < window.innerWidth;
		// A reply below the current scroll position is real activity, but not a visible anchor.
		publishCompanionActivity("response", visible ? element : undefined);
	}, [id, identity, active, selector]);
}
