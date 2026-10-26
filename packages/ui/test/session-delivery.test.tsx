import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { OrchestrationPanel, SessionTurns } from "../src/components/OrchestrationPanel.tsx";
import { persistDeliveries, restoreDeliveries, reconcileDeliveries, type OutgoingMessage } from "../src/session-delivery.ts";
import type { AgentConversation, OrchestrationClient, OrchestrationSnapshot } from "../src/orchestration.ts";
import type { OrchestrationControls } from "../src/useOrchestration.ts";

beforeEach(() => localStorage.removeItem("gentle-dot:session-outbox:v1"));

const snapshot: OrchestrationSnapshot = {
 available:true, approvals:[], policies:[], events:[],
 sessions:[{paneId:"pane",sessionId:"session",terminalId:"term",workspaceId:"work",label:"Proyecto",state:"working",connected:true,managed:true,
 capabilities:{inspect:true,prompt:true,abort:true,approvals:true,deliveryReceipts:true,deliveryModes:["steer","followUp"]}}],
};
const page: AgentConversation = {sessionId:"session",status:"working",messages:[],question:null};

it("restores a pending native delivery when opening the conversation without a local draft", async () => {
 const controls:OrchestrationControls = {snapshot,busy:false,refresh:vi.fn(),act:vi.fn()};
 const client:OrchestrationClient = {snapshot:vi.fn(),act:vi.fn(),inspect:vi.fn(async () => ({...page,deliveries:[{id:"restored-delivery",preview:"Mensaje enviado antes de abrir",status:"queued" as const,deliverAs:"followUp" as const,acceptedAt:new Date().toISOString()}]}))};
 render(<OrchestrationPanel client={client} controls={controls}/>);
 await userEvent.click(screen.getByRole("button",{name:"Proyecto · Trabajando"}));
 expect(await screen.findByText("Mensaje enviado antes de abrir")).toBeVisible();
 expect(screen.getByText("En cola; la sesión todavía no ha recibido el mensaje.")).toBeVisible();
 expect(controls.act).not.toHaveBeenCalled();
});

it("shows sending, accepted, queued and consumed separately while the user retains control over delivery timing", async () => {
 let accept!:(result:boolean) => void;
 const controls:OrchestrationControls = {snapshot,busy:false,refresh:vi.fn(),act:vi.fn(() => new Promise<boolean>(resolve => {accept=resolve;}))};
 const client:OrchestrationClient = {snapshot:vi.fn(),act:vi.fn(),inspect:vi.fn(async () => page)};
 const {container} = render(<OrchestrationPanel client={client} controls={controls}/>);
 await userEvent.click(screen.getByRole("button",{name:"Proyecto · Trabajando"}));
 fireEvent.change(screen.getByLabelText("Continuar esta sesión"),{target:{value:"Revisa primero la compilación"}});
 fireEvent.click(screen.getByRole("button",{name:"Enviar instrucción"}));
 expect(await screen.findByText("Enviando al equipo…")).toBeVisible();
 expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("Revisa primero la compilación");
 const sent = vi.mocked(controls.act).mock.calls[0]![0];
 expect(sent).toMatchObject({action:"prompt",deliverAs:"steer",clientMessageId:expect.any(String)});
 if (sent.action !== "prompt") throw new Error("Expected prompt");
 await act(async () => accept(true));
 expect(await screen.findByText("Recibido por la conexión; esperando confirmación de la sesión.")).toBeVisible();
 expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("");
 const delivery = {id:sent.clientMessageId!,status:"queued" as const,deliverAs:"steer" as const,acceptedAt:new Date().toISOString()};
 vi.mocked(client.inspect).mockResolvedValue({...page,deliveries:[delivery]});
 fireEvent(document,new Event("visibilitychange"));
 expect(await screen.findByText("En cola; la sesión todavía no ha recibido el mensaje.")).toBeVisible();
 vi.mocked(client.inspect).mockResolvedValue({...page,deliveries:[{...delivery,status:"delivered"}]});
 fireEvent(document,new Event("visibilitychange"));
 await waitFor(() => expect(container.querySelector(".session-delivery")).toBeNull());
 await userEvent.selectOptions(screen.getByLabelText("Entrega del mensaje"),"followUp");
 fireEvent.change(screen.getByLabelText("Continuar esta sesión"),{target:{value:"Después revisa pruebas"}});
 fireEvent.click(screen.getByRole("button",{name:"Enviar instrucción"}));
 await waitFor(() => expect(controls.act).toHaveBeenCalledTimes(2));
 expect(vi.mocked(controls.act).mock.calls[1]![0]).toMatchObject({deliverAs:"followUp"});
});

