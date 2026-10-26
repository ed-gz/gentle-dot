export interface FaceFrame { x: number; y: number; width: number; height: number; offsetX: number; offsetY: number; durationMs: number }
export interface FaceClip { canvas: { width: number; height: number }; frames: FaceFrame[] }
export interface FaceManifest { width: number; height: number; animations: Record<string, FaceClip> }
export type DesktopForm = "3d" | "face";
export interface DesktopFace { animation?: string; form: DesktopForm }
/** Every atlas expression has a semantic cause; unknown signals leave the model alone. */
export function desktopFace(event: string): string | undefined {
 return ({ typing: "typing-watch", working: "working", question: "pointing", done: "happy", error: "crying", idle: "sleepy", return: "wake", output: "look", denied: "angry", notification: "surprised" } as Record<string, string>)[event];
}
export function transitionFace(before: DesktopForm, after: DesktopForm) {
 return before !== after ? "glitch-transition" : undefined;
}
/** A face is drawn only when it replaces the body or during the metamorphosis, never as a second head. */
export function headVisible(form: DesktopForm, transition: boolean, framed: boolean): boolean { return framed && (form === "face" || transition); }
export function faceFrame(clip: FaceClip | undefined, elapsedMs: number, once: boolean): FaceFrame | undefined {
 if (!clip?.frames.length) return;
 const total = clip.frames.reduce((sum, frame) => sum + Math.max(34, frame.durationMs), 0);
 let time = once ? Math.min(Math.max(0, elapsedMs), total - 1) : Math.max(0, elapsedMs) % total;
 for (const frame of clip.frames) {
  time -= Math.max(34, frame.durationMs);
  if (time < 0) return frame;
 }
 return clip.frames.at(-1);
}
/** Package asset imports keep the shared atlas owned by the theme, never copy it into UI. */
export async function loadDesktopFaces(): Promise<{ manifest: FaceManifest; href: string } | undefined> {
 try {
  const [manifest, image] = await Promise.all([
   import("@gentle-dot/theme-capri/assets/capri-faces-v1.json"),
   import("@gentle-dot/theme-capri/assets/capri-faces-v1.png?url"),
  ]);
  const value = manifest.default as FaceManifest;
  if (!(value.width > 0 && value.height > 0 && value.animations)) return;
  return { manifest: value, href: image.default };
 } catch { return; } // Missing/broken atlas must not disable the 3D fallback.
}
