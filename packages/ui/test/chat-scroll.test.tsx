import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatScroll } from "../src/useChatScroll.ts";

interface Message {
	id: string;
	top: number;
	height: number;
	paragraphTop?: number;
}
interface Geometry {
	height: number;
	total: number;
	top: number;
	writes: number[];
}
let frames: Map<number, FrameRequestCallback>;
let observers: { notify: () => void; disconnect: ReturnType<typeof vi.fn> }[];
beforeEach(() => {
	frames = new Map();
	observers = [];
	let nextFrame = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++nextFrame, callback);
		return nextFrame;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	vi.stubGlobal(
		"ResizeObserver",
		class {
			disconnect = vi.fn();
			notify: () => void;
			constructor(notify: () => void) {
				this.notify = notify;
				observers.push(this);
			}
			observe() {}
		},
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function resize() {
	act(() => {
		for (const observer of observers) observer.notify();
		const pending = [...frames.values()];
		frames.clear();
		for (const callback of pending) callback(0);
	});
}

function fixture() {
	const geometry: Geometry = { height: 300, total: 1000, top: 0, writes: [] };
	let messages: Message[] = Array.from({ length: 10 }, (_, index) => ({
		id: `m${index}`,
		top: index * 100,
		height: 100,
	}));
	let active = true;
	let conversationKey: string | undefined = "first";
	let controller!: ReturnType<typeof useChatScroll>;
	let viewport!: HTMLElement;
	let revision = 0;
	const rect = (top: number, height: number) => new DOMRect(0, top, 400, height);
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		if (this === viewport) return rect(80, active ? geometry.height : 0);
		const id = this.dataset.messageId ?? this.dataset.paragraphId;
		const message = messages.find((item) => item.id === id);
		if (!message) return rect(80 - geometry.top, geometry.total);
		return rect(
			80 + message.top + (this.dataset.paragraphId ? (message.paragraphTop ?? 0) : 0) - geometry.top,
			this.dataset.paragraphId ? 50 : message.height,
		);
	});
	function Chat() {
		controller = useChatScroll({ conversationKey, active });
		return (
			<>
				<main
					hidden={!active}
					ref={(node) => {
						controller.viewportRef.current = node;
						if (!node) return;
						viewport = node;
						Object.defineProperties(node, {
							clientHeight: { configurable: true, get: () => (active ? geometry.height : 0) },
							scrollHeight: { configurable: true, get: () => (active ? geometry.total : 0) },
							scrollTop: {
								configurable: true,
								get: () => geometry.top,
								set: (value: number) => {
									geometry.top = Math.max(0, Math.min(value, geometry.total - geometry.height));
									geometry.writes.push(geometry.top);
								},
							},
						});
					}}
				>
					<div ref={controller.contentRef}>
						{messages.map((message) => (
							<article key={message.id} data-message-id={message.id}>
								<div className="message-body">
									<p data-paragraph-id={message.id}>
										{message.id} · {revision}
									</p>
								</div>
							</article>
						))}
					</div>
				</main>
				<output>{controller.canJump ? "Earlier" : "Latest"}</output>
			</>
		);
	}
	const view = render(<Chat />);
	const renderAgain = () => {
		revision++;
		view.rerender(<Chat />);
	};
	const manualScroll = (top: number) => {
		// A user's scroll is distinct from writes made by the controller.
		geometry.top = top;
		fireEvent.scroll(viewport);
	};
	return {
		geometry,
		view,
		renderAgain,
		manualScroll,
		get viewport() {
			return viewport;
		},
		get controller() {
			return controller;
		},
		setMessages(value: Message[]) {
			messages = value;
		},
		get messages() {
			return messages;
		},
		setActive(value: boolean) {
			active = value;
			renderAgain();
		},
		setConversation(value: string | undefined) {
			conversationKey = value;
			renderAgain();
		},
	};
}

it("follows streaming at the bottom, then stops as soon as the reader moves up", () => {
	const chat = fixture();
	expect(chat.geometry.top).toBe(700);
	expect(chat.controller.canJump).toBe(false);
	chat.geometry.total += 200;
	chat.renderAgain();
	expect(chat.geometry.top).toBe(900);
	chat.manualScroll(250);
	expect(chat.controller.canJump).toBe(true);
	const writes = chat.geometry.writes.length;
	chat.geometry.total += 500;
	chat.renderAgain();
	resize();
	expect(chat.geometry.top).toBe(250);
	expect(chat.geometry.writes).toHaveLength(writes);
	act(() => chat.controller.jumpToLatest());
	expect(chat.geometry.top).toBe(1400);
	expect(chat.controller.canJump).toBe(false);
	chat.geometry.total += 100;
	resize();
	expect(chat.geometry.top).toBe(1500);
});

