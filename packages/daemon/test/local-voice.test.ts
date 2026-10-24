import { describe, it, expect, vi } from "vitest";
import { LocalVoice } from "../src/local-voice.ts";

describe("PC dictation", () => {
 it("only advertises an installed model on a connected desktop", async () => {
  const app = { connected: true, request: vi.fn(async () => ({ installed: true })) };
  const voice = new LocalVoice(app);
  expect(await voice.available()).toBe(true);
  app.connected = false;
  expect(await voice.available()).toBe(false);
 });
 it("fails closed when the model is absent or status fails", async () => {
  const app = {connected:true,request:vi.fn(async () => ({installed:false}))};
  expect(await new LocalVoice(app).available()).toBe(false);
  app.request.mockRejectedValue(new Error("disconnected"));
  expect(await new LocalVoice(app).available()).toBe(false);
 });
 it("forwards bounded chunks and finishes once", async () => {
  const app = { connected: true, request: vi.fn(async (method: string) => method === "voice_finish" ? { text: "hola" } : {}) };
  expect(await new LocalVoice(app).transcribe("audio/wav", Buffer.alloc(1_920_044).toString("base64"))).toEqual({ok:true,text:"hola"});
  expect(app.request.mock.calls.filter(([m]) => m === "voice_finish")).toHaveLength(1);
  for (const call of app.request.mock.calls) expect(JSON.stringify(call).length).toBeLessThan(800_000);
 });
 it("times out cleanly and refuses oversized audio", async () => {
  const app = { connected:true, request:vi.fn(() => new Promise(() => {})) };
  expect(await new LocalVoice(app, 5).transcribe("audio/wav", "AAAA")).toEqual({ok:false,reason:"PC voice did not answer in time. Try phone dictation."});
  expect((await new LocalVoice(app).transcribe("audio/wav", "A".repeat(2_560_061))).ok).toBe(false);
 });
});
