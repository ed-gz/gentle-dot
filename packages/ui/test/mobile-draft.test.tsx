import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import type { MobileDraftSaveResult, MobileDraftSnapshot } from "../src/mobile.ts";
import { initialState } from "../src/store.ts";
import { useMobileDraft } from "../src/useMobileDraft.ts";

afterEach(() => {
	delete window.__GENTLE_MOBILE__;
	vi.useRealTimers();
});
const saved = (text = "", revision = "0"): MobileDraftSnapshot => ({ text, revision });
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function storage() {
	let next = 0;
	const drafts = new Map<string, MobileDraftSnapshot>();
	return {
		read: async (key: string) => drafts.get(key) ?? saved(),
		write: async (key: string, text: string, expectedRevision: string): Promise<MobileDraftSaveResult> => {
			const previous = drafts.get(key) ?? saved();
			if (previous.revision !== expectedRevision) return { ...previous, applied: false };
			const current = saved(text, String(++next));
			drafts.set(key, current);
			return { ...current, applied: true };
		},
	};
}
function native(
	read = vi.fn(async (_key: string): Promise<MobileDraftSnapshot> => saved()),
	write = vi.fn(
		async (_key: string, text: string, _revision: string): Promise<MobileDraftSaveResult> => ({
			...saved(text, "1"),
			applied: true,
		}),
	),
) {
	window.__GENTLE_MOBILE__ = { transcribe: vi.fn(), readDraft: read, saveDraft: write };
	return { read, write };
}

it("restores a native encrypted draft without writing an empty value over it", async () => {
	const bridge = native(vi.fn(async () => saved("Already saved", "1")));
	const { result, unmount } = renderHook(() => useMobileDraft("device-a/conversation-a"));
	await act(async () => {});
	expect(result.current?.text).toBe("Already saved");
	unmount();
	expect(bridge.write).not.toHaveBeenCalled();
});

it("never overwrites new typing with a delayed initial restore and saves against its native revision", async () => {
	const load = deferred<MobileDraftSnapshot>();
	const bridge = native(vi.fn(() => load.promise));
	const { result } = renderHook(() => useMobileDraft("device-a/chat"));
	act(() => result.current?.onText("A new draft"));
	await act(async () => window.dispatchEvent(new Event("gentledot-pause")));
	expect(bridge.write).not.toHaveBeenCalled();
	await act(async () => load.resolve(saved("Old saved draft", "4")));
	expect(result.current?.text).toBe("A new draft");
	expect(bridge.write).toHaveBeenLastCalledWith("device-a/chat", "A new draft", "4");
});

it("serializes saves so an earlier slow write cannot restore text after Send", async () => {
	vi.useFakeTimers();
	const pending = deferred<MobileDraftSaveResult>();
	const write = vi.fn(
		async (_key: string, text: string, _revision: string): Promise<MobileDraftSaveResult> => ({
			...saved(text, "2"),
			applied: true,
		}),
	);
	write.mockImplementationOnce(() => pending.promise);
	native(undefined, write);
	const { result } = renderHook(() => useMobileDraft("device/chat"));
	await act(async () => {});
	act(() => result.current?.onText("Send this"));
	await act(async () => vi.advanceTimersByTimeAsync(300));
	act(() => result.current?.onText(""));
	expect(write).toHaveBeenCalledTimes(1);
	await act(async () => pending.resolve({ ...saved("Send this", "1"), applied: true }));
	expect(write.mock.calls).toEqual([
		["device/chat", "Send this", "0"],
		["device/chat", "", "1"],
	]);
});

it("scopes drafts to the selected account and conversation and ignores an old restore", async () => {
	const load = deferred<MobileDraftSnapshot>();
	const read = vi.fn(async (key: string) => saved(`${key} saved`, "2"));
	read.mockImplementationOnce(() => load.promise);
	const bridge = native(read);
	const hook = renderHook(({ key }) => useMobileDraft(key), { initialProps: { key: "account-a/chat-a" } });
	await act(async () => {});
	hook.rerender({ key: "account-b/chat-b" });
	await act(async () => load.resolve(saved("Account A private draft", "1")));
	expect(hook.result.current?.text).toBe("account-b/chat-b saved");
	act(() => hook.result.current?.onText("Account B edit"));
	hook.unmount();
	await act(async () => {});
	expect(bridge.write).toHaveBeenLastCalledWith("account-b/chat-b", "Account B edit", "2");
});

