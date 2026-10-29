import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { IDBObjectStore } from "fake-indexeddb";
import { OrchestrationPanel, SessionTurns } from "../src/components/OrchestrationPanel.tsx";
import { persistDeliveries, restoreDeliveries, reconcileDeliveries, sessionDeliveryIdentity, legacyDeliveryIdentity, type OutgoingMessage } from "../src/session-delivery.ts";
import * as deliveryStore from "../src/session-delivery.ts";
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
 expect(screen.getByText("Enviado a la cola; esperando confirmación de la sesión.")).toBeVisible();
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
 expect(await screen.findByText("Enviado a la cola; esperando confirmación de la sesión.")).toBeVisible();
	vi.mocked(client.inspect).mockResolvedValue({...page,deliveries:[{...delivery,status:"delivered",evidence:"correlated-v1"}]});
 fireEvent(document,new Event("visibilitychange"));
 await waitFor(() => expect(container.querySelector(".session-delivery")).toBeNull());
 await userEvent.selectOptions(screen.getByLabelText("Entrega del mensaje"),"followUp");
 fireEvent.change(screen.getByLabelText("Continuar esta sesión"),{target:{value:"Después revisa pruebas"}});
 fireEvent.click(screen.getByRole("button",{name:"Enviar instrucción"}));
 await waitFor(() => expect(controls.act).toHaveBeenCalledTimes(2));
 expect(vi.mocked(controls.act).mock.calls[1]![0]).toMatchObject({deliverAs:"followUp"});
});

it("retains failed acknowledgement and assigns a new ID to a new send of identical text", async () => {
 const controls:OrchestrationControls = {snapshot,busy:false,refresh:vi.fn(),act:vi.fn(async () => false)};
 const client:OrchestrationClient = {snapshot:vi.fn(),act:vi.fn(),inspect:vi.fn(async () => page)};
 render(<OrchestrationPanel client={client} controls={controls}/>);
 await userEvent.click(screen.getByRole("button",{name:"Proyecto · Trabajando"}));
 fireEvent.change(screen.getByLabelText("Continuar esta sesión"),{target:{value:"Mensaje para reintentar"}});
 fireEvent.click(screen.getByRole("button",{name:"Enviar instrucción"}));
 expect(await screen.findByText("Sin confirmación. Revisa el historial: reintentar podría duplicar el mensaje.")).toBeVisible();
 expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("Mensaje para reintentar");
 fireEvent.click(screen.getByRole("button",{name:"Enviar instrucción"}));
 await waitFor(() => expect(controls.act).toHaveBeenCalledTimes(2));
 const first = vi.mocked(controls.act).mock.calls[0]![0];
 const second = vi.mocked(controls.act).mock.calls[1]![0];
 expect(first).toMatchObject({action:"prompt",text:"Mensaje para reintentar"});
 expect(second).toMatchObject({action:"prompt",text:"Mensaje para reintentar"});
 if (first.action !== "prompt" || second.action !== "prompt") throw new Error("Expected prompts");
 expect(first.clientMessageId).not.toBe(second.clientMessageId);
});

