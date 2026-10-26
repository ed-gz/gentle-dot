import { afterEach, expect, it, vi } from "vitest";
import { watchReplies, sendCompanionMessage } from "../src/capri3d/replies.ts";
afterEach(() => vi.useRealTimers());
it("subscribes without history, deduplicates committed replies, stops on disable", () => {
 vi.useFakeTimers();
 const sockets: Fake[] = [];
 class Fake {
  onopen?: () => void; onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number }) => void; onerror?: () => void;
  readyState = 1;
  send = vi.fn<(value: string) => void>(); close = vi.fn(); constructor() { sockets.push(this); }
 }
 const publish = vi.fn();
 const stop = watchReplies({ url: "ws://localhost/", token: "test-only" }, publish, Fake as unknown as typeof WebSocket);
 const s = sockets[0]!; s.onopen!();
 expect(s.send).toHaveBeenCalledTimes(1);
 expect(JSON.parse(s.send.mock.calls[0]![0])).toMatchObject({ type: "hello" });
 const event = (data: object) => s.onmessage!({ data: JSON.stringify(data) });
 expect(sendCompanionMessage({ type: "send", text: "before auth", requestId: "before" })).toBe(false);
 event({ type: "ready" }); expect(vi.getTimerCount()).toBe(0);
 expect(sendCompanionMessage({ type: "send", text: "Hola Dot", requestId: "inline" })).toBe(true);
 expect(JSON.parse(s.send.mock.calls[1]![0])).toEqual({ type: "send", text: "Hola Dot", requestId: "inline" });
 event({ type: "history", messages: [{ role: "assistant", text: "old" }] });
 event({ type: "message_delta", messageId: "m1", delta: "partial" });
 event({ type: "message_done", messageId: "m1", text: "Respuesta nueva" });
 event({ type: "message_done", messageId: "m1", text: "Respuesta nueva" });
 expect(publish).toHaveBeenCalledExactlyOnceWith({ id: "reply:m1", kind: "notification", summary: "Respuesta nueva" });
 s.onerror!(); vi.advanceTimersByTime(29_999); expect(sockets).toHaveLength(1);
 vi.advanceTimersByTime(1); expect(sockets).toHaveLength(2);
 stop(); expect(vi.getTimerCount()).toBe(0); expect(sockets[1]!.close).toHaveBeenCalled();
 expect(sendCompanionMessage({ type: "send", text: "late", requestId: "late" })).toBe(false);
 event({ type: "message_done", messageId: "late", text: "Too late" }); expect(publish).toHaveBeenCalledTimes(1);
});
