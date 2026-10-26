import { describe, expect, it } from "vitest";
import { capriBehavior } from "@gentle-dot/theme-capri/behavior";
import { clipForBehavior } from "../src/capri3d/mapping.ts";
import { encodeAlphaMask } from "../src/capri3d/mask.ts";
import { assetName, loadBaseAsset } from "../src/capri3d/assets.ts";

describe("deterministic desktop 3D", () => {
 it.each([
  [{}, "roja.glb", "Flotar_en_reposo"],
  [{ pendingQuestion: true }, "roja.glb", "Saludar_y_teletransportarse"],
  [{ outcome: { kind: "done", at: 10 } }, "roja.glb", "Reir"],
  [{ outcome: { kind: "error", at: 10 } }, "roja.glb", null],
  [{ typingUntil: 100 }, "roja_inclinada.glb", null],
  [{ agentWorking: true }, "roja.glb", "Pensar"],
  [{ reply: { kind: "reading", at: 10 } }, "roja.glb", "Pensar"],
  [{ reply: { kind: "reply", at: 10 } }, "roja.glb", "Hablar"],
  [{ reply: { kind: "submitted", at: 10 } }, "roja.glb", "Hablar"],
 ] as const)("maps facts %j", (facts, model, clip) => {
  const behavior = capriBehavior({ now: 20, ...facts });
  expect(clipForBehavior(behavior, "reply" in facts ? facts.reply.kind : undefined)).toMatchObject({ model, clip });
 });
 it.each(["run", "read", "search", "edit", "thinking", "memory", "delegate", "other"] as const)("maps action %s to thinking", actionKind => {
  expect(clipForBehavior(capriBehavior({ now: 20, agentWorking: true, actionKind })).clip).toBe("Pensar");
 });
 it("limits the attention wave before teleport and makes celebration finite", () => {
  expect(clipForBehavior(capriBehavior({ now: 20, pendingQuestion: true }))).toMatchObject({ end: 3, once: true });
  expect(clipForBehavior(capriBehavior({ now: 20, outcome: { kind: "done", at: 10 } })).once).toBe(true);
 });
 it.each(["../roja.glb", "/roja.glb", "roja.glb/..", "unknown.glb", "ROJA.glb", "roja.glb\u0000"])("rejects asset %s", name => expect(assetName(name)).toBe(false));
 it("accepts only the ten known names", () => {
  expect(assetName("roja.glb")).toBe(true);
  expect(assetName("roja_inclinada.glb")).toBe(true);
 });
 it("selects fallback when local assets are missing", async () => {
  expect(await loadBaseAsset(async () => { throw new Error("missing"); })).toBeNull();
 });
 it("encodes occupied cells conservatively, top-to-bottom", () => {
  const rgba = new Uint8Array(8 * 4 * 4);
  rgba[(0 * 8 + 7) * 4 + 3] = 255;
  rgba[(3 * 8 + 0) * 4 + 3] = 255;
  expect(encodeAlphaMask(rgba, 8, 4, 4, 2)).toEqual([0, 0, 0, 1, 1, 0, 0, 0]);
 });
 it("ignores nearly transparent pixels and validates dimensions", () => {
  expect(encodeAlphaMask(new Uint8Array([0, 0, 0, 5]), 1, 1, 1, 1)).toEqual([0]);
  expect(() => encodeAlphaMask(new Uint8Array(1), 2, 2)).toThrow();
 });
});