it("keeps the visible text and reports a native storage failure", async () => {
	const write = vi.fn(async () => {
		throw new Error("Storage locked");
	});
	native(undefined, write);
	const { result } = renderHook(() => useMobileDraft("device/chat"));
	await act(async () => {});
	act(() => result.current?.onText("Keep this here"));
	await act(async () => window.dispatchEvent(new Event("pagehide")));
	await act(async () => window.dispatchEvent(new Event("gentledot-resume")));
	expect(result.current?.text).toBe("Keep this here");
	expect(result.current?.note).toContain("No se pudo guardar");
});

it("recovers main-window edits when the retained chat resumes and never resurrects accepted text", async () => {
	const disk = storage();
	await disk.write("device/chat", "Chat A", "0");
	const bridge = native(vi.fn(disk.read), vi.fn(disk.write));
	const { result } = renderHook(() => useMobileDraft("device/chat"));
	await act(async () => {});
	expect(result.current?.text).toBe("Chat A");
	// The main Activity has its own JS context but shares the native revision.
	const fromMain = await disk.write("device/chat", "Main B", "1");
	await act(async () => window.dispatchEvent(new Event("gentledot-resume")));
	expect(result.current?.text).toBe("Main B");
	await act(async () => result.current?.onText(""));
	expect(bridge.write).toHaveBeenLastCalledWith("device/chat", "", fromMain.revision);
	const stale = await disk.write("device/chat", "Chat A", "1");
	expect(stale.applied).toBe(false);
	await act(async () => window.dispatchEvent(new Event("gentledot-resume")));
	expect(result.current?.text).toBe("");
});

it("waits for a pending pause save before rehydrating a newer edit from the main WebView", async () => {
	const disk = storage();
	const response = deferred<MobileDraftSaveResult>();
	let first!: MobileDraftSaveResult;
	const write = vi.fn(disk.write).mockImplementationOnce(async (key, text, revision) => {
		first = await disk.write(key, text, revision);
		return response.promise;
	});
	native(vi.fn(disk.read), write);
	const { result } = renderHook(() => useMobileDraft("device/chat"));
	await act(async () => {});
	act(() => result.current?.onText("Chat A"));
	await act(async () => window.dispatchEvent(new Event("gentledot-pause")));
	await disk.write("device/chat", "Main B", first.revision);
	await act(async () => window.dispatchEvent(new Event("gentledot-resume")));
	expect(result.current?.text).toBe("Chat A");
	await act(async () => response.resolve(first));
	expect(result.current?.text).toBe("Main B");
});

it("preserves recent typing while a resume read is pending", async () => {
	const response = deferred<MobileDraftSnapshot>();
	const read = vi.fn(async () => saved("Chat A", "1"));
	read.mockImplementationOnce(async () => saved("Chat A", "1"));
	read.mockImplementationOnce(() => response.promise);
	native(read);
	const { result } = renderHook(() => useMobileDraft("device/chat"));
	await act(async () => {});
	await act(async () => window.dispatchEvent(new Event("gentledot-resume")));
	act(() => result.current?.onText("Typing now"));
	await act(async () => response.resolve(saved("Main B", "2")));
	expect(result.current?.text).toBe("Typing now");
});

it("ignores a resume read that completes after a newer resume", async () => {
	const older = deferred<MobileDraftSnapshot>(),
		newer = deferred<MobileDraftSnapshot>();
	const read = vi.fn(async () => saved("Chat A", "1"));
	read.mockImplementationOnce(async () => saved("Chat A", "1"));
	read.mockImplementationOnce(() => older.promise);
	read.mockImplementationOnce(() => newer.promise);
	native(read);
	const { result } = renderHook(() => useMobileDraft("device/chat"));
	await act(async () => {});
	await act(async () => window.dispatchEvent(new Event("gentledot-resume")));
	await act(async () => window.dispatchEvent(new Event("gentledot-resume")));
	await act(async () => newer.resolve(saved("Latest main edit", "3")));
	await act(async () => older.resolve(saved("Earlier main edit", "2")));
	expect(result.current?.text).toBe("Latest main edit");
});

