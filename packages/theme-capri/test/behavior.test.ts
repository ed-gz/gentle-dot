import { expect, it } from "vitest";
import { capriBehavior, type CapriBehaviorFacts } from "../src/behavior.ts";
import { CAPRI_POSES } from "../src/art.ts";
import { capriAction } from "../src/animation.ts";

const now = 100_000;
const rows: [Partial<CapriBehaviorFacts>, string][] = [
 [{ pendingQuestion: true }, "attention"],
 [{ outcome: { kind: "done", at: now } }, "done"],
 [{ typingUntil: now + 1000 }, "userTyping"],
 [{ agentWorking: true }, "agentWorking"],
 [{ reply: { kind: "reply", at: now } }, "readingReply"],
 [{}, "idle"],
];
for (const [i, higher] of rows.entries()) {
 for (const lower of rows.slice(i + 1)) {
  it(`prioritizes ${higher[1]} over ${lower[1]}`, () => {
   const result = capriBehavior({ now, ...lower[0], ...higher[0] });
   expect(result.state).toBe(higher[1]);
   expect(CAPRI_POSES).toContain(result.animation);
  });
 }
}
it.each([
 ["run", "working"], ["read", "reading"], ["search", "reading"],
 ["edit", "typing"], ["thinking", "thinking"], ["other", "working"],
] as const)("maps real %s activity to %s without changing priorities", (actionKind, pose) => {
 expect(capriBehavior({ now, agentWorking: true, actionKind }).animation).toBe(pose);
 expect(capriBehavior({ now, agentWorking: true, actionKind, pendingQuestion: true }).animation).toBe("alert");
 expect(capriBehavior({ now, agentWorking: true, actionKind, outcome: { kind: "error", at: now } }).animation).toBe("crying");
 expect(capriBehavior({ now, agentWorking: false, actionKind }).animation).toBe("idle");
});
it("visibly distinguishes inspecting files from executing commands in motion atlases", () => {
 const reading = capriBehavior({ now, agentWorking: true, actionKind: "read" });
 const running = capriBehavior({ now, agentWorking: true, actionKind: "run" });
 expect(capriAction(reading.animation)).toBe("curious");
 expect(capriAction(reading.animation)).not.toBe(capriAction(running.animation));
});
it("expires outcomes and replies, falling through without a phase", () => {
 const facts: CapriBehaviorFacts = { now, outcome: { kind: "error", at: now }, typingUntil: now + 20_000, agentWorking: true, reply: { kind: "submitted", at: now } };
 expect(capriBehavior(facts).state).toBe("error");
 expect(capriBehavior({ ...facts, now: now + 7000 }).state).toBe("userTyping");
 expect(capriBehavior({ ...facts, now: now + 21_000 }).state).toBe("agentWorking");
 expect(capriBehavior({ ...facts, now: now + 21_000, agentWorking: false }).state).toBe("idle");
});
it("targets only purposeful sources and rejects future timestamps", () => {
 expect(capriBehavior({ now, typingUntil: now + 1000 }).target).toBe("editor");
 expect(capriBehavior({ now, pendingQuestion: true }).target).toBe("attention-source");
 expect(capriBehavior({ now }).target).toBe("stay");
 expect(capriBehavior({ now, outcome: { kind: "done", at: now + 1000 } }).state).toBe("idle");
});
