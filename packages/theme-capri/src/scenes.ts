import type { AgentState, CompanionActivityKind } from "@gentle-dot/protocol";
import type { CapriPose } from "./art.ts";
import { capriBehavior } from "./behavior.ts";
export { capriBehavior, CAPRI_OUTCOME_MS, CAPRI_REPLY_MS } from "./behavior.ts";

export type CompanionCompany = "visits" | "capri" | "rebecca" | "duo";
export type CompanionAmbience = "default" | "hacker" | "afterlife" | "sunset";
export type CompanionInteraction = CompanionActivityKind;

/** Compatibility adapter for scene consumers. Legacy appearance preferences never rotate behavior. */
export function sceneForActivity(input: {
 state: AgentState;
 connected: boolean;
 attention: boolean;
 sessions: boolean;
 interaction: CompanionInteraction;
 company?: CompanionCompany;
 phase?: number;
 scene?: "auto" | CapriPose;
 celebrate: boolean;
 musicPlaying?: boolean;
 activitySequence?: number;
 outcomeAt?: number;
 now?: number;
}): CapriPose {
 const now = input.now ?? Date.now();
 const outcome = input.state === "error" || input.interaction === "failed" ? "error" : input.celebrate ? "done" : undefined;
 return capriBehavior({
  now,
  pendingQuestion: input.attention,
  outcome: outcome ? { kind: outcome, at: input.outcomeAt ?? now } : undefined,
  typingUntil: input.interaction === "typing" ? now + 1 : undefined,
  agentWorking: input.state === "working" || input.state === "thinking" || input.interaction === "sending" || input.interaction === "queued",
  reply: ["response", "reading", "submitted"].includes(input.interaction)
   ? { kind: input.interaction === "submitted" ? "submitted" : "reply", at: now } : undefined,
 }).animation;
}

export function sceneCaption(pose: CapriPose): string {
 const captions: Partial<Record<CapriPose, string>> = {
  crying: "Algo falló. Lo revisamos paso a paso.",
  working: "Manos a la obra.",
  stressed: "Una cosa a la vez. Respiramos.",
  angry: "Ese bug y yo tenemos asuntos pendientes.",
  coffee: "Tazota lista. A ver esas sesiones.",
  headphones: "Hay música. Me quedo al ritmo.",
  dancing: "Esta pide un pasito.",
  capture: "Captura guardada.",
  "follow-message": "Va en camino. Sigo contigo.",
  chill: "Yo pongo el chill.",
  stretch: "Pausa para estirarnos.",
  "sleepy-coffee": "A este café le falta otro café.",
  victory: "Terminó el turno. Chócalas.",
  confused: "A ver… desenredemos esto.",
  hacker: "¿Nos ponemos en mood hacker?",
  snack: "La botana también es parte del proceso.",
  "rebecca-wave": "Rebecca se apunta.",
  "rebecca-coffee": "Rebecca trajo su propio café.",
  "rebecca-work": "Rebecca está al pendiente.",
  "rebecca-cheer": "Rebecca aprueba ese avance.",
  "invite-rebecca": "Rebecca, ven a ver esto conmigo.",
  "duo-watch": "Primera fila para ver las sesiones.",
  "duo-coffee": "Dos tazas. Cero prisas.",
  "duo-couch": "Hicimos espacio en el sillón.",
  "duo-high-five": "¡Eso! Chócalas.",
  "duo-debug": "Dos cabezas para ese detalle.",
  "duo-laugh": "Un ratito de buen humor.",
  "duo-sleep": "Descansamos por aquí.",
 };
 return captions[pose] ?? "Aquí, cuando me necesites.";
}
