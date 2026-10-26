import type { ClipChoice } from "./mapping.ts";

export type RestPose = "float" | "sit" | "sleep" | "wake" | "greet";
/** One outstanding checkpoint, never an interval or random phase. */
export class RestProgression {
 pose: RestPose = "float";
 private timer?: ReturnType<typeof setTimeout>;
 private idleAt = Date.now();
 private away = false;
 private resting = true;
 private changed: (pose: RestPose) => void;
 constructor(changed: (pose: RestPose) => void) { this.changed = changed; }
 private set(pose: RestPose) { this.pose = pose; this.changed(pose); }
 private later(ms: number, next: () => void) {
  clearTimeout(this.timer);
  this.timer = setTimeout(() => { this.timer = undefined; next(); }, ms);
 }
 idle() {
  this.resting = true;
  if (this.away || this.pose === "wake" || this.pose === "greet") return;
  clearTimeout(this.timer);
  const elapsed = Date.now() - this.idleAt;
  if (elapsed >= 600_000) this.set("sleep");
  else if (elapsed >= 120_000) {
   this.set("sit"); this.later(600_000 - elapsed, () => this.idle());
  } else {
   this.set("float"); this.later(120_000 - elapsed, () => this.idle());
  }
 }
 cue() {
  if (this.away) return;
  this.resting = false;
  this.idleAt = Date.now();
  if (this.pose === "wake" || this.pose === "greet") return;
  clearTimeout(this.timer);
  if (this.pose === "sleep") {
   this.set("wake");
   this.later(900, () => { this.set("greet"); this.later(3000, () => { this.set("float"); if (this.resting) this.idle(); }); });
  } else this.set("float");
 }
 absent(value: boolean) {
  if (this.away === value) return;
  this.away = value;
  if (value) { clearTimeout(this.timer); this.set("sleep"); }
  else this.cue();
 }
 dispose() { clearTimeout(this.timer); }
}
export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }
export function planTravel(from: Point & { monitor: string }, to: Point & { monitor: string }, cue: boolean, pinned: boolean) {
 const distance = Math.hypot(to.x - from.x, to.y - from.y);
 if (!cue || pinned || distance < 1) return null;
 const kind = from.monitor !== to.monitor || distance > 600 ? "teleport" : "walk";
 return { kind, direction: Math.sign(to.x - from.x), duration: kind === "teleport" ? 1800 : Math.max(400, distance / 260 * 1000) };
}
export function landingPoint(body: Rect, area: Rect, focused?: Rect): Point {
 const x = Math.max(area.x, Math.min(body.x, area.x + Math.max(0, area.width - body.width)));
 let y = area.y + Math.max(0, area.height - body.height);
 if (focused && focused.y >= body.y + body.height && x >= focused.x && x + body.width <= focused.x + focused.width)
  y = Math.min(y, focused.y - body.height);
 return { x, y: Math.max(area.y, y) };
}
export function speechDuration(text: string) { return Math.min(12_000, 2200 + [...text].length * 55); }
export function responseChoice(kind: "reply" | "done" | "attention"): ClipChoice {
 if (kind === "reply") return { model: "roja.glb", clip: "Hablar" };
 if (kind === "done") return { model: "roja.glb", clip: "Reir", once: true };
 return { model: "roja.glb", clip: "Saludar_y_teletransportarse", end: 3, once: true };
}
export function renderFps(state: { visible: boolean; reduced?: boolean; capture?: boolean; animating?: boolean }) {
 return state.visible && !state.reduced && !state.capture && state.animating ? 30 : 0;
}
export function restChoice(pose: RestPose): ClipChoice {
 switch (pose) {
  case "sit": return { model: "roja_sentada.glb", clip: null };
  case "sleep": return { model: "roja_recostada_cerrados.glb", clip: null };
  case "wake": return { model: "roja_recostada_abiertos.glb", clip: null };
  case "greet": return responseChoice("attention");
  default: return { model: "roja.glb", clip: "Flotar_en_reposo" };
 }
}
