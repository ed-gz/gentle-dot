import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { OrchestrationPanel } from "../src/components/OrchestrationPanel.tsx";
import { Composer } from "../src/components/Composer.tsx";
import { FloatingNotices } from "../src/components/FloatingNotices.tsx";
import { SessionWorkShelf } from "../src/components/SessionMobileControls.tsx";
import { AgentWorkflow } from "../src/components/AgentWorkflow.tsx";
import { initialState } from "../src/store.ts";
import { COMPANION_KEY } from "../src/useCompanion.ts";
import type { AgentWork, OrchestrationSnapshot, OrchestrationClient } from "../src/orchestration.ts";
import type { VoiceControls } from "../src/useVoice.ts";
import type { AttachmentControls } from "../src/useAttachments.ts";

afterEach(() => localStorage.clear());
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
