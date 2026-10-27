import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { OrchestrationPanel } from "../src/components/OrchestrationPanel.tsx";
import { Composer } from "../src/components/Composer.tsx";
import { FloatingNotices } from "../src/components/FloatingNotices.tsx";
import { SessionWorkShelf } from "../src/components/SessionMobileControls.tsx";
import { AgentWorkflow } from "../src/components/AgentWorkflow.tsx";
import { initialState } from "../src/store.ts";
import { COMPANION_KEY, useCompanion } from "../src/useCompanion.ts";
import { CapriCompanion } from "../src/components/CapriCompanion.tsx";
import { capriAnimation } from "../src/capri-animation.ts";
import { capriFrame } from "../src/capri-art.ts";
import type { AgentWork, OrchestrationSnapshot, OrchestrationClient } from "../src/orchestration.ts";
import type { VoiceControls } from "../src/useVoice.ts";
import type { AttachmentControls } from "../src/useAttachments.ts";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import capriCss from "../../theme-capri/src/style.css?raw";
// Vitest disables CSS processing in this project (including ?raw); inspect the
// same shipped source in that runner, without changing the production config.
const themeCss = capriCss || readFileSync(resolve(__dirname, "../../theme-capri/src/style.css"), "utf8");

afterEach(() => localStorage.clear());
it("marks only the Capri send action and explicitly retains red/white styling when disabled", () => {
 const view = render(<Composer mobile capriMobile busy={false} disabled={false} send={vi.fn()} />);
 const button = screen.getByRole("button", { name: "Enviar mensaje" });
 expect(button).toHaveClass("composer-send-capri");
 expect(button).toBeDisabled();
 expect(button.querySelector("svg")).not.toBeNull();
 fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hola" } });
 expect(button).toBeEnabled();
 const rule = (selector: string) => themeCss.slice(themeCss.indexOf(selector)).split("}")[0];
 for (const selector of [
  '.chat-mobile[data-companion="capri"] .composer-send.composer-send-capri {',
  '.chat-mobile[data-companion="capri"] .composer-send.composer-send-capri:disabled {',
 ]) {
  expect(themeCss.includes(selector)).toBe(true);
  expect(rule(selector)).toContain("background: var(--capri-notice-send)");
  expect(rule(selector)).toContain("color: #fff");
 }
 expect(rule('.chat-mobile[data-companion="capri"] .composer-send.composer-send-capri:disabled {')).toMatch(/opacity:\s*\.5/);
 fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
 view.rerender(<Composer mobile capriMobile busy disabled={false} send={vi.fn()} />);
 expect(screen.getByRole("button", { name: "Detener respuesta" })).not.toHaveClass("composer-send-capri");
 view.rerender(<Composer mobile busy={false} disabled={false} send={vi.fn()} />);
 expect(screen.getByRole("button", { name: "Enviar mensaje" })).not.toHaveClass("composer-send-capri");
});
it("keeps a lime recording mic instead of a red send action", () => {
 const voice = { phase: "recording", mic: { available: true }, elapsed: 1, level: .5, stop: vi.fn(), cancel: vi.fn() } as unknown as VoiceControls;
 render(<Composer mobile capriMobile busy={false} disabled={false} send={vi.fn()} voice={voice} />);
 expect(screen.queryByRole("button", { name: "Enviar mensaje" })).toBeNull();
 expect(screen.getByRole("button", { name: "Terminar y revisar" })).toHaveClass("composer-mic-on");
 const selector = '.chat-mobile[data-companion="capri"] .composer-mic.composer-mic-on {';
 expect(themeCss.includes(selector)).toBe(true);
 const rule = themeCss.slice(themeCss.indexOf(selector)).split("}")[0];
 expect(rule).toContain("var(--capri-mobile-lime)");
 expect(rule).toContain("capri-mobile-recording-pulse");
 expect(themeCss).toContain(".composer-mic.composer-mic-on { animation: none;");
});
it.each([true, false])("keeps the full-body phone dock and its controls with motion asset ready=%s", ready => {
 localStorage.setItem(COMPANION_KEY, JSON.stringify({ mode: "capri", motion: false }));
 const image = vi.spyOn(window, "Image").mockImplementation(function () {
  const element = document.createElement("img");
  Object.defineProperties(element, { complete: { value: true }, naturalWidth: { value: ready ? 1536 : 0 } });
  return element;
 });
 function Fixture({ state = "idle" }: { state?: "idle" | "working" }) {
  const controls = useCompanion();
  return <><div className="chat-mobile" data-companion="capri" /><CapriCompanion controls={controls} state={state} connected /></>;
 }
 try {
  const view = render(<Fixture />);
  const overlay = screen.getByLabelText("Capri, tu acompañante");
  expect(overlay).toHaveAttribute("data-form", "body");
  const handle = screen.getByRole("button", { name: "Mover a Capri" });
  const sprite = handle.querySelector(".capri-sprite")!;
  expect(sprite).toHaveAttribute("data-animation", ready ? "idle" : "static");
  expect(sprite).toHaveAttribute("data-pose", "idle");
  expect(sprite).not.toHaveAttribute("data-faces-animation");
  expect(sprite).toHaveAttribute("data-playing", "false");
  expect(sprite.querySelector("image")).toHaveAttribute("href", ready ? capriAnimation("idle")!.href : capriFrame("idle").href);
  expect(capriAnimation("idle")!.href).toContain("capri-motion-core-v1.png");
  view.rerender(<Fixture state="working" />);
  expect(handle.querySelector(".capri-sprite")).toHaveAttribute("data-pose", "idle");
  fireEvent.click(handle);
  expect(screen.getByRole("group", { name: "Controles de Capri" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Cerrar controles de Capri" }));
  expect(screen.queryByRole("group", { name: "Controles de Capri" })).toBeNull();
  fireEvent.click(handle);
  fireEvent.click(screen.getByRole("button", { name: "Ocultar a Capri" }));
  expect(screen.getByRole("button", { name: "Mostrar a Capri" }).querySelector("[data-faces-animation]")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Mostrar a Capri" }));
  expect(screen.getByRole("button", { name: "Mover a Capri" }).querySelector(".capri-sprite")).toHaveAttribute("data-pose", "idle");
 } finally { image.mockRestore(); }
});
it("bounds the phone avatar independently of face sprite inline sizing and reserves a corner outside messages", () => {
 const view = phone(true);
 const root = view.container.querySelector('.chat-mobile[data-companion="capri"]')!;
 const nav = screen.getByRole("navigation", { name: "Navegación principal" });
 const avatar = nav.querySelector(".capri-mobile-avatar")!;
 expect(avatar).not.toBeNull();
 expect(avatar.querySelector(".capri-sprite svg")).not.toBeNull();
 expect(avatar.querySelector("[data-faces-animation]")).not.toBeNull();
 expect(root.querySelector(".chat-header")).toBeNull();
 const dock = root.querySelector(".capri-mobile-dock")!;
 expect(dock).not.toBeNull();
 expect(dock.previousElementSibling).toHaveClass("chat-transcript");
 expect(root.querySelector(".chat-composer")).not.toBeNull();
 fireEvent.click(within(nav).getByRole("button", { name: "Ajustes" }));
 expect(root.querySelector(".capri-mobile-dock")).toHaveAttribute("hidden");
});
it("pins compact Capri nav and avatar dimensions in the shipped theme stylesheet", () => {
 const rule = (selector: string) => {
  expect(themeCss).toContain(selector);
  return themeCss.slice(themeCss.indexOf(selector)).split("}")[0];
 };
 expect(rule('.chat-mobile[data-companion="capri"] .mobile-top-nav {')).toMatch(/max-height:\s*80px/);
 const avatar = rule('.chat-mobile[data-companion="capri"] .capri-mobile-avatar {');
 expect(avatar).toMatch(/width:\s*36px/); expect(avatar).toMatch(/height:\s*36px/);
 expect(rule('.chat-mobile[data-companion="capri"] .capri-mobile-avatar svg {')).toMatch(/width:\s*100%;\s*height:\s*100%/);
 const float = rule('body:has(.chat-mobile[data-companion="capri"]) .capri-overlay .capri-float {');
 expect(float).toMatch(/width:\s*120px\s*!important/);
 expect(float).toMatch(/height:\s*120px\s*!important/);
 expect(float).toMatch(/transform:\s*none\s*!important/);
 expect(float).toContain("--capri-mobile-dock-bottom");
 expect(float).toContain("safe-area-inset-right");
});
it("tracks the dock above a changing composer and clears portal geometry when leaving chat", () => {
 const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
 let bottom = 600;
 rect.mockImplementation(function (this: HTMLElement) {
  return { top: 464, bottom: this.classList.contains("capri-mobile-dock") ? bottom : 0, left: 0, right: 360, width: 360, height: 136, x: 0, y: 464, toJSON: () => ({}) };
 });
 try {
  phone(true);
  expect(document.documentElement.style.getPropertyValue("--capri-mobile-dock-bottom")).toBe(`${window.innerHeight - 600 + 8}px`);
  bottom = 450;
  fireEvent(window, new Event("resize"));
  expect(document.documentElement.style.getPropertyValue("--capri-mobile-dock-bottom")).toBe(`${window.innerHeight - 450 + 8}px`);
  fireEvent.click(screen.getByRole("button", { name: "Ajustes" }));
  expect(document.documentElement.style.getPropertyValue("--capri-mobile-dock-bottom")).toBe("");
 } finally { rect.mockRestore(); }
});
it("does not add the Capri size or dock contracts to the default phone header", () => {
 const view = phone(false);
 expect(view.container.querySelector(".capri-mobile-avatar, .capri-mobile-dock")).toBeNull();
});
const snapshot: OrchestrationSnapshot = { available: true, approvals: [], policies: [], events: [], sessions: [
 { paneId: "p1", sessionId: "s1", terminalId: "t1", workspaceId: "w1", label: "Release", state: "working", connected: true, managed: true, cwd: "/work/repo" },
 { paneId: "p2", sessionId: "s2", terminalId: "t1", workspaceId: "w1", label: "Review", state: "idle", connected: true, managed: true },
] };
function api(): OrchestrationClient { return { snapshot: vi.fn(async () => snapshot), act: vi.fn(async () => {}), inspect: vi.fn(async () => ({ sessionId: "s1", status: "idle" as const, question: null, messages: [] })) }; }
function phone(capri: boolean) {
 localStorage.setItem(COMPANION_KEY, JSON.stringify({ mode: capri ? "capri" : "gentle", persona: "gentle" }));
 return render(<ChatSurface variant="web" state={{ ...initialState, connection: "open", agentState: "idle" }} send={vi.fn()} dismiss={vi.fn()} orchestration={api()} mobileControls={<button>Phone control</button>} />);
}
it.each([true, false])("gates Capri navigation, status and settings descriptions by theme, not persona (%s)", capri => {
 const view = phone(capri);
 const nav = screen.getByRole("navigation", { name: "Navegación principal" });
 expect(within(nav).getAllByRole("button").map(button => button.textContent)).toEqual(["Ajustes", capri ? "Capri" : "Dot", "Sesiones"]);
 expect(view.container.querySelector(".capri-connection-strip") !== null).toBe(capri);
 if (capri) expect(screen.getByText("Equipo conectado")).toBeVisible();
 fireEvent.click(within(nav).getByRole("button", { name: "Ajustes" }));
 expect(screen.queryByText("Comportamiento y conversación") !== null).toBe(capri);
 for (const title of ["Capri", "Avisos", "Personalización", "Cuenta y equipo", "Avanzado"]) expect(screen.getByText(title, { selector: "summary" }).closest("details")).toBeInTheDocument();
});
it("groups the same sessions into collapsible lists and preserves selection and refresh handlers", async () => {
 const client = api(); const refresh = vi.fn(async () => {}); const act = vi.fn(async () => true);
 const controls = { snapshot, busy: false, refresh, act };
 // Theme is a presentation input only; session data and controls are unchanged.
 const view = render(<OrchestrationPanel controls={controls} client={client} mobile capriMobile />);
 const ongoing = screen.getByText("En curso · 1").closest("details")!;
 const available = screen.getByText("Disponibles · 1").closest("details")!;
 expect(ongoing).toHaveAttribute("open"); expect(available).toHaveAttribute("open");
 expect(within(ongoing).getByRole("button", { name: "Release · Trabajando" })).toBeVisible();
 fireEvent.click(within(ongoing).getByText("En curso · 1"));
 expect(ongoing).not.toHaveAttribute("open");
 fireEvent.click(within(ongoing).getByText("En curso · 1"));
 fireEvent.click(screen.getByRole("button", { name: "Actualizar sesiones" })); expect(refresh).toHaveBeenCalledTimes(1);
 fireEvent.click(within(ongoing).getByRole("button", { name: "Release · Trabajando" }));
 await waitFor(() => expect(client.inspect).toHaveBeenCalled());
 expect(screen.getByRole("button", { name: "Todos los agentes" })).toBeVisible();
 expect(act).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button", { name: "Todos los agentes" }));
 view.rerender(<OrchestrationPanel controls={controls} client={client} mobile />);
 expect(screen.queryByText("En curso · 1")).not.toBeInTheDocument();
 expect(screen.getByRole("button", { name: "Review · Disponible" })).toBeVisible();
});
it("retains approval data and refuses a disconnected session even with the new grouping", () => {
 const controls = { snapshot: { ...snapshot, sessions: snapshot.sessions.map(s => ({ ...s, connected: false })), approvals: [{ id: "a1", paneId: "p1", sessionId: "s1", title: "Push?", message: "git push", action: "push", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+60000).toISOString(), answerable: true }] }, busy: false, refresh: vi.fn(async () => {}), act: vi.fn(async () => true) };
 render(<OrchestrationPanel controls={controls} client={api()} mobile capriMobile />);
 expect(screen.getByText("git push")).toBeVisible();
 expect(screen.getByRole("button", { name: "Permitir" })).toBeDisabled();
 expect(screen.getByRole("button", { name: "Rechazar" })).toBeDisabled();
 expect(controls.act).not.toHaveBeenCalled();
});
it("keeps attachment, voice and send handlers in the Capri composer", async () => {
 const send = vi.fn(); const start = vi.fn(); const add = vi.fn();
 const voice = { mic: { available: true }, phase: "idle", start, sent: vi.fn() } as unknown as VoiceControls;
 const attachments = { files: [], add, clear: vi.fn() } as unknown as AttachmentControls;
 render(<Composer mobile capriMobile busy={false} disabled={false} send={send} voice={voice} attachments={attachments} />);
 expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveAttribute("placeholder", "Escribe a Capri…");
 fireEvent.click(screen.getByRole("button", { name: "Dictar mensaje" })); expect(start).toHaveBeenCalledOnce();
 const file = new File(["a"], "a.txt", { type: "text/plain" });
 fireEvent.change(screen.getByLabelText("Adjuntar archivos"), { target: { files: [file] } }); expect(add).toHaveBeenCalledWith([file]);
 fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hola" } });
 fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje" }));
 await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "send", text: "Hola", requestId: expect.any(String) })));
});
it("keeps a Capri draft after refusal and Enter remains a newline", async () => {
 const send = vi.fn(() => false);
 render(<Composer mobile capriMobile busy={false} disabled={false} send={send} />);
 const box = screen.getByRole("textbox");
 fireEvent.change(box, { target: { value: "No perder" } });
 fireEvent.keyDown(box, { key: "Enter" }); expect(send).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button", { name: "Enviar mensaje" }));
 expect(await screen.findByRole("alert", { name: "No enviado" })).toBeVisible();
 expect(box).toHaveValue("No perder");
});
it("keeps session notice navigation bound to the original identity", () => {
 const open = vi.fn(); const dismiss = vi.fn();
 render(<FloatingNotices mobile capriMobile onOpenSession={open} dismiss={dismiss} notices={[{ id: 1, title: "TI · repo", message: "git push", level: "warning", notificationEvent: "permission", session: { paneId: "p1", sessionId: "s1" } }]} />);
 const notice = screen.getByRole("region", { name: "Aviso" });
 expect(within(notice).getByText("Ver sesión")).toBeVisible();
 expect(within(notice).getByText("Permiso pendiente")).toBeVisible();
 fireEvent.click(within(notice).getByRole("button", { name: "Permiso pendiente · Abrir sesión" }));
 expect(open).toHaveBeenCalledExactlyOnceWith({ paneId: "p1", sessionId: "s1" });
 expect(dismiss).toHaveBeenCalledWith(1);
});
it("renders command times and full output only from supplied metadata", () => {
 const work: AgentWork = { version: 1, truncated: false, agents: [], commands: [
  { id: "c1", tool: "bash", label: "Check backend", status: "completed", source: "live", finishedAt: "2026-10-26T15:16:00Z", output: "Backend ready" },
  { id: "c2", tool: "bash", label: "Check branch", status: "unknown", source: "history", finishedAt: "invalid" },
 ] };
 const view = render(<AgentWorkflow work={work} capriMobile />);
 fireEvent.click(screen.getByText("2 acciones registradas"));
 const time = view.container.querySelector("time")!;
 expect(time).toHaveAttribute("datetime", "2026-10-26T15:16:00Z");
 expect(view.container.querySelectorAll("time")).toHaveLength(1);
 fireEvent.click(screen.getByText("Ver salida completa"));
 expect(screen.getByText("Backend ready")).toBeVisible();
 expect(screen.getByText("Sin confirmar")).toBeVisible();
});
it("shows only real plan progress and current step; stale work is not presented as live", () => {
 const work: AgentWork = { version: 1, truncated: false, agents: [], commands: [], plan: { completed: 1, total: 2, source: "live", tasks: [{ id: "1", title: "Check", status: "done" }, { id: "2", title: "Ship", status: "in_progress" }] } };
 const view = render(<SessionWorkShelf mobile capriMobile open onToggle={vi.fn()} work={work} stale={false}><AgentWorkflow work={work} capriMobile /></SessionWorkShelf>);
 expect(screen.getByRole("progressbar", { name: "Progreso del plan" })).toHaveAttribute("value", "1");
 expect(screen.getByText("PASO 2 DE 2")).toBeVisible(); expect(screen.getByText("Ship", { selector: ".capri-current-step strong" })).toBeVisible();
 view.rerender(<SessionWorkShelf mobile capriMobile open onToggle={vi.fn()} work={work} stale><AgentWorkflow work={work} stale capriMobile /></SessionWorkShelf>);
 expect(screen.queryByText("PASO 2 DE 2")).not.toBeInTheDocument();
});
