import { expect, it } from "vitest";
import { alphaMask, frameAt, samplePose, sampleSheet, STAND } from "../src/capri2d/engine.ts";
it("projects alpha bottom-up into the native 24x34 grid, ignoring transparent pixels", () => {
 const pixels = new Uint8Array(144*204*4);
 expect(alphaMask(pixels,144,204).every(cell => cell === 0)).toBe(true);
 pixels[3] = 255; pixels[((203*144+143)*4)+3]=255;
 const mask = alphaMask(pixels,144,204);
 expect(mask).toHaveLength(816); expect(mask[33*24]).toBe(1); expect(mask[23]).toBe(1);
 expect(mask.reduce((a,b)=>a+b,0)).toBe(2);
});
it("maps elapsed milliseconds to drawings on twos", () => {
 expect(frameAt(0)).toBe(0); expect(frameAt(83)).toBe(0);
 expect(frameAt(84)).toBe(1); expect(frameAt(1000)).toBe(12);
 expect(frameAt(-10)).toBe(0);
});
it("selects exact held-key boundaries and wraps the four drawing stand", () => {
 expect(sampleSheet(STAND, 0).pose.hair).toBe(-2.5);
 expect(sampleSheet(STAND, 5).index).toBe(0);
 expect(sampleSheet(STAND, 6).index).toBe(1);
 expect(sampleSheet(STAND, 10).index).toBe(2);
 expect(sampleSheet(STAND, 16).index).toBe(3);
 expect(sampleSheet(STAND, 20).index).toBe(0);
});
it("overlays only supplied act fields on the base stance and releases on completion", () => {
 const act = { keys: [{ hold: 2, pose: { head: 0.2 } }] };
 expect(samplePose(STAND, 10, act, 0)).toEqual({ bob: -4, hair: 2.5, arms: -0.05, head: 0.2 });
 expect(samplePose(STAND, 10, act, 2)).toEqual(sampleSheet(STAND, 10).pose);
});
it("clamps one-shot sheets and preserves cues", () => {
 const sheet = { keys: [{ hold: 2, pose: {}, cue: "ready" }, { hold: 1, pose: { head: 0.2 }, cue: "peak" }] };
 expect(sampleSheet(sheet, 1).cue).toBe("ready");
 expect(sampleSheet(sheet, 2).cue).toBe("peak");
 expect(sampleSheet(sheet, 99).index).toBe(1);
 expect(() => sampleSheet({ keys: [] }, 0)).toThrow();
});