it("retains failed acknowledgement and reuses its ID only for an explicit retry of the same payload", async () => {
 const controls:OrchestrationControls = {snapshot,busy:false,refresh:vi.fn(),act:vi.fn(async () => false)};
 const client:OrchestrationClient = {snapshot:vi.fn(),act:vi.fn(),inspect:vi.fn(async () => page)};
 render(<OrchestrationPanel client={client} controls={controls}/>);
 await userEvent.click(screen.getByRole("button",{name:"Proyecto · Trabajando"}));
 fireEvent.change(screen.getByLabelText("Continuar esta sesión"),{target:{value:"Mensaje para reintentar"}});
 fireEvent.click(screen.getByRole("button",{name:"Enviar instrucción"}));
 expect(await screen.findByText("Sin confirmación. Revisa el historial antes de reintentar.")).toBeVisible();
 expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("Mensaje para reintentar");
 fireEvent.click(screen.getByRole("button",{name:"Enviar instrucción"}));
 await waitFor(() => expect(controls.act).toHaveBeenCalledTimes(2));
 expect(vi.mocked(controls.act).mock.calls[0]).toEqual(vi.mocked(controls.act).mock.calls[1]);
});

it("retries the restored original payload with its stable ID and keeps discard across a reconnect", async () => {
 const item = pending({createdAt:Date.now()});
 persistDeliveries([item]);
 const delivery = {id:item.id,status:"unconfirmed" as const,preview:item.text,deliverAs:"steer" as const,acceptedAt:new Date(item.createdAt).toISOString()};
 const controls:OrchestrationControls = {snapshot,busy:false,refresh:vi.fn(),act:vi.fn(async () => false)};
 const client:OrchestrationClient = {snapshot:vi.fn(),act:vi.fn(),inspect:vi.fn(async () => ({...page,deliveries:[delivery]}))};
 const view = render(<OrchestrationPanel client={client} controls={controls}/>);
 await userEvent.click(screen.getByRole("button",{name:"Proyecto · Trabajando"}));
 fireEvent.click(await screen.findByRole("button",{name:"Reintentar"}));
 await waitFor(() => expect(controls.act).toHaveBeenCalledWith(expect.objectContaining({action:"prompt",text:item.text,clientMessageId:item.id,deliverAs:"steer"})));
 fireEvent.click(screen.getByRole("button",{name:"Descartar"}));
 fireEvent(document,new Event("visibilitychange"));
 await waitFor(() => expect(view.container.querySelector(".session-delivery")).toBeNull());
 const inspections = vi.mocked(client.inspect).mock.calls.length;
 view.unmount();
 const reconnected = render(<OrchestrationPanel client={{...client}} controls={controls}/>);
 await userEvent.click(screen.getByRole("button",{name:"Proyecto · Trabajando"}));
 await waitFor(() => expect(vi.mocked(client.inspect).mock.calls.length).toBeGreaterThan(inspections));
 expect(reconnected.container.querySelector(".session-delivery")).toBeNull();
});

const now = Date.parse("2026-10-25T02:00:00Z");
const pending = (overrides: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
 id: "delivery-123", identity: "pane:session", text: "Dos bugs a resolver", payload: JSON.stringify(["Dos bugs a resolver", null, "steer"]), createdAt: now - 60_000,
 status: "unconfirmed", baseline: new Set(), attachmentNames: ["uno.png", "dos.png"], ...overrides,
});
const message = (id: string, text: string, timestamp: number) => ({id, role: "user" as const, timestamp: new Date(timestamp).toISOString(), content: [{type: "text" as const, text}]});
const transcript = [message("u1", 'Dos bugs a resolver\n\n<attachments>\nThe user attached these files, saved in your workspace.\n{"name":"uno.png","path":"/workspace/uno.png"}\n{"name":"dos.png","path":"/workspace/dos.png"}\n</attachments>', now - 59_000), message("u2", "ya", now)];

