import type { DesktopCompanionContextRequest } from "../desktop-companion.ts";
/** Normalized gait, additive to the authored resting pose. No travel means no offsets. */
export function walkPose(seconds: number, travelling: boolean, direction: number) {
 if (!travelling) return { bob: 0, lean: 0, facing: 0 };
 const phase = seconds * 12;
 return { bob: Math.abs(Math.sin(phase)) * 0.025, lean: direction * 0.055, facing: direction * 0.65 };
}
/** Two on-demand paints (close/reopen), not a frame loop. */
export class IdleBlink {
 private timer?: ReturnType<typeof setTimeout>;
 private enabled = false;
 private closed = false;
 private paint: (closed: boolean) => void;
 constructor(paint: (closed: boolean) => void) { this.paint = paint; }
 enable(enabled: boolean) {
  if (enabled === this.enabled) return;
  this.enabled = enabled; clearTimeout(this.timer);
  if (!enabled) { if (this.closed) this.paint(false); this.closed = false; return; }
  const next = () => { this.timer = setTimeout(() => {
   this.closed = true; this.paint(true);
   this.timer = setTimeout(() => { this.closed = false; this.paint(false); next(); }, 140);
  }, 4200); };
  next();
 }
}
/** Only committed assistant text is eligible; no transcript snapshots or drafts. */
export function replyCue(value: unknown): (DesktopCompanionContextRequest & { summary: string }) | undefined {
 const m = value as { type?: string; messageId?: string; text?: string; stopped?: boolean; intermediate?: boolean; error?: string };
 if (!m || m.type !== "message_done" || !m.messageId || typeof m.text !== "string" || !m.text.trim() || m.stopped || m.intermediate || m.error) return;
 return { id: `reply:${m.messageId}`, kind: "notification", summary: [...m.text.trim().replace(/\s+/g, " ")].slice(0, 180).join("") };
}
