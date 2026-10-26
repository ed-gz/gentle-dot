import { afterEach, describe, expect, it, vi } from "vitest";
import { RestProgression, planTravel, landingPoint, responseChoice, renderFps, speechDuration } from "../src/capri3d/choreography.ts";

afterEach(() => vi.useRealTimers());
describe("purposeful 3D choreography", () => {
 it("rests by elapsed idle time, wakes on a cue, and stops checkpoints on dispose", () => {
  vi.useFakeTimers();
  const changed = vi.fn();
  const rest = new RestProgression(changed);
  rest.idle();
  expect(rest.pose).toBe("float");
  vi.advanceTimersByTime(120_000);
  expect(rest.pose).toBe("sit");
  vi.advanceTimersByTime(480_000);
  expect(rest.pose).toBe("sleep");
  rest.cue();
  expect(rest.pose).toBe("wake");
  vi.advanceTimersByTime(900);
  expect(rest.pose).toBe("greet");
  vi.advanceTimersByTime(3000);
  expect(rest.pose).toBe("float");
  rest.dispose();
  expect(vi.getTimerCount()).toBe(0);
 });
 it("does not cancel wake on overlapping cues or start idle timers during ongoing work", () => {
  vi.useFakeTimers();
  const rest = new RestProgression(vi.fn());
  rest.absent(true); rest.absent(false);
  rest.cue(); rest.idle(); rest.cue();
  vi.advanceTimersByTime(3900);
  expect(rest.pose).toBe("float");
  expect(vi.getTimerCount()).toBe(0);
  rest.idle();
  vi.advanceTimersByTime(120_000);
  expect(rest.pose).toBe("sit");
  rest.dispose();
 });
 it("system absence sleeps immediately and return wakes", () => {
  vi.useFakeTimers();
  const rest = new RestProgression(vi.fn());
  rest.absent(true); expect(rest.pose).toBe("sleep");
  rest.absent(false); expect(rest.pose).toBe("wake");
  rest.dispose();
 });
 it("only a cue can move an unpinned companion", () => {
  const from = { x: 0, y: 0, monitor: "A" }, to = { x: 120, y: 0, monitor: "A" };
  expect(planTravel(from, to, true, false)?.kind).toBe("walk");
  expect(planTravel(from, { ...to, x: 900 }, true, false)?.kind).toBe("teleport");
  expect(planTravel(from, { ...to, monitor: "B" }, true, false)?.kind).toBe("teleport");
  expect(planTravel(from, to, false, false)).toBeNull();
  expect(planTravel(from, to, true, true)).toBeNull();
  expect(planTravel(from, from, true, false)).toBeNull();
 });
 it("lands on the focused target only when below her, otherwise the work-area floor", () => {
  const area = { x: -100, y: 0, width: 1000, height: 800 };
  const body = { x: 50, y: 30, width: 240, height: 340 };
  expect(landingPoint(body, area)).toEqual({ x: 50, y: 460 });
  expect(landingPoint(body, area, { x: 0, y: 500, width: 600, height: 300 })).toEqual({ x: 50, y: 160 });
  expect(landingPoint({ ...body, x: 850 }, area)).toEqual({ x: 660, y: 460 });
  expect(landingPoint(body, area, { x: 0, y: 200, width: 600, height: 300 }).y).toBe(460);
 });
 it("speaks for the bounded text duration, celebrates once, waves for attention", () => {
  expect(responseChoice("reply").clip).toBe("Hablar");
  expect(responseChoice("done")).toMatchObject({ clip: "Reir", once: true });
  expect(responseChoice("attention")).toMatchObject({ clip: "Saludar_y_teletransportarse", end: 3, once: true });
  expect(speechDuration("hello")).toBeGreaterThan(2000);
  expect(speechDuration("x".repeat(10000))).toBe(12_000);
 });
 it("schedules 30fps only for active visible animation, never static/hidden/reduced/capture", () => {
  expect(renderFps({ visible: true, animating: true })).toBe(30);
  for (const state of [{ visible: true }, { visible: false, animating: true }, { visible: true, animating: true, reduced: true }, { visible: true, animating: true, capture: true }])
   expect(renderFps(state)).toBe(0);
 });
});