it("reconciles a restored pending attachment send with transformed history even with an unconfirmed receipt", () => {
 const restored = JSON.parse(JSON.stringify(pending()));
 restored.baseline = new Set();
 const result = reconcileDeliveries([restored], {messages: transcript, deliveries: [{id:"delivery-123", status:"unconfirmed", acceptedAt:new Date(now-60_000).toISOString(), deliverAs:"steer"}]}, "pane:session", now);
 expect(result[0]?.status).toBe("delivered");
 const {container} = render(<SessionTurns messages={transcript} pending={result} onRetry={() => {}} onDiscard={() => {}}/>);
 expect(container.querySelector(".session-delivery")).toBeNull();
 expect(screen.getAllByRole("article", {name:"Tu mensaje"})).toHaveLength(2);
});
it("places real pending sends chronologically with explicit retry and discard, and expires stale sends", () => {
 const item = pending({attachmentNames:[], text:"No llegó"});
 const messages = [message("before", "Antes", now-120_000), message("after", "Después", now)];
 const retry = vi.fn(), discard = vi.fn();
 const {container} = render(<SessionTurns messages={messages} pending={[item]} onRetry={retry} onDiscard={discard}/>);
 expect([...container.querySelectorAll("article")].map(node => node.textContent)).toEqual(["Antes", expect.stringContaining("No llegó"), "Después"]);
 expect(container.querySelector(".session-delivery-superseded")).not.toHaveAttribute("open");
 expect(screen.getByRole("button", {name:"Reintentar"})).toBeEnabled();
 expect(screen.getByRole("button", {name:"Descartar"})).toBeEnabled();
 fireEvent.click(screen.getByRole("button", {name:"Reintentar"}));
 fireEvent.click(screen.getByRole("button", {name:"Descartar"}));
 expect(retry).toHaveBeenCalledWith(item);
 expect(discard).toHaveBeenCalledWith(item);
 expect(reconcileDeliveries([pending({createdAt:now-86_400_001})], {messages:[]}, "pane:session", now)).toEqual([]);
});
it("does not match echoes, different attachments, old repeats, or delegated user messages", () => {
 for (const messages of [transcript.map(m => ({...m, role:"assistant" as const})), [message("wrong", "Dos bugs a resolver", now-59_000)], transcript.map(m => ({...m,timestamp:new Date(now-86_400_000).toISOString()})), transcript.map(m => ({...m,provenance:{kind:"session" as const}}))]) {
 expect(reconcileDeliveries([pending()], {messages}, "pane:session", now)[0]?.status).toBe("unconfirmed");
 }
});
it("restores delivery identity, payload and attachment names across a client restart without resurrecting dismissed entries", () => {
 const item = pending({createdAt:Date.now(), baseline:new Set(["old-user"])});
 persistDeliveries([item]);
 expect(restoreDeliveries()).toEqual([item]);
 persistDeliveries([{...item,status:"dismissed"}]);
 const restored = restoreDeliveries();
 expect(reconcileDeliveries(restored, {messages:[],deliveries:[{id:item.id,preview:item.text,status:"unconfirmed",acceptedAt:new Date(item.createdAt).toISOString(),deliverAs:"steer"}]}, item.identity)[0]?.status).toBe("dismissed");
 localStorage.removeItem("gentle-dot:session-outbox:v1");
});

it("confirms attachment-only sends and reserves a real turn for only one identical delivery", () => {
 const imageOnly = pending({text:""});
 const messages = [message("images", '<attachments>\n{"name":"uno.png"}\n{"name":"dos.png"}\n</attachments>', now-59_000)];
 expect(reconcileDeliveries([imageOnly], {messages}, imageOnly.identity, now)[0]?.status).toBe("delivered");
 const first = pending({status:"delivered"});
 const second = pending({id:"second-send"});
 expect(reconcileDeliveries([first, second], {messages:transcript}, first.identity, now).map(item => item.status)).toEqual(["delivered","unconfirmed"]);
});

it("uses stable message identity in preference to transformed text", () => {
 const messages: AgentConversation["messages"] = [{...message("u1", "transformed", now), clientMessageId:"delivery-123"}];
 expect(reconcileDeliveries([pending()], {messages}, "pane:session", now)[0]?.status).toBe("delivered");
});