it("retries the restored original payload with its stable ID and keeps discard across a reconnect", async () => {
 const item = pending({createdAt:Date.now()});
 await persistDeliveries([item]);
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

it("locks repeated retry taps before its asynchronous save completes", async () => {
 const item = pending({createdAt:Date.now()});
 await persistDeliveries([item]);
 let finish!: (value:boolean) => void;
 const controls:OrchestrationControls = {snapshot,busy:false,refresh:vi.fn(),act:vi.fn(() => new Promise(resolve => {finish=resolve;}))};
 const client:OrchestrationClient = {snapshot:vi.fn(),act:vi.fn(),inspect:vi.fn(async () => page)};
 render(<OrchestrationPanel client={client} controls={controls}/>);
 await userEvent.click(screen.getByRole("button",{name:"Proyecto · Trabajando"}));
 const retry = await screen.findByRole("button",{name:"Reintentar"});
 fireEvent.click(retry);
 fireEvent.click(retry);
 await waitFor(() => expect(controls.act).toHaveBeenCalledTimes(1));
 await act(async () => finish(false));
 expect(controls.act).toHaveBeenCalledTimes(1);
});

const now = Date.parse("2026-10-25T02:00:00Z");
const pending = (overrides: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
 id: "delivery-123", identity: sessionDeliveryIdentity("", "pane", "session"), text: "Dos bugs a resolver", payload: JSON.stringify(["Dos bugs a resolver", null, "steer"]), createdAt: now - 60_000,
 status: "unconfirmed", baseline: new Set(), attachmentNames: ["uno.png", "dos.png"], ...overrides,
});
const message = (id: string, text: string, timestamp: number) => ({id, role: "user" as const, timestamp: new Date(timestamp).toISOString(), content: [{type: "text" as const, text}]});
const transcript = [message("u1", 'Dos bugs a resolver\n\n<attachments>\nThe user attached these files, saved in your workspace.\n{"name":"uno.png","path":"/workspace/uno.png"}\n{"name":"dos.png","path":"/workspace/dos.png"}\n</attachments>', now - 59_000), message("u2", "ya", now)];

it("keeps an unconfirmed send when another client produced identical text and attachments", () => {
 const restored = JSON.parse(JSON.stringify(pending()));
 restored.baseline = new Set();
 const result = reconcileDeliveries([restored], {messages: transcript, deliveries: [{id:"delivery-123", status:"unconfirmed", acceptedAt:new Date(now-60_000).toISOString(), deliverAs:"steer"}]}, sessionDeliveryIdentity("", "pane", "session"), now);
 expect(result[0]?.status).toBe("unconfirmed");
 const {container} = render(<SessionTurns messages={transcript} pending={result} onRetry={() => {}} onDiscard={() => {}}/>);
 expect(container.querySelector(".session-delivery")).not.toBeNull();
 expect(screen.getAllByRole("article", {name:"Tu mensaje"})).toHaveLength(2);
});
it("places real pending sends chronologically with explicit retry and discard", () => {
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
 expect(reconcileDeliveries([pending({createdAt:now-86_400_001})], {messages:[]}, sessionDeliveryIdentity("", "pane", "session"), now)).toHaveLength(1);
});
it("does not match echoes, different attachments, old repeats, or delegated user messages", () => {
 for (const messages of [transcript.map(m => ({...m, role:"assistant" as const})), [message("wrong", "Dos bugs a resolver", now-59_000)], transcript.map(m => ({...m,timestamp:new Date(now-86_400_000).toISOString()})), transcript.map(m => ({...m,provenance:{kind:"session" as const}}))]) {
 expect(reconcileDeliveries([pending()], {messages}, sessionDeliveryIdentity("", "pane", "session"), now)[0]?.status).toBe("unconfirmed");
 }
});
it("restores delivery identity, payload and attachment names across a client restart without resurrecting dismissed entries", async () => {
 const item = pending({createdAt:Date.now(), baseline:new Set(["old-user"])});
 await persistDeliveries([item]);
 expect(await restoreDeliveries()).toEqual([item]);
 await persistDeliveries([{...item,status:"dismissed"}]);
 const restored = await restoreDeliveries();
 expect(reconcileDeliveries(restored, {messages:[],deliveries:[{id:item.id,preview:item.text,status:"unconfirmed",acceptedAt:new Date(item.createdAt).toISOString(),deliverAs:"steer"}]}, item.identity)[0]?.status).toBe("dismissed");
 localStorage.removeItem("gentle-dot:session-outbox:v1");
});

it("does not confirm attachment-only sends from an uncorrelated transcript", () => {
 const imageOnly = pending({text:""});
 const messages = [message("images", '<attachments>\n{"name":"uno.png"}\n{"name":"dos.png"}\n</attachments>', now-59_000)];
 expect(reconcileDeliveries([imageOnly], {messages}, imageOnly.identity, now)[0]?.status).toBe("unconfirmed");
 const first = pending({status:"delivered",evidence:"correlated-v1"});
 const second = pending({id:"second-send"});
 expect(reconcileDeliveries([first, second], {messages:transcript}, first.identity, now).map(item => item.status)).toEqual(["delivered","unconfirmed"]);
});

it("keeps legacy delivery receipts uncertain and restores unverified tombstones without replay", async () => {
 const item = pending({createdAt: Date.now()});
 const receipt = { id:item.id, status:"delivered" as const, deliverAs:"steer" as const, acceptedAt:new Date(item.createdAt).toISOString() };
 expect(reconcileDeliveries([item], {messages:[], deliveries:[receipt]}, item.identity)[0]?.status).toBe("unconfirmed");
 expect(reconcileDeliveries([], {messages:[], deliveries:[receipt]}, item.identity)[0]?.status).toBe("unconfirmed");
 await persistDeliveries([{...item, status:"delivered"}]);
 expect((await restoreDeliveries())[0]).toMatchObject({status:"unconfirmed", payload:item.payload});
 // Previous versions already discarded a delivered tombstone's payload.
 localStorage.setItem("gentle-dot:session-outbox:v1", JSON.stringify([{...item,status:"delivered",payload:"",baseline:[]}]));
 expect((await restoreDeliveries()).find(entry => entry.identity === legacyDeliveryIdentity(item.identity))).toMatchObject({status:"unconfirmed", payload:""});
 const current = (await restoreDeliveries()).find(entry => entry.identity === item.identity)!;
 await persistDeliveries([{...current, status:"delivered", evidence:"correlated-v1"}]);
 expect((await restoreDeliveries()).find(entry => entry.identity === item.identity)).toMatchObject({status:"delivered", evidence:"correlated-v1", payload:""});
});

it("preserves unresolved sends and terminal tombstones across client restarts", async () => {
 const old = Date.now() - 2 * 86_400_000;
 const uncertain = pending({id:"uncertain", createdAt:old});
 const legacy = pending({id:"legacy", createdAt:old, status:"delivered"});
 const verified = pending({id:"verified", createdAt:old, status:"delivered", evidence:"correlated-v1"});
 const dismissed = pending({id:"dismissed", createdAt:old, status:"dismissed"});
 expect(await persistDeliveries([uncertain, legacy, verified, dismissed])).toBe(true);
 const restored = await restoreDeliveries();
 expect(restored.map(item => [item.id, item.status, item.payload])).toEqual(expect.arrayContaining([
  ["uncertain", "unconfirmed", uncertain.payload], ["legacy", "unconfirmed", legacy.payload], ["verified", "delivered", ""], ["dismissed", "dismissed", ""],
 ]));
 expect(reconcileDeliveries(restored, {messages:[]}, uncertain.identity)).toHaveLength(4);
});

it("reports storage quota failures instead of pretending pending sends were saved", async () => {
  const controls:OrchestrationControls = {snapshot,busy:false,refresh:vi.fn(),act:vi.fn(async () => false)};
  const client:OrchestrationClient = {snapshot:vi.fn(),act:vi.fn(),inspect:vi.fn(async () => page)};
  render(<OrchestrationPanel client={client} controls={controls}/>);
  await userEvent.click(screen.getByRole("button",{name:"Proyecto · Trabajando"}));
  await waitFor(() => expect(screen.getByLabelText("Continuar esta sesión")).toBeEnabled());
  const write = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
  try {
  fireEvent.change(screen.getByLabelText("Continuar esta sesión"),{target:{value:"Pendiente"}});
  fireEvent.click(screen.getByRole("button",{name:"Enviar instrucción"}));
  expect(await screen.findByText(/No se pudieron leer o guardar los envíos/)).toBeVisible();
  expect(controls.act).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("Pendiente");
 } finally { write.mockRestore(); }
});

it("merges concurrent views and never resurrects an explicitly dismissed send", async () => {
 const first = pending({id:"delivery-first", createdAt:Date.now()});
 const second = pending({id:"delivery-second", createdAt:Date.now()});
 expect(await Promise.all([persistDeliveries([first]), persistDeliveries([second])])).toEqual([true, true]);
 expect((await restoreDeliveries()).map(item => item.id)).toEqual(expect.arrayContaining([first.id, second.id]));
 expect(await persistDeliveries([{...first,status:"dismissed"}])).toBe(true);
 expect(await persistDeliveries([first])).toBe(false);
 expect((await restoreDeliveries()).find(item => item.id === first.id)?.status).toBe("dismissed");
});

it("does not overwrite an existing message if a newly generated ID collides", async () => {
 const first = pending({createdAt:Date.now()});
 const collision = pending({createdAt:Date.now(), text:"Otro", payload:"Otro"});
 expect(await persistDeliveries([first])).toBe(true);
 expect(await persistDeliveries([collision])).toBe(false);
 expect((await restoreDeliveries()).find(item => item.id === first.id)?.payload).toBe(first.payload);
 const elsewhere = {...collision, identity:sessionDeliveryIdentity("", "another-pane", "another-session")};
 expect(await persistDeliveries([elsewhere])).toBe(true);
 expect(await restoreDeliveries()).toHaveLength(2);
});

it("two restored panels can resolve one send and create a different send without overwriting it", async () => {
 const item = pending({createdAt:Date.now()});
 await persistDeliveries([item]);
 const controls:OrchestrationControls = {snapshot,busy:false,refresh:vi.fn(),act:vi.fn(async () => false)};
 const client:OrchestrationClient = {snapshot:vi.fn(),act:vi.fn(),inspect:vi.fn(async () => page)};
 const first = render(<OrchestrationPanel client={client} controls={controls}/>);
 const second = render(<OrchestrationPanel client={client} controls={controls}/>);
 await userEvent.click(within(first.container).getByRole("button",{name:"Proyecto · Trabajando"}));
 await userEvent.click(within(second.container).getByRole("button",{name:"Proyecto · Trabajando"}));
 const firstDiscard = await within(first.container).findByRole("button",{name:"Descartar"});
 await within(second.container).findByRole("button",{name:"Descartar"});
 fireEvent.click(firstDiscard);
 await waitFor(async () => expect((await restoreDeliveries()).find(entry => entry.id === item.id)?.status).toBe("dismissed"));
 fireEvent.change(within(second.container).getByLabelText("Continuar esta sesión"),{target:{value:"Otro envío"}});
 fireEvent.click(within(second.container).getByRole("button",{name:"Enviar instrucción"}));
 await waitFor(() => expect(controls.act).toHaveBeenCalledWith(expect.objectContaining({action:"prompt",text:"Otro envío"})));
 expect((await restoreDeliveries()).find(entry => entry.id === item.id)?.status).toBe("dismissed");
});

it("does not send or leave an unresolved phantom when the session changes while the save is pending", async () => {
 const otherSnapshot: OrchestrationSnapshot = {...snapshot, sessions:[...snapshot.sessions, {...snapshot.sessions[0]!, paneId:"other",sessionId:"other",label:"Otra"}]};
 const controls:OrchestrationControls = {snapshot:otherSnapshot,busy:false,refresh:vi.fn(),act:vi.fn(async () => true)};
 const client:OrchestrationClient = {snapshot:vi.fn(),act:vi.fn(),inspect:vi.fn(async (_pane, sessionId) => ({...page,sessionId}))};
 let finish!: () => void;
 const pause = new Promise<void>(resolve => { finish = resolve; });
 const real = persistDeliveries;
 const spy = vi.spyOn(deliveryStore, "persistDeliveries").mockImplementation(async items => {
  if (items.some(item => item.id === "pending-switch" && item.status === "sending")) await pause;
  return real(items);
 });
 try {
  render(<OrchestrationPanel client={client} controls={controls} createMessageId={() => "pending-switch"}/>);
  await userEvent.click(screen.getByRole("button",{name:"Proyecto · Trabajando"}));
  await waitFor(() => expect(screen.getByLabelText("Continuar esta sesión")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Continuar esta sesión"),{target:{value:"No enviar"}});
  fireEvent.click(screen.getByRole("button",{name:"Enviar instrucción"}));
  await userEvent.click(screen.getByRole("button",{name:"Todos los agentes"}));
  await userEvent.click(screen.getByRole("button",{name:"Otra · Trabajando"}));
  finish();
  await waitFor(async () => expect((await restoreDeliveries()).find(item => item.id === "pending-switch")?.status).toBe("dismissed"));
  expect(controls.act).not.toHaveBeenCalled();
 } finally { finish(); spy.mockRestore(); }
});

it("keeps an active retry locked when an older host receipt arrives", () => {
 const item = pending({status:"sending"});
 const receipt = {id:item.id, status:"unconfirmed" as const, acceptedAt:new Date().toISOString(), deliverAs:"steer" as const};
 expect(reconcileDeliveries([item], {messages:[], deliveries:[receipt]}, item.identity)[0]?.status).toBe("sending");
});

it("preserves unreadable legacy data and refuses writes", async () => {
 const raw = "{bad json";
 localStorage.setItem("gentle-dot:session-outbox:v1", raw);
 await expect(restoreDeliveries()).rejects.toThrow();
 expect(await persistDeliveries([pending()])).toBe(false);
 expect(localStorage.getItem("gentle-dot:session-outbox:v1")).toBe(raw);
});

it("never aliases colon-delimited session identities or assigns a legacy record to either session", async () => {
 expect(sessionDeliveryIdentity("", "a:b", "c")).not.toBe(sessionDeliveryIdentity("", "a", "b:c"));
 const old = {...pending(), identity:"a:b:c", baseline:[], status:"delivered", evidence:"correlated-v1"};
 localStorage.setItem("gentle-dot:session-outbox:v1", JSON.stringify([old]));
 const [restored] = await restoreDeliveries();
 expect(restored?.identity).toBe(legacyDeliveryIdentity("a:b:c"));
 expect(restored?.text).toBe(old.text);
 expect(restored?.status).toBe("unconfirmed");
 expect(restored?.evidence).toBeUndefined();
 expect(localStorage.getItem("gentle-dot:session-outbox:v1")).not.toBeNull();
});

it("uses stable message identity in preference to transformed text", () => {
 const messages: AgentConversation["messages"] = [{...message("u1", "transformed", now), clientMessageId:"delivery-123"}];
 expect(reconcileDeliveries([pending()], {messages}, sessionDeliveryIdentity("", "pane", "session"), now)[0]?.status).toBe("delivered");
 expect(reconcileDeliveries([pending()], {messages:[{...message("u2", "transformed", now),deliveryId:"delivery-123"}]}, sessionDeliveryIdentity("", "pane", "session"), now)[0]?.status).toBe("unconfirmed");
});
