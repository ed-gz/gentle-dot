import { describe, expect, it } from "vitest";
import { MobilePresence, parseIdleHint } from "../src/mobile-presence.ts";

describe("mobile presence gate", () => {
 it("parses only explicit logind hints and fails open on malformed output", () => {
  expect(parseIdleHint("IdleHint=no\n")).toBe(false);
  expect(parseIdleHint("IdleHint=yes\n")).toBe(true);
  for (const value of ["", "IdleHint=maybe", "no", "IdleHint=no\nIdleHint=yes"]) expect(parseIdleHint(value)).toBeUndefined();
 });
 it("requires recent human input when that signal exists, debounces flips, and ages it out", () => {
  let now = 100_000; const gate = new MobilePresence(() => now);
  gate.sample(false, now, true); expect(gate.state()).toBe("unknown");
  now += 2000; gate.sample(false, now, true); expect(gate.state()).toBe("active");
  now += 91_000; gate.sample(false, now - 91_000, true);
  now += 2000; gate.sample(false, now - 93_000, true); expect(gate.state()).toBe("inactive");
 });
 it("caps batches at eight, releases a grouped summary on inactivity and never gates actionable notices", () => {
  let now = 100_000; const gate = new MobilePresence(() => now);
  gate.configure("phone", true); gate.sample(false); now += 2000; gate.sample(false);
  for (let i=0;i<11;i++) expect(gate.hold("phone", `id${i}`, "agentCompleted", `Resumen ${i}`)).toBe(true);
  expect(gate.hold("phone", "permission", "permission", "Responde")).toBe(false);
  expect(gate.hold("phone", "question", "agentAttention", "Responde")).toBe(false);
  gate.sample(true); now += 2000; gate.sample(true);
  const batch = gate.summary("phone")!;
  expect(batch.summaries).toEqual(Array.from({length:8}, (_,i)=>`Resumen ${i+3}`));
  expect(batch.dropped).toBe(3); expect(gate.suppressed("phone", "id0")).toBe(true);
  expect(gate.hold("phone", "new", "agentCompleted", "Nuevo")).toBe(false);
 });
 it("releases within five minutes even while active, without resetting the oldest deadline", () => {
  let now = 100_000; const gate = new MobilePresence(() => now);
  gate.configure("phone", true); gate.sample(false); now += 2000; gate.sample(false);
  gate.hold("phone", "a", "dotReply", "A");
  for(let i=0;i<30;i++) { now += 10_000; gate.sample(false); gate.hold("phone", `b${i}`, "dotReply", "B"); }
  expect(gate.summary("phone")?.summaries.length).toBe(8);
 });
 it("fails open and flushes on unknown/stale presence, isolates phones and honors opt-out", () => {
  let now = 100_000; const gate = new MobilePresence(() => now);
  gate.configure("a", true); gate.configure("b", false);
  expect(gate.hold("a", "u", "dotReply", "Unknown")).toBe(false);
  gate.sample(false); now += 2000; gate.sample(false);
  expect(gate.hold("a", "a1", "dotReply", "A")).toBe(true);
  expect(gate.hold("b", "b1", "dotReply", "B")).toBe(false);
  gate.sample(undefined); expect(gate.state()).toBe("unknown"); expect(gate.summary("a")?.summaries).toEqual(["A"]);
  gate.sample(false); now += 2000; gate.sample(false); gate.hold("a", "a2", "dotReply", "A2");
  now += 31_000; gate.tick(); expect(gate.state()).toBe("unknown"); expect(gate.summary("a")?.summaries).toEqual(["A2"]);
 });
 it("does not let a web client without preference headers overwrite a phone opt-out", () => {
  let now=100_000; const gate=new MobilePresence(()=>now); gate.configure("phone",false);
  gate.configure("phone");gate.sample(false);now+=2000;gate.sample(false);
  expect(gate.hold("phone","x","dotReply","X")).toBe(false);
  gate.configure("phone",true);gate.configure("phone");
  expect(gate.hold("phone","y","dotReply","Y")).toBe(true);
 });
 it("fails open when the existing input feed has no usable timestamp and never gates unknown event kinds", () => {
  let now=100_000;const gate=new MobilePresence(()=>now);gate.configure("phone",true);
  gate.sample(false,undefined,true);now+=2000;gate.sample(false,undefined,true);
  expect(gate.state()).toBe("unknown");expect(gate.hold("phone","x","dotReply","X")).toBe(false);
  gate.sample(false,now,true);now+=2000;gate.sample(false,now,true);
  expect(gate.hold("phone","future","newActionableKind","Unknown kind")).toBe(false);
 });
 it("releases a pending batch when disabled and does not duplicate ids", () => {
  let now=100_000; const gate=new MobilePresence(()=>now); gate.configure("a",true);
  gate.sample(false);now+=2000;gate.sample(false);
  gate.hold("a","x","dotReply","X");gate.hold("a","x","dotReply","X");
  gate.configure("a",false);expect(gate.summary("a")?.summaries).toEqual(["X"]);
 });
});
