import { describe, expect, it } from "vitest";
import { desktopFace, faceFrame, loadDesktopFaces, transitionFace } from "../src/capri3d/desktop-faces.ts";
import { companionSessionCue, type CompanionSessionSnapshot } from "../src/companion-sessions.ts";

describe("purposeful desktop faces", () => {
 it("loads the theme-owned atlas with frames for every real desktop trigger", async () => {
  const atlas = await loadDesktopFaces();
  expect(atlas).toBeDefined();
  for (const event of ["typing", "working", "question", "done", "error", "idle", "return", "output", "denied", "notification"]) {
   const clip = atlas!.manifest.animations[desktopFace(event)!];
   expect(clip?.frames.length).toBeGreaterThan(0);
   for (const frame of clip!.frames) {
    expect(frame.x + frame.width).toBeLessThanOrEqual(atlas!.manifest.width);
    expect(frame.y + frame.height).toBeLessThanOrEqual(atlas!.manifest.height);
   }
  }
 });
 it("forwards only bridge geometry alongside the existing semantic cue", () => {
  const now = Date.now();
  const geometry = { version: 1 as const, columns: 78, rows: 40, rect: { x: 1, y: 30, width: 76, height: 6 }, observedAt: new Date(now).toISOString() };
  const snapshot: CompanionSessionSnapshot = { version: 1, stale: false, observedAt: geometry.observedAt, sessions: [{
   paneId: "p1", sessionId: "s1", label: "Shell", focused: true, visible: true, canFocus: true,
   activity: { phase: "typing", typingUntil: new Date(now + 3000).toISOString(), geometry },
   targets: { composer: null, sidebar: null },
  }] };
  expect(companionSessionCue(snapshot, now)).toMatchObject({ kind: "typing", paneId: "p1", editorGeometry: geometry });
  expect(companionSessionCue(snapshot, now).target).toBeUndefined();
  snapshot.stale = true;
  expect(companionSessionCue(snapshot, now)).toEqual({ kind: "rest", id: "sessions-stale" });
 });
 it("maps real semantic events, not clock phases", () => {
  for (const [event, animation] of Object.entries({ typing: "typing-watch", working: "working", question: "pointing", done: "happy", error: "crying", idle: "sleepy", return: "wake", output: "look", denied: "angry", notification: "surprised" }))
   expect(desktopFace(event)).toBe(animation);
  expect(desktopFace("unknown")).toBeUndefined();
 });
 it("uses metamorphosis on either form change only", () => {
  expect(transitionFace("3d", "face")).toBe("glitch-transition");
  expect(transitionFace("face", "3d")).toBe("glitch-transition");
  expect(transitionFace("3d", "3d")).toBeUndefined();
 });
 it("honors manifest durations and stops the transition on its final frame", () => {
  const clip = { canvas: { width: 20, height: 20 }, frames: [
   { x: 0, y: 0, width: 20, height: 20, offsetX: 0, offsetY: 0, durationMs: 100 },
   { x: 20, y: 0, width: 20, height: 20, offsetX: 0, offsetY: 0, durationMs: 200 },
  ] };
  expect(faceFrame(clip, 50, false)?.x).toBe(0);
  expect(faceFrame(clip, 150, false)?.x).toBe(20);
  expect(faceFrame(clip, 350, false)?.x).toBe(0);
  expect(faceFrame(clip, 350, true)?.x).toBe(20);
  expect(faceFrame(undefined, 0, false)).toBeUndefined();
 });
});
