import type { DesktopCompanionContextRequest } from "../desktop-companion.ts";
/** Only committed assistant text is eligible; no transcript snapshots or drafts. */
export function replyCue(value: unknown): (DesktopCompanionContextRequest & { summary: string }) | undefined {
 const m = value as { type?: string; messageId?: string; text?: string; stopped?: boolean; intermediate?: boolean; error?: string };
 if (!m || m.type !== "message_done" || !m.messageId || typeof m.text !== "string" || !m.text.trim() || m.stopped || m.intermediate || m.error) return;
 return { id: `reply:${m.messageId}`, kind: "notification", summary: [...m.text.trim().replace(/\s+/g, " ")].slice(0, 180).join("") };
}
