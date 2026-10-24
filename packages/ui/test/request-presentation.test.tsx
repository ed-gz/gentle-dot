import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { RequestPresentation, RequestPresentationSetting } from "../src/components/RequestPresentation.tsx";
import type { AgentApproval, OrchestrationClient, OrchestrationSnapshot } from "../src/orchestration.ts";
import { initialState } from "../src/store.ts";

const show = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeAll(() => {
 Object.defineProperty(HTMLDialogElement.prototype, "showModal", {configurable:true,value(this:HTMLDialogElement){this.open=true;}});
 Object.defineProperty(HTMLDialogElement.prototype, "close", {configurable:true,value(this:HTMLDialogElement){this.open=false;}});
});
afterAll(() => {
 for (const [key, descriptor] of [["showModal",show],["close",close]] as const) {
  if (descriptor) Object.defineProperty(HTMLDialogElement.prototype,key,descriptor);
  else Reflect.deleteProperty(HTMLDialogElement.prototype,key);
 }
});
afterEach(() => {localStorage.clear();vi.useRealTimers();});
const approval: AgentApproval = {id:"q1",paneId:"p1",sessionId:"s1",title:"Editar documento",message:"Original\nCompleto",action:"question",kind:"editor",answerable:true,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
function fixture() {
 let snapshot: OrchestrationSnapshot = {available:true,sessions:[{paneId:"p1",sessionId:"s1",terminalId:"t1",workspaceId:"w",label:"Agente uno",state:"blocked",connected:true,managed:true}],approvals:[approval],policies:[],events:[]};
 const answerDotApproval = vi.fn(async () => {dot=[];});
 let dot = [{id:"dot-1",title:"Autorizar operación",message:"Detalle completo",expiresAt:new Date(Date.now()+60000).toISOString()}];
 const api: OrchestrationClient = {snapshot:vi.fn(async () => snapshot), act:vi.fn(async () => {snapshot={...snapshot,approvals:[]};}), inspect:vi.fn(async () => ({sessionId:"s1",status:"waiting" as const,question:null,messages:[]})), dotApprovals:vi.fn(async () => ({allowed:true,approvals:dot})),answerDotApproval};
 return {api,answerDotApproval};
}
function phone(api: OrchestrationClient, connection: "open" | "closed" = "open") {
 return <ChatSurface variant="web" state={{...initialState,connection,agentState:"idle"}} send={vi.fn()} dismiss={vi.fn()} mobileControls={<span>Teléfono</span>} orchestration={api} />;
}
it("answers a Dot permission directly in the current conversation without visiting Agents", async () => {
 const {api,answerDotApproval}=fixture(); render(phone(api));
 await userEvent.click(await screen.findByRole("button",{name:"Aprobar permiso de Dot"}));
 await waitFor(() => expect(answerDotApproval).toHaveBeenCalledWith("dot-1",true));
 expect(screen.queryByRole("button",{name:"Aprobar permiso de Dot"})).toBeNull();
 expect(screen.queryByText("Editar documento")).toBeNull(); // no hidden background actionable cards
});
it("persists the Spanish mode choice across remounts, defaulting to the conversation", async () => {
 const view=render(<RequestPresentationSetting />);
 expect(screen.getByRole("radio",{name:"Dentro de cada conversación"})).toBeChecked();
 expect(screen.queryByText("Cerrar la ventana no acepta ni rechaza la solicitud.")).toBeNull();
 await userEvent.click(screen.getByRole("radio",{name:"Ventana emergente con respuestas"}));
 view.unmount();render(<RequestPresentationSetting />);
 expect(screen.getByRole("radio",{name:"Ventana emergente con respuestas"})).toBeChecked();
});
it("queues Dot and agent controls in a single actionable popup with exact request dispatch", async () => {
 localStorage.setItem("gentledot.request-presentation","popup");
 const {api,answerDotApproval}=fixture();render(phone(api));
 const dialog=await screen.findByRole("dialog",{name:"Solicitudes pendientes"});
 const editor=await within(dialog).findByRole("textbox",{name:"Tu respuesta"});
 expect(editor).toHaveValue("Original\nCompleto");
 expect(api.act).not.toHaveBeenCalled();expect(answerDotApproval).not.toHaveBeenCalled();
 await userEvent.click(within(dialog).getByRole("button",{name:"Cerrar sin responder"}));
 expect(api.act).not.toHaveBeenCalled();expect(answerDotApproval).not.toHaveBeenCalled();
 expect(screen.queryByRole("textbox",{name:"Tu respuesta",hidden:true})).toBeNull();
 await userEvent.click(screen.getByRole("button",{name:/Ver solicitudes pendientes/}));
 fireEvent.change(screen.getByRole("textbox",{name:"Tu respuesta"}),{target:{value:"Nueva\nrespuesta"}});
 await userEvent.click(screen.getByRole("button",{name:"Enviar respuesta"}));
 await waitFor(() => expect(api.act).toHaveBeenCalledWith({action:"answer",paneId:"p1",sessionId:"s1",requestId:"q1",text:"Nueva\nrespuesta"}));
 await userEvent.click(screen.getByRole("button",{name:"Aprobar permiso de Dot"}));
 await waitFor(() => expect(answerDotApproval).toHaveBeenCalledExactlyOnceWith("dot-1",true));
 await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("locks all popup controls when disconnected without inventing acceptance", async () => {
 localStorage.setItem("gentledot.request-presentation","popup");
 const {api,answerDotApproval}=fixture();const view=render(phone(api));
 await screen.findByRole("button",{name:"Aprobar permiso de Dot"});
 view.rerender(phone(api,"closed"));
 expect(screen.getByRole("button",{name:"Aprobar permiso de Dot"})).toBeDisabled();
 expect(screen.getByRole("button",{name:"Enviar respuesta"})).toBeDisabled();
 expect(api.act).not.toHaveBeenCalled();expect(answerDotApproval).not.toHaveBeenCalled();
});
it("only mounts the selected owning-session request inline", async () => {
 const {api}=fixture();
 const snapshot = await api.snapshot();
 api.snapshot = vi.fn(async () => ({...snapshot, approvals:[approval, {...approval,id:"old",sessionId:"old-session",title:"Solicitud de otra identidad"}]}));
 render(phone(api));
 await userEvent.click(screen.getByRole("button",{name:"Sesiones"}));
 await userEvent.click(await screen.findByRole("button",{name:/Agente uno ·/}));
 expect(await screen.findByRole("textbox",{name:"Tu respuesta"})).toHaveValue("Original\nCompleto");
 expect(screen.queryByRole("button",{name:"Aprobar permiso de Dot",hidden:true})).toBeNull();
 expect(screen.queryByText("Solicitud de otra identidad")).toBeNull();
});
it("expires popup responses and leaves unsupported custom interfaces non-actionable", async () => {
 localStorage.setItem("gentledot.request-presentation","popup");
 const {api}=fixture();
 const snapshot = await api.snapshot();
 api.snapshot = vi.fn(async () => ({...snapshot,approvals:[{...approval,expiresAt:"2000-01-01T00:00:00Z"},{...approval,id:"custom",kind:"custom" as const}]}));
 render(phone(api));
 expect(await screen.findByRole("button",{name:"Enviar respuesta"})).toBeDisabled();
 expect(screen.getByText(/Interfaz de terminal no compatible/)).toBeVisible();
 expect(api.act).not.toHaveBeenCalled();
});
it("reuses Dot question controls and dispatches only the explicit answer, never on dismiss", async () => {
 localStorage.setItem("gentledot.request-presentation","popup");
 const send=vi.fn();
 const state={...initialState,connection:"open" as const,agentState:"idle" as const,asks:[{requestId:"ask-editor",method:"editor" as const,title:"Pregunta de Dot",prefill:"Original"}]};
 const view=render(<ChatSurface variant="web" state={state} send={send} dismiss={vi.fn()} mobileControls={<span>Teléfono</span>} />);
 await userEvent.click(screen.getByRole("button",{name:"Cerrar sin responder"}));
 expect(send).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole("button",{name:/Ver solicitudes/}));
 fireEvent.change(screen.getByRole("textbox",{name:"Pregunta de Dot"}),{target:{value:"Literal\nRespuesta"}});
 await userEvent.click(screen.getByRole("button",{name:"Send answer"}));
 expect(send).toHaveBeenCalledExactlyOnceWith({type:"ui_response",requestId:"ask-editor",value:"Literal\nRespuesta"});
 view.rerender(<ChatSurface variant="web" state={{...state,asks:[]}} send={send} dismiss={vi.fn()} mobileControls={<span>Teléfono</span>} />);
 expect(screen.queryByRole("dialog")).toBeNull();
});
it("dismisses on Back, reopens safely, and removes controls on disappearance or background", async () => {
 localStorage.setItem("gentledot.request-presentation","popup");
 const view=render(<RequestPresentation ids={["one","two"]}><button type="button">Responder</button></RequestPresentation>);
 expect(screen.getByRole("button",{name:"Cerrar sin responder"})).toHaveFocus();
 act(() => window.dispatchEvent(new Event("gentledot-back",{cancelable:true})));
 expect(screen.queryByRole("button",{name:"Responder",hidden:true})).toBeNull();
 await userEvent.click(screen.getByRole("button",{name:/Ver solicitudes/}));
 view.rerender(<RequestPresentation ids={[]}><button type="button">Responder</button></RequestPresentation>);
 expect(screen.queryByRole("dialog")).toBeNull();
 view.rerender(<RequestPresentation active={false} ids={["new"]}><button type="button">Responder</button></RequestPresentation>);
 expect(screen.queryByRole("button",{name:"Responder",hidden:true})).toBeNull();
});
