import { afterEach, expect, it, vi } from "vitest";
import { replyCue } from "../src/capri3d/interaction.ts";
import { samplePose } from "../src/capri3d/procedural.ts";
import { RestProgression } from "../src/capri3d/choreography.ts";
afterEach(() => vi.useRealTimers());
it("uses articulated opposite thighs, not the old whole-body step approximation", () => {
 const pose = samplePose("caminar", 0.2);
 expect(pose.Muslo_izquierdo![0]).toBe(-pose.Muslo_derecho![0]!);
 expect(pose["Raiz.position"]![1]).toBeGreaterThan(0);
 expect(samplePose("quieta", 0.2).Muslo_izquierdo![0]).toBe(0);
});
it("talks only on completed assistant replies, never drafts/history/intermediate/error", () => {
 const done = { type: "message_done", messageId: "m1", text: "Hola " + "x".repeat(500) };
 expect(replyCue(done)).toMatchObject({ id: "reply:m1", kind: "notification" });
 expect(replyCue(done)?.summary.length).toBeLessThanOrEqual(180);
 for (const value of [{ ...done, type: "message_delta" }, { ...done, intermediate: true }, { ...done, stopped: true }, { ...done, error: "bad" }, { type: "history" }, { ...done, text: " " }]) expect(replyCue(value)).toBeUndefined();
});
it("system sleep cannot be interrupted by session cues until unlock", () => {
 vi.useFakeTimers(); const rest = new RestProgression(vi.fn());
 rest.absent(true); rest.cue(); rest.idle(); expect(rest.pose).toBe("sleep");
 rest.absent(false); expect(rest.pose).toBe("wake"); vi.advanceTimersByTime(3900); expect(rest.pose).toBe("float"); rest.dispose();
});
