import { useCallback, useLayoutEffect, useRef, useState } from "react";

interface ChatScrollOptions {
	conversationKey: string | undefined;
	/** Keep this false while another screen covers the mounted transcript. */
	active: boolean;
}
interface Anchor {
	node: Element;
	offset: number;
	messageId?: string;
	messageOffset?: number;
}
interface Position {
	initialized: boolean;
	key: string | undefined;
	following: boolean;
	anchor?: Anchor;
	expectedTop?: number;
}
const TOLERANCE = 2;
const distance = (viewport: HTMLElement) =>
	Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop);
const visible = (viewport: HTMLElement, active: boolean) =>
	active && !viewport.hidden && viewport.clientHeight > 0;

/** Prefer the text block being read, rather than the top of a potentially very long message. */
function capture(viewport: HTMLElement, content: HTMLElement): Anchor | undefined {
	const box = viewport.getBoundingClientRect();
	const intersects = (element: Element) => {
		const rect = element.getBoundingClientRect();
		return rect.height > 0 && rect.bottom > box.top && rect.top < box.top + viewport.clientHeight;
	};
	for (const message of content.querySelectorAll<HTMLElement>("[data-message-id]")) {
		if (!intersects(message)) continue;
		const blocks = message.querySelectorAll(
			".message-body p, .message-body pre, .message-body li, .message-body table, .message-body img, .message-body h1, .message-body h2, .message-body h3, .message-note",
		);
		const node = [...blocks].find(intersects) ?? message;
		return {
			node,
			offset: node.getBoundingClientRect().top - box.top,
			messageId: message.dataset.messageId,
			messageOffset: message.getBoundingClientRect().top - box.top,
		};
	}
	const node = [...content.children].find(intersects);
	return node ? { node, offset: node.getBoundingClientRect().top - box.top } : undefined;
}

/** A single owner for transcript scrolling. It never scrolls the window or an ancestor. */
export function useChatScroll(options: ChatScrollOptions) {
	const viewportRef = useRef<HTMLElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const currentOptions = useRef(options);
	currentOptions.current = options;
	const position = useRef<Position>({ initialized: false, key: options.conversationKey, following: true });
	const [canJump, setCanJump] = useState(false);

	const move = useCallback((viewport: HTMLElement, top: number) => {
		const target = Math.max(0, Math.min(top, viewport.scrollHeight - viewport.clientHeight));
		if (Math.abs(viewport.scrollTop - target) > 0.5) {
			position.current.expectedTop = target;
			viewport.scrollTop = target;
		}
	}, []);
	const refresh = useCallback(() => {
		const viewport = viewportRef.current;
		const content = contentRef.current;
		const state = position.current;
		const { active, conversationKey } = currentOptions.current;
		if (state.key !== conversationKey) {
			state.key = conversationKey;
			state.following = true;
			state.initialized = false;
			state.anchor = undefined;
		}
		if (!viewport || !content || !visible(viewport, active)) return;
		if (!state.initialized) {
			state.initialized = true;
			state.following = true;
		}
		if (state.following) {
			move(viewport, viewport.scrollHeight - viewport.clientHeight);
			state.anchor = undefined;
		} else if (state.anchor) {
			const anchor = state.anchor;
			let node = anchor.node;
			let offset = anchor.offset;
			if (!content.contains(node) && anchor.messageId) {
				const fallback = [...content.querySelectorAll<HTMLElement>("[data-message-id]")].find(
					(message) => message.dataset.messageId === anchor.messageId,
				);
				if (fallback) {
					node = fallback;
					offset = anchor.messageOffset ?? anchor.offset;
				}
			}
			if (content.contains(node)) {
				const delta = node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset;
				if (Math.abs(delta) > 0.5) move(viewport, viewport.scrollTop + delta);
			}
			state.anchor = capture(viewport, content);
		}
		if (!state.following && !state.anchor) state.anchor = capture(viewport, content);
		setCanJump(distance(viewport) > TOLERANCE);
	}, [move]);

	const jumpToLatest = useCallback(() => {
		position.current.following = true;
		position.current.anchor = undefined;
		refresh();
	}, [refresh]);
	const prepareForPrepend = useCallback(() => {
		const viewport = viewportRef.current;
		const content = contentRef.current;
		if (!viewport || !content || !visible(viewport, currentOptions.current.active)) return;
		position.current.following = false;
		position.current.anchor = capture(viewport, content);
	}, []);

	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		const content = contentRef.current;
		if (!viewport || !content) return;
		const oldAnchoring = viewport.style.overflowAnchor;
		viewport.style.overflowAnchor = "none";
		let frame: number | undefined;
		let touchY: number | undefined;
		const schedule = () => {
			if (frame !== undefined) return;
			frame = requestAnimationFrame(() => {
				frame = undefined;
				refresh();
			});
		};
		const reading = () => {
			if (!visible(viewport, currentOptions.current.active)) return;
			position.current.following = false;
			position.current.expectedTop = undefined;
			position.current.anchor = capture(viewport, content);
		};
		const onScroll = () => {
			if (!visible(viewport, currentOptions.current.active)) return;
			const state = position.current;
			const expected = state.expectedTop;
			state.expectedTop = undefined;
			if (expected === undefined || Math.abs(viewport.scrollTop - expected) > TOLERANCE)
				state.following = distance(viewport) <= TOLERANCE;
			state.anchor = state.following ? undefined : capture(viewport, content);
			setCanJump(distance(viewport) > TOLERANCE);
		};
		const onWheel = (event: WheelEvent) => {
			if (event.deltaY < 0) reading();
		};
		const onTouchStart = (event: TouchEvent) => {
			touchY = event.touches[0]?.clientY;
		};
		const onTouchMove = (event: TouchEvent) => {
			const y = event.touches[0]?.clientY;
			if (touchY !== undefined && y !== undefined && y > touchY) reading();
			touchY = y;
		};
		const onKey = (event: KeyboardEvent) => {
			if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey))
				reading();
		};
		viewport.addEventListener("scroll", onScroll, { passive: true });
		viewport.addEventListener("wheel", onWheel, { passive: true });
		viewport.addEventListener("touchstart", onTouchStart, { passive: true });
		viewport.addEventListener("touchmove", onTouchMove, { passive: true });
		viewport.addEventListener("keydown", onKey);
		content.addEventListener("load", schedule, true);
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
		observer?.observe(viewport);
		observer?.observe(content);
		window.addEventListener("resize", schedule);
		return () => {
			observer?.disconnect();
			if (frame !== undefined) cancelAnimationFrame(frame);
			viewport.removeEventListener("scroll", onScroll);
			viewport.removeEventListener("wheel", onWheel);
			viewport.removeEventListener("touchstart", onTouchStart);
			viewport.removeEventListener("touchmove", onTouchMove);
			viewport.removeEventListener("keydown", onKey);
			content.removeEventListener("load", schedule, true);
			window.removeEventListener("resize", schedule);
			viewport.style.overflowAnchor = oldAnchoring;
		};
	}, [refresh]);
	// Layout runs also cover text/tool mutations which do not change the content's total height.
	useLayoutEffect(refresh);
	return {
		viewportRef,
		contentRef,
		canJump,
		jumpToLatest,
		prepareForPrepend,
		isAtLatest: () =>
			position.current.following && (!viewportRef.current || distance(viewportRef.current) <= TOLERANCE),
	};
}
