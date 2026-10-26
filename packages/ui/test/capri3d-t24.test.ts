import { afterEach, expect, it, vi } from "vitest";
import { IdleBlink, walkPose, replyCue } from "../src/capri3d/interaction.ts";
import { RestProgression } from "../src/capri3d/choreography.ts";
afterEach(() => vi.useRealTimers());
it("steps with planted beats and vertical lift only during travel", () => {
 expect(walkPose(0.1, false, 1)).toEqual({ bob: 0, lean: 0, facing: 0 });
 const a = walkPose(0.1, true, -1);
 expect(a.bob).toBeGreaterThan(0); expect(a.facing).toBeLessThan(0); expect(a.lean).toBeLessThan(0);
 expect(walkPose(Math.PI / 12, true, 1).bob).toBeCloseTo(0);
 expect(walkPose(0.1, true, 1).facing).toBe(-a.facing);
});
it("blinks using two isolated paints and cancels all timers on hide/reduced motion", () => {
 vi.useFakeTimers(); const paint = vi.fn(); const blink = new IdleBlink(paint);
 blink.enable(true); vi.advanceTimersByTime(4200); expect(paint).toHaveBeenLastCalledWith(true);
 vi.advanceTimersByTime(140); expect(paint).toHaveBeenLastCalledWith(false);
 expect(paint).toHaveBeenCalledTimes(2);
 blink.enable(false); expect(vi.getTimerCount()).toBe(0);
 vi.advanceTimersByTime(10000); expect(paint).toHaveBeenCalledTimes(2);
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
