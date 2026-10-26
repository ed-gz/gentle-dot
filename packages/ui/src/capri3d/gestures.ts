import type { ClipChoice } from "./mapping.ts";
/** Explicit user requests only; no timer ever selects an alternate costume or an acrobatic action. */
export const gestures = {
 saludar: "Saludar", bailar: "Bailar", salto: "Saltar", voltereta: "Voltereta", estirarse: "Estirarse",
 guino: "Guiñar", brazos: "Abrazo", transformarse: "Transformarse",
} as const;
export type Gesture = keyof typeof gestures;
export function gestureChoice(gesture: Gesture): ClipChoice {
 if (gesture === "guino") return { model: "roja_guino.glb", clip: null, once: true };
 if (gesture === "brazos") return { model: "roja_brazos.glb", clip: null, once: true };
 if (gesture === "transformarse") return { model: "roja_transformacion.glb", clip: null, once: true };
 return { model: "roja.glb", clip: null, procedural: gesture, once: true };
}
