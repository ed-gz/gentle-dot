import { CloseCode, PROTOCOL_VERSION } from "@gentle-dot/protocol";
import type { ConnectionInfo } from "../client.ts";
import { replyCue } from "./interaction.ts";
/** Read-only event subscription: no history requests, prompts, drafts, or tool access.
 * The companion window must hear completed replies even while the panel is closed.
 */
export function watchReplies(info: ConnectionInfo, publish: (cue: NonNullable<ReturnType<typeof replyCue>>) => void, Socket = WebSocket) {
 let live = true, socket: WebSocket | undefined;
 let timer: ReturnType<typeof setTimeout> | undefined;
 const seen = new Set<string>();
 const connect = () => {
  if (!live) return;
  try { socket = new Socket(info.url); } catch { timer = setTimeout(connect, 30_000); return; }
  const current = socket;
  const retry = () => {
   if (socket !== current || !live) return;
   socket = undefined; clearTimeout(timer); current.close();
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
    if (message.type === "ready") clearTimeout(timer);
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
 return () => { live = false; clearTimeout(timer); socket?.close(); socket = undefined; };
}