it("does not rebase a queued clear over a conflicting newer draft in the other WebView", async () => {
	const disk = storage(),
		release = deferred<void>();
	await disk.write("device/chat", "Original", "0");
	const write = vi.fn(disk.write).mockImplementationOnce(async (...args) => {
		await release.promise;
		return disk.write(...args);
	});
	native(vi.fn(disk.read), write);
	const { result } = renderHook(() => useMobileDraft("device/chat"));
	await act(async () => {});
	act(() => result.current?.onText("Edited A"));
	await act(async () => window.dispatchEvent(new Event("gentledot-pause")));
	act(() => result.current?.onText(""));
	await disk.write("device/chat", "New main draft B", "1");
	await act(async () => release.resolve());
	expect(write).toHaveBeenCalledOnce();
	expect(await disk.read("device/chat")).toMatchObject({ text: "New main draft B" });
	await act(async () => window.dispatchEvent(new Event("gentledot-resume")));
	expect(result.current?.text).toBe("New main draft B");
});

it("retains a conflicting unsaved edit across resume without overwriting the other WebView", async () => {
	const disk = storage();
	await disk.write("device/chat", "Original", "0");
	const bridge = native(vi.fn(disk.read), vi.fn(disk.write));
	const { result } = renderHook(() => useMobileDraft("device/chat"));
	await act(async () => {});
	act(() => result.current?.onText("Unsaved local A"));
	await disk.write("device/chat", "New main B", "1");
	await act(async () => window.dispatchEvent(new Event("gentledot-pause")));
	expect(result.current?.note).toContain("El borrador cambió");
	await act(async () => window.dispatchEvent(new Event("gentledot-resume")));
	expect(result.current?.text).toBe("Unsaved local A");
	expect(result.current?.note).toContain("El borrador cambió");
	expect(await disk.read("device/chat")).toMatchObject({ text: "New main B" });
	expect(bridge.write).toHaveBeenCalledOnce();
	act(() => result.current?.onText("Explicit local edit C"));
	await act(async () => window.dispatchEvent(new Event("gentledot-pause")));
	expect(await disk.read("device/chat")).toMatchObject({ text: "Explicit local edit C" });
	expect(result.current?.note).toBeUndefined();
});

it("does not clear the other WebView's draft when a conflicting local message is sent", async () => {
	const disk = storage();
	await disk.write("device/chat", "Original", "0");
	const bridge = native(vi.fn(disk.read), vi.fn(disk.write));
	const { result } = renderHook(() => useMobileDraft("device/chat"));
	await act(async () => {});
	act(() => result.current?.onText("Local message A"));
	await disk.write("device/chat", "Unsent main draft B", "1");
	await act(async () => window.dispatchEvent(new Event("gentledot-pause")));
	expect(result.current?.note).toContain("El borrador cambió");
	await act(async () => result.current?.onText(""));
	expect(result.current?.text).toBe("");
	expect(bridge.write).toHaveBeenCalledOnce();
	expect(await disk.read("device/chat")).toMatchObject({ text: "Unsent main draft B" });
	await act(async () => window.dispatchEvent(new Event("gentledot-resume")));
	expect(result.current?.text).toBe("Unsent main draft B");
});

it("preserves the main chat draft when its transport refuses the send", async () => {
	const bridge = native(vi.fn(async () => saved("Draft that must survive", "1")));
	const send = vi.fn(() => false);
	render(
		<ChatSurface
			variant="web"
			mobileControls={<span>Phone</span>}
			mobileDraftScope="paired-account"
			state={{ ...initialState, connection: "open", agentState: "idle" }}
			send={send}
			dismiss={vi.fn()}
		/>,
	);
	const text = screen.getByRole("textbox", { name: "Mensaje" });
	await act(async () => {});
	expect(text).toHaveValue("Draft that must survive");
	fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje" }));
	expect(text).toHaveValue("Draft that must survive");
	expect(bridge.write).not.toHaveBeenCalledWith(expect.anything(), "", expect.anything());
});

it("does not persist web drafts or cross the native bridge without an explicit device scope", () => {
	const bridge = native();
	const { result } = renderHook(() => useMobileDraft());
	expect(result.current).toBeUndefined();
	expect(bridge.read).not.toHaveBeenCalled();
});
