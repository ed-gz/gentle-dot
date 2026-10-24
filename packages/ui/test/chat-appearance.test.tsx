import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ChatAppearance } from "../src/components/ChatAppearance.tsx";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { initialState } from "../src/store.ts";
import {
	CHAT_APPEARANCE_KEY,
	chatAppearanceStyle,
	DEFAULT_CHAT_APPEARANCE,
	parseChatAppearance,
	useChatAppearance,
} from "../src/useChatAppearance.ts";

const oldShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const oldClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeAll(() => {
	Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
		configurable: true,
		value(this: HTMLDialogElement) {
			this.open = true;
		},
	});
	Object.defineProperty(HTMLDialogElement.prototype, "close", {
		configurable: true,
		value(this: HTMLDialogElement) {
			this.open = false;
		},
	});
});
afterAll(() => {
	if (oldShow) Object.defineProperty(HTMLDialogElement.prototype, "showModal", oldShow);
	else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
	if (oldClose) Object.defineProperty(HTMLDialogElement.prototype, "close", oldClose);
	else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
});

function contrast(a: string | undefined, b: string | undefined) {
	if (!a || !b) return 0;
	const luminance = (hex: string) => {
		const channels = [1, 3, 5].map((start) => {
			const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
			return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
		});
		return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
	};
	const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
	return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
}

describe("phone appearance preferences", () => {
	it("starts in Gentle dark and safely defaults malformed or unknown stored settings", () => {
		for (const input of [null, [], "pink", { version: 2, theme: "light" }]) {
			expect(parseChatAppearance(input)).toEqual(DEFAULT_CHAT_APPEARANCE);
		}
		expect(
			parseChatAppearance({
				version: 1,
				theme: "javascript",
				fontSize: 900,
				accent: "url(secret)",
				layout: false,
			}),
		).toEqual(DEFAULT_CHAT_APPEARANCE);
		localStorage.setItem(CHAT_APPEARANCE_KEY, "{broken");
		const { result } = renderHook(() => useChatAppearance(true));
		expect(result.current.settings).toEqual(DEFAULT_CHAT_APPEARANCE);
		expect(result.current.resolvedTheme).toBe("dark");
	});

	it("persists all choices locally across remount and restores the defaults", () => {
		const first = renderHook(() => useChatAppearance(true));
		const custom = {
			...DEFAULT_CHAT_APPEARANCE,
			theme: "light" as const,
			accent: "blue" as const,
			fontSize: 20 as const,
			density: "compact" as const,
			layout: "reading" as const,
			background: "dots" as const,
		};
		act(() => first.result.current.change(custom));
		expect(first.result.current.resolvedTheme).toBe("light");
		first.unmount();
		const second = renderHook(() => useChatAppearance(true));
		expect(second.result.current.settings).toEqual(custom);
		act(() => second.result.current.reset());
		expect(second.result.current.settings).toEqual(DEFAULT_CHAT_APPEARANCE);
		expect(JSON.parse(localStorage.getItem(CHAT_APPEARANCE_KEY) ?? "null")).toEqual(DEFAULT_CHAT_APPEARANCE);
	});

	it("keeps a working in-memory preference and explains storage denial", async () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("denied");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("denied");
		});
		function Settings() {
			const controls = useChatAppearance(true);
			return <ChatAppearance controls={controls} />;
		}
		render(<Settings />);
		await userEvent.click(screen.getByRole("radio", { name: "Claro" }));
		expect(screen.getByRole("radio", { name: "Claro" })).toBeChecked();
		expect(screen.getByRole("status")).toHaveTextContent("no permite guardar");
		await userEvent.click(screen.getByRole("button", { name: "Restaurar Gentle" }));
		expect(screen.getByRole("radio", { name: "Oscuro" })).toBeChecked();
	});

	it("follows system changes only when selected and removes the listener", () => {
		const listeners = new Set<() => void>();
		const media = {
			matches: false,
			addEventListener: vi.fn((_type: string, callback: () => void) => listeners.add(callback)),
			removeEventListener: vi.fn((_type: string, callback: () => void) => listeners.delete(callback)),
		};
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => media),
		);
		const { result, unmount } = renderHook(() => useChatAppearance(true));
		expect(result.current.resolvedTheme).toBe("dark");
		act(() => result.current.change({ ...DEFAULT_CHAT_APPEARANCE, theme: "system" }));
		expect(result.current.resolvedTheme).toBe("light");
		act(() => {
			media.matches = true;
			for (const listener of listeners) listener();
		});
		expect(result.current.resolvedTheme).toBe("dark");
		unmount();
		expect(listeners.size).toBe(0);
	});

	it("does not read or change appearance storage on the desktop", () => {
		const read = vi.spyOn(Storage.prototype, "getItem");
		const write = vi.spyOn(Storage.prototype, "setItem");
		const { result } = renderHook(() => useChatAppearance(false));
		act(() => result.current.change({ ...DEFAULT_CHAT_APPEARANCE, theme: "light" }));
		expect(read).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		expect(result.current.settings).toEqual(DEFAULT_CHAT_APPEARANCE);
	});

	it("keeps readable text, action and accent pairs in every palette and theme", () => {
		for (const dark of [false, true]) {
			for (const accent of ["gentle", "blue", "green", "amber"] as const) {
				const style = chatAppearanceStyle({ ...DEFAULT_CHAT_APPEARANCE, accent }, dark);
				for (const text of ["--text", "--muted", "--accent", "--chat-error", "--chat-success"]) {
					for (const background of ["--bg", "--surface", "--surface-2"]) {
						expect(
							contrast(style[text as `--${string}`], style[background as `--${string}`]),
							`${dark}/${accent}/${text}/${background}`,
						).toBeGreaterThanOrEqual(4.5);
					}
				}
				expect(contrast(style["--chat-action"], style["--chat-action-ink"])).toBeGreaterThanOrEqual(4.5);
				expect(contrast(style["--accent"], style["--accent-ink"])).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it("applies preferences with the keyboard and returns through tools before the chat draft", async () => {
		const send = vi.fn();
		const { container } = render(
			<ChatSurface
				variant="web"
				state={{ ...initialState, connection: "open", agentState: "idle" }}
				send={send}
				dismiss={() => {}}
				mobileControls={<p>Este teléfono</p>}
			/>,
		);
		await userEvent.type(screen.getByRole("textbox", { name: "Mensaje" }), "Mi borrador");
		await userEvent.click(screen.getByRole("button", { name: "Ajustes" }));
		await userEvent.click(screen.getByRole("button", { name: "Apariencia del chat" }));
		expect(screen.getByRole("main", { name: "Apariencia del chat" })).toBeInTheDocument();
		const dark = screen.getByRole("radio", { name: "Oscuro" });
		dark.focus();
		await userEvent.keyboard("{ArrowRight}");
		expect(screen.getByRole("radio", { name: "Claro" })).toBeChecked();
		expect(container.querySelector(".chat-mobile")).toHaveAttribute("data-chat-theme", "light");
		await userEvent.click(screen.getByRole("radio", { name: "20" }));
		expect(
			(container.querySelector(".chat-mobile") as HTMLElement).style.getPropertyValue("--chat-font-size"),
		).toBe("20px");
		const back = new Event("gentledot-back", { cancelable: true });
		act(() => window.dispatchEvent(back));
		expect(back.defaultPrevented).toBe(true);
		expect(screen.getByRole("main", { name: "Ajustes" })).toBeInTheDocument();
		fireEvent(window, new Event("gentledot-back", { cancelable: true }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveValue("Mi borrador");
		expect(send).not.toHaveBeenCalled();
	});
});
