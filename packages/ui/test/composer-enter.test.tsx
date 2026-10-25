import { useState } from "react";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Composer } from "../src/components/Composer.tsx";
import { AgentAttachments } from "../src/components/AgentAttachments.tsx";
import type { OrchestrationClient } from "../src/orchestration.ts";

const client = {} as OrchestrationClient;
afterEach(() => { cleanup(); delete window.__GENTLE_MOBILE__; vi.unstubAllGlobals(); });

function AgentHarness({ send }: { send: (text: string) => Promise<boolean> }) {
 const [text, setText] = useState("");
 return <AgentAttachments client={client} paneId="p" sessionId="s" text={text} onText={setText} onSend={send} disabled={false} images={false} filesEnabled={false} />;
}

it.each(["mobile prop", "coarse pointer", "mobile shell", "agent session"])("keeps Enter as a newline and sends only by button: %s", async mode => {
 const send = vi.fn(() => true);
 const agentSend = vi.fn(async () => true);
 vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: mode === "coarse pointer" && query === "(pointer: coarse)" })));
 if (mode === "mobile shell" || mode === "agent session") window.__GENTLE_MOBILE__ = { transcribe: vi.fn(async () => ({ text: "" })) };
 render(mode === "agent session" ? <AgentHarness send={agentSend} /> : <Composer mobile={mode === "mobile prop"} busy={false} disabled={false} send={send} />);
 const box = screen.getByRole("textbox");
 fireEvent.change(box, { target: { value: "first" } });
 // jsdom doesn't implement textarea's default newline insertion. Verify it isn't
 // cancelled, then simulate the browser's resulting input value.
 expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(true);
 expect(send).not.toHaveBeenCalled(); expect(agentSend).not.toHaveBeenCalled();
 expect(box).toHaveAttribute("enterkeyhint", "enter");
 fireEvent.change(box, { target: { value: "first\nsecond" } });
 expect(box).toHaveValue("first\nsecond");
 fireEvent.click(screen.getByRole("button", { name: /^(Send|Enviar mensaje|Enviar instrucción)$/ }));
 await waitFor(() => mode === "agent session"
  ? expect(agentSend).toHaveBeenCalledWith("first\nsecond", undefined)
  : expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "send", text: "first\nsecond" })));
});

it("keeps desktop Enter-to-send and Shift+Enter newline", () => {
 const send = vi.fn();
 render(<Composer busy={false} disabled={false} send={send} />);
 const box = screen.getByRole("textbox");
 fireEvent.change(box, { target: { value: "desktop" } });
 expect(fireEvent.keyDown(box, { key: "Enter", shiftKey: true })).toBe(true);
 expect(send).not.toHaveBeenCalled(); expect(box).toHaveValue("desktop");
 expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(false);
 expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "send", text: "desktop" }));
});

it("keeps desktop agent sessions Enter-to-send despite their compact Spanish copy", async () => {
 const send = vi.fn(async () => true);
 render(<AgentHarness send={send} />);
 const box = screen.getByRole("textbox");
 fireEvent.change(box, { target: { value: "desktop session" } });
 expect(fireEvent.keyDown(box, { key: "Enter", shiftKey: true })).toBe(true);
 expect(send).not.toHaveBeenCalled();
 expect(fireEvent.keyDown(box, { key: "Enter", isComposing: true })).toBe(true);
 expect(send).not.toHaveBeenCalled();
 fireEvent.keyDown(box, { key: "Enter" });
 await waitFor(() => expect(send).toHaveBeenCalledWith("desktop session", undefined));
});

it.each([false, true])("never sends an IME composition (mobile=%s)", mobile => {
 const send = vi.fn();
 render(<Composer mobile={mobile} busy={false} disabled={false} send={send} />);
 const box = screen.getByRole("textbox");
 fireEvent.change(box, { target: { value: "composition" } });
 expect(fireEvent.keyDown(box, { key: "Enter", isComposing: true })).toBe(true);
 expect(send).not.toHaveBeenCalled();
});
