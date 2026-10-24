import { useState } from "react";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentAttachments } from "../src/components/AgentAttachments.tsx";
import type { Send } from "../src/components/types.ts";
import type { OrchestrationClient } from "../src/orchestration.ts";
import { initialState } from "../src/store.ts";
import { AgentVoiceContext } from "../src/useAgentVoice.ts";
import { useVoice } from "../src/useVoice.ts";

afterEach(() => { delete window.__GENTLE_MOBILE__; localStorage.clear(); vi.unstubAllGlobals(); });
const client = {} as OrchestrationClient;
function Harness({ identity = "one", enabled = true, connected = true, transport = vi.fn<Send>(), onSend = vi.fn(async () => true), connection = client, files = false }: {
 identity?: string; enabled?: boolean; connected?: boolean; transport?: Send;
 onSend?: (text: string, refs?: unknown) => Promise<boolean>; connection?: OrchestrationClient; files?: boolean;
}) {
 const [text, setText] = useState("");
 return <AgentVoiceContext value={{ state: { ...initialState, connection: connected ? "open" : "closed" }, send: transport }}>
  <AgentAttachments key={identity} client={connection} paneId={`p:${identity}`} sessionId={identity} text={text} onText={setText} onSend={onSend} disabled={!enabled} images filesEnabled={files} />
 </AgentVoiceContext>;
}

it("uses the actual shared icon composer without a visible reply heading", () => {
 const view = render(<Harness files connection={{ uploadAttachment: vi.fn() } as unknown as OrchestrationClient} />);
 expect(view.container.querySelector("form.composer")).not.toBeNull();
 expect(screen.queryByText("Continuar esta sesión")).toBeNull();
 expect(screen.getByLabelText("Archivos para esta sesión")).toHaveAttribute("type", "file");
 expect(screen.getByRole("button", { name: "Enviar instrucción" }).textContent).toBe("");
 expect(view.container.querySelector("form form")).toBeNull();
});

it("dictates with files disabled, edits and manually submits; never sends Dot actions or cancels TTS", async () => {
 localStorage.setItem("gentle-dot-voice-send", "1");
 const transcribe = vi.fn(async () => ({ text: "captured draft" }));
 const cancel = vi.fn(); const speak = vi.fn();
 vi.stubGlobal("speechSynthesis", { cancel, speak });
 window.__GENTLE_MOBILE__ = { transcribe };
 const transport = vi.fn(); const onSend = vi.fn(async () => true);
 const h = render(<Harness transport={transport} onSend={onSend} />);
 expect(transcribe).not.toHaveBeenCalled();
 expect(screen.queryByLabelText("Archivos para esta sesión")).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "Dictar mensaje" }));
 await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("captured draft"));
 expect(onSend).not.toHaveBeenCalled();
 // Android Speech Activity hiding the main activity is not a navigation.
 fireEvent(document, new Event("visibilitychange"));
 fireEvent.change(screen.getByRole("textbox"), { target: { value: "edited draft" } });
 fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
 await waitFor(() => expect(onSend).toHaveBeenCalledWith("edited draft", undefined));
 h.unmount();
 expect(transport).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled(); expect(speak).not.toHaveBeenCalled();
 expect(localStorage.getItem("gentle-dot-voice-send")).toBe("1");
});

it.each(["session", "tab", "disconnect", "client", "unmount"])("ignores late native speech after %s", async change => {
 let resolve!: (result: { text: string }) => void;
 const transcribe = vi.fn(() => new Promise<{ text: string }>(done => { resolve = done; }));
 window.__GENTLE_MOBILE__ = { transcribe };
 const onSend = vi.fn(async () => true); const transport = vi.fn();
 const h = render(<Harness key="same" onSend={onSend} transport={transport} />);
 fireEvent.click(screen.getByRole("button", { name: "Dictar mensaje" }));
 if (change === "unmount") h.unmount();
 else h.rerender(<Harness key="same" connection={change === "client" ? {} as OrchestrationClient : client} identity={change === "session" ? "two" : "one"} enabled={change !== "tab"} connected={change !== "disconnect"} onSend={onSend} transport={transport} />);
 await act(async () => resolve({ text: "stale" }));
 expect(screen.queryByDisplayValue("stale")).toBeNull();
 expect(transport).not.toHaveBeenCalled(); expect(onSend).not.toHaveBeenCalled();
});

it("keeps a pending Android speech result when the main activity is hidden", async () => {
 let resolve!: (result: { text: string }) => void;
 window.__GENTLE_MOBILE__ = { transcribe: () => new Promise(done => { resolve = done; }) };
 render(<Harness />);
 fireEvent.click(screen.getByRole("button", { name: "Dictar mensaje" }));
 Object.defineProperty(document, "hidden", { configurable: true, value: true });
 fireEvent(document, new Event("visibilitychange"));
 await act(async () => resolve({ text: "still my session" }));
 expect(screen.getByRole("textbox")).toHaveValue("still my session");
 Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

it("stops a late microphone permission stream after input-only unmount", async () => {
 let resolve!: (stream: MediaStream) => void;
 const stop = vi.fn(); const send = vi.fn();
 vi.stubGlobal("isSecureContext", true);
 vi.stubGlobal("MediaRecorder", vi.fn());
 Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(() => new Promise(done => { resolve = done; })) } });
 const h = renderHook(() => useVoice({ ...initialState, voice: { ...initialState.voice, transcribe: true } }, send, { inputOnly: true, enabled: true }));
 act(() => h.result.current.start());
 h.unmount();
 await act(async () => resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream));
 expect(stop).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
 Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

it("locks synchronously and preserves text until matching acceptance, retaining rejection", async () => {
 let resolve!: (accepted: boolean) => void;
 const onSend = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
 render(<Harness onSend={onSend} />);
 fireEvent.change(screen.getByRole("textbox"), { target: { value: "keep me" } });
 const form = screen.getByRole("button", { name: "Enviar instrucción" }).closest("form")!;
 fireEvent.submit(form); fireEvent.submit(form);
 expect(onSend).toHaveBeenCalledTimes(1);
 expect(screen.getByRole("textbox")).toHaveValue("keep me");
 await act(async () => resolve(false));
 expect(screen.getByRole("textbox")).toHaveValue("keep me");
 fireEvent.submit(form);
 await act(async () => resolve(true));
 expect(screen.getByRole("textbox")).toHaveValue("");
});
