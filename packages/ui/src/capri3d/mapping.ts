import type { CapriBehavior } from "@gentle-dot/theme-capri/behavior";
import type { AssetName } from "./assets.ts";
import type { ProceduralClip } from "./procedural.ts";

export interface ClipChoice {
 face?: import("./desktop-faces.ts").DesktopFace;
 perch?: boolean;
 model: AssetName;
 /** null = hold the alternate model's authored pose. */
 clip: string | null;
 procedural?: ProceduralClip;
 once?: boolean;
 end?: number;
 start?: number;
 motion?: "walk" | "teleport" | "fall" | "land";
 direction?: number;
 duration?: number;
}
/** All action kinds already resolve through capriBehavior; never invent a clock phase or a random pose. */
export function clipForBehavior(behavior: CapriBehavior, replyKind?: "reply" | "reading" | "submitted"): ClipChoice {
 switch (behavior.state) {
  case "attention": return { model: "roja.glb", clip: "Saludar_y_teletransportarse", end: 3, once: true };
  case "done": return { model: "roja.glb", clip: "Reir", once: true };
  case "error": return { model: "roja.glb", clip: null, procedural: "sorpresa" };
  case "userTyping": return { model: "roja_inclinada.glb", clip: null };
  case "agentWorking": return { model: "roja.glb", clip: "Pensar", procedural: behavior.animation === "typing" || behavior.animation === "working" ? "reparar" : "pensar" };
  case "readingReply": return { model: "roja.glb", clip: replyKind === "reply" ? "Hablar" : "Pensar" };
  case "submitted": return { model: "roja.glb", clip: "Hablar", once: true };
  case "idle": return { model: "roja.glb", clip: "Flotar_en_reposo" };
 }
}
