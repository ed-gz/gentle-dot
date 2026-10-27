// Ported choreography/engine from https://github.com/mochiiwuff/capri-desktop (MIT); artwork not included — personal-use assets loaded locally.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { createEngine, frameAt, sampleSheet, STAND } from "./engine.ts";
let warned = false;
export interface Capri2DProps {
 enabled: boolean; visible: boolean; reduced: boolean;
 onActive(active: boolean): void; onMask(mask: number[]): void;
}
export function Capri2D({ enabled, visible, reduced, onActive, onMask }: Capri2DProps) {
 const canvas = useRef<HTMLCanvasElement>(null);
 const current = useRef({ visible, reduced, onActive, onMask });
 current.current = { visible, reduced, onActive, onMask };
 useEffect(() => {
  if (!enabled || !canvas.current) return;
  const element = canvas.current;
  let live = true, raf = 0, url: string | undefined;
  let engine: ReturnType<typeof createEngine> | undefined;
  let last = -1, previousMask = "";
  const fail = () => {
   cancelAnimationFrame(raf); engine?.dispose(); engine = undefined;
   if (!live) return;
   current.current.onActive(false);
   if (!warned) { warned = true; console.warn("Capri 2D: arte local o WebGL no disponible; se conserva la vista alternativa."); }
  };
  const tick = (now: number) => {
   if (!live || !engine) return;
   if (current.current.visible && !document.hidden) {
    const frame = current.current.reduced ? 0 : frameAt(now);
    if (frame !== last) {
     last = frame;
     const mask = engine.draw(sampleSheet(STAND, frame).pose, frame);
     const key = mask.join("");
     if (key !== previousMask) { previousMask = key; current.current.onMask(mask); }
    }
   }
   raf = requestAnimationFrame(tick);
  };
  const lost = (event: Event) => { event.preventDefault(); fail(); };
  element.addEventListener("webglcontextlost", lost);
  void (async () => {
   const bytes = await invoke<ArrayBuffer | number[]>("capri2d_asset", { name: "capri-full.png" });
   if (!live) return;
   const buffer = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
   url = URL.createObjectURL(new Blob([buffer], { type: "image/png" }));
   const image = new Image(); image.src = url; await image.decode();
   if (!live) return;
   if (image.naturalWidth !== 240 || image.naturalHeight !== 420) throw new Error("Invalid cutout dimensions");
   engine = createEngine(element, image);
   current.current.onActive(true);
   tick(performance.now());
  })().catch(fail);
  return () => {
   live = false; cancelAnimationFrame(raf); engine?.dispose();
   element.removeEventListener("webglcontextlost", lost);
   if (url) URL.revokeObjectURL(url);
   current.current.onActive(false);
  };
 }, [enabled]);
 return <canvas ref={canvas} className="capri3d-canvas" data-capri2d="true" aria-hidden="true" style={{ width: 144, height: 204, display: "block", pointerEvents: "none" }} />;
}
