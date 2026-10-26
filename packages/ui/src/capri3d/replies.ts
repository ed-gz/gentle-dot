import { CloseCode, PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@gentle-dot/protocol";
import { useSyncExternalStore } from "react";
import { initialState, reduce } from "../store.ts";
import type { ConnectionInfo } from "../client.ts";
import { replyCue } from "./interaction.ts";
// Reuse the companion's already-authenticated subscription for its small inline composer.
// No second socket, history requests, credentials in React props, or automatic answers.
let chatState = initialState;
let transport: ((message: ClientMessage) => boolean) | undefined;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const sendCompanionMessage = (message: ClientMessage) => transport?.(message) ?? false;
export function useCompanionChat() {
 return { state: useSyncExternalStore(subscribe, () => chatState), send: sendCompanionMessage };
}
/** The companion hears completed replies even while the panel is closed. */
export function watchReplies(info: ConnectionInfo, publish: (cue: NonNullable<ReturnType<typeof replyCue>>) => void, Socket = WebSocket) {
 let live = true, socket: WebSocket | undefined;
 let timer: ReturnType<typeof setTimeout> | undefined;
 const seen = new Set<string>();
 const send = (message: ClientMessage) => {
  if (!live || socket?.readyState !== 1 || chatState.connection !== "open") return false;
  try { socket.send(JSON.stringify(message)); return true; }
  catch { chatState = reduce(chatState, { type: "connection", status: "closed" }); notify(); return false; }
 };
 transport = send;
 const connect = () => {
  if (!live) return;
  try { socket = new Socket(info.url); } catch { timer = setTimeout(connect, 30_000); return; }
  const current = socket;
  const retry = () => {
   if (socket !== current || !live) return;
   socket = undefined; clearTimeout(timer); current.close();
   chatState = reduce(chatState, { type: "connection", status: "closed" }); notify();
   timer = setTimeout(connect, 30_000);
  };
  timer = setTimeout(retry, 12_000);
  current.onopen = () => {
   if (!live || socket !== current) return;
   current.send(JSON.stringify({ type: "hello", token: info.token, protocol: PROTOCOL_VERSION }));
  };
  current.onmessage = event => {
   if (!live || socket !== current) return;
   try {
    const message = JSON.parse(String(event.data));
    if (message.type === "ready") {
     clearTimeout(timer);
     chatState = reduce(chatState, { type: "connection", status: "open" });
    }
    chatState = reduce(chatState, { type: "server", message: message as ServerMessage }); notify();
    const cue = replyCue(message);
    if (!cue?.id || seen.has(cue.id)) return;
    seen.add(cue.id); if (seen.size > 256) seen.delete(seen.values().next().value!);
    publish(cue);
   } catch { /* Malformed events never become speech. */ }
  };
  current.onerror = retry;
  current.onclose = event => {
   // Authentication/protocol errors require a changed connection, not retry traffic.
   if (event.code === CloseCode.unauthorized || event.code === CloseCode.badProtocol) { clearTimeout(timer); return; }
   retry();
  };
 };
 connect();
 return () => {
  live = false; clearTimeout(timer); socket?.close(); socket = undefined;
  if (transport === send) { transport = undefined; chatState = initialState; notify(); }
 };
}