it("reattaches when the user scrolls back to the bottom", () => {
	const chat = fixture();
	chat.manualScroll(200);
	chat.manualScroll(700);
	chat.geometry.total += 100;
	resize();
	expect(chat.geometry.top).toBe(800);
	expect(chat.controller.canJump).toBe(false);
});

it("an upward wheel gesture wins over a content resize before the scroll event", () => {
	const chat = fixture();
	fireEvent.wheel(chat.viewport, { deltaY: -30 });
	chat.geometry.total += 100;
	resize();
	expect(chat.geometry.top).toBe(700);
	expect(chat.controller.canJump).toBe(true);
});

it("keeps the latest reading anchor when history arrives after another user scroll", () => {
	const chat = fixture();
	chat.manualScroll(200);
	act(() => chat.controller.prepareForPrepend());
	chat.manualScroll(340);
	chat.geometry.total += 300;
	chat.setMessages([
		{ id: "older", top: 0, height: 300 },
		...chat.messages.map((message) => ({ ...message, top: message.top + 300 })),
	]);
	chat.renderAgain();
	expect(chat.geometry.top).toBe(640);
	expect(chat.view.container.querySelector('[data-paragraph-id="m3"]')?.getBoundingClientRect().top).toBe(40);
	expect(chat.controller.canJump).toBe(true);
	resize();
	expect(chat.geometry.top).toBe(640);
});

it("anchors a visible paragraph when an earlier image inside the same long message grows", () => {
	const chat = fixture();
	chat.setMessages([{ id: "long", top: 0, height: 1000, paragraphTop: 400 }]);
	chat.renderAgain();
	chat.manualScroll(420);
	chat.geometry.total += 180;
	chat.setMessages([{ id: "long", top: 0, height: 1180, paragraphTop: 580 }]);
	resize();
	expect(chat.geometry.top).toBe(600);
	expect(chat.view.container.querySelector("p")?.getBoundingClientRect().top).toBe(60);
	expect(chat.controller.canJump).toBe(true);
});

it("preserves a message anchor if markdown replaces the paragraph node", () => {
	const chat = fixture();
	chat.manualScroll(220);
	const paragraph = chat.view.container.querySelector('[data-paragraph-id="m2"]');
	paragraph?.replaceWith(paragraph.cloneNode(true));
	chat.geometry.total += 150;
	chat.setMessages(chat.messages.map((message) => ({ ...message, top: message.top + 150 })));
	resize();
	expect(chat.geometry.top).toBe(370);
});

it("handles keyboard/viewport resize without changing the reading position", () => {
	const chat = fixture();
	chat.geometry.height = 160;
	resize();
	expect(chat.geometry.top).toBe(840);
	chat.manualScroll(260);
	chat.geometry.height = 300;
	resize();
	expect(chat.geometry.top).toBe(260);
	chat.geometry.height = 140;
	resize();
	expect(chat.geometry.top).toBe(260);
});

it("keeps the anchor while hidden in Agents, including history that grows in the background", () => {
	const chat = fixture();
	chat.manualScroll(320);
	chat.setActive(false);
	const writes = chat.geometry.writes.length;
	chat.geometry.total += 400;
	chat.setMessages(chat.messages.map((message) => ({ ...message, top: message.top + 100 })));
	chat.renderAgain();
	resize();
	expect(chat.geometry.writes).toHaveLength(writes);
	chat.setActive(true);
	expect(chat.geometry.top).toBe(420);
	expect(chat.controller.canJump).toBe(true);
});

it("resets only when the conversation identity changes and restores browser anchoring on unmount", () => {
	const chat = fixture();
	chat.manualScroll(150);
	chat.setConversation("second");
	expect(chat.geometry.top).toBe(700);
	expect(chat.viewport.style.overflowAnchor).toBe("none");
	chat.manualScroll(200);
	chat.renderAgain();
	expect(chat.geometry.top).toBe(200);
	const viewport = chat.viewport;
	chat.view.unmount();
	expect(viewport.style.overflowAnchor).toBe("");
	expect(observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);
});
