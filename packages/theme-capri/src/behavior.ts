import type { CapriPose } from "./art.ts";

export type CapriActionKind = "run" | "read" | "search" | "edit" | "thinking" | "memory" | "delegate" | "other";
const ACTION_POSES: Record<CapriActionKind, CapriPose> = {
 run: "working", read: "reading", search: "reading", edit: "typing",
 thinking: "thinking", memory: "reading", delegate: "working", other: "working",
};

export interface CapriBehaviorFacts {
 now: number;
 pendingQuestion?: boolean;
 outcome?: { kind: "done" | "error"; at: number };
 typingUntil?: number;
 agentWorking?: boolean;
 actionKind?: CapriActionKind;
 reply?: { kind: "reply" | "reading" | "submitted"; at: number };
}
export interface CapriBehavior {
 state: "attention" | "done" | "error" | "userTyping" | "agentWorking" | "readingReply" | "submitted" | "idle";
 /** Existing atlas pose; renderers resolve its registered animation. */
 animation: CapriPose;
 target: "editor" | "attention-source" | "stay";
}
export const CAPRI_OUTCOME_MS = 6500;
export const CAPRI_REPLY_MS = 6000;
/** No clock, phase, or randomness: identical facts always produce the same decision. */
export function capriBehavior(facts: CapriBehaviorFacts): CapriBehavior {
 const fresh = (at: number | undefined, duration: number) =>
  at !== undefined && Number.isFinite(at) && facts.now >= at && facts.now - at < duration;
 if (facts.pendingQuestion) return { state: "attention", animation: "alert", target: "attention-source" };
 if (facts.outcome && fresh(facts.outcome.at, CAPRI_OUTCOME_MS))
  return { state: facts.outcome.kind, animation: facts.outcome.kind === "error" ? "crying" : "victory", target: "stay" };
 if (facts.typingUntil !== undefined && facts.typingUntil > facts.now)
  return { state: "userTyping", animation: "eyes", target: "editor" };
 if (facts.agentWorking) return { state: "agentWorking", animation: ACTION_POSES[facts.actionKind ?? "other"], target: "stay" };
 if (facts.reply && fresh(facts.reply.at, facts.reply.kind === "submitted" ? 4500 : CAPRI_REPLY_MS))
  return facts.reply.kind === "submitted"
   ? { state: "submitted", animation: "follow-message", target: "stay" }
   : { state: "readingReply", animation: "reading", target: "stay" };
 return { state: "idle", animation: "idle", target: "stay" };
}
