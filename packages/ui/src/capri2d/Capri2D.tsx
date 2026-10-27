// Ported from https://github.com/mochiiwuff/capri-desktop (MIT).
// Artwork is not included; personal-use assets are loaded locally.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { createEngine, frameAt, type InputRectangle } from "./engine.ts";
import { RigDirector, type RigIntent } from "./director.ts";
import { RigFx } from "./fx.ts";
import { CHIP_ART, useLocalArt } from './local-art.ts';
import './possession.css';
let warned = false;
export interface Capri2DProps {
 enabled: boolean; visible: boolean; reduced: boolean;
 possessing?:boolean; sleepingPerched?:boolean;
 onActive(active: boolean): void; onMask(mask: number[], bodyRects?:InputRectangle[]): void;
 intent?: RigIntent;
}
export function Capri2D({ enabled, visible, reduced, possessing=false, sleepingPerched=false, onActive, onMask, intent = {} }: Capri2DProps) {
 const art = useLocalArt(CHIP_ART, enabled);
 const canvas = useRef<HTMLCanvasElement>(null);
 const fxCanvas = useRef<HTMLCanvasElement>(null);
 const current = useRef({ visible, reduced, onActive, onMask, intent, possessing, sleepingPerched });
 current.current = { visible, reduced, onActive, onMask, intent, possessing, sleepingPerched };
 useEffect(() => {
  if (!enabled || !canvas.current) return;
  const element = canvas.current;
  let live = true, raf = 0, url: string | undefined;
  const urls: string[] = [];
  const director = new RigDirector();
  let fx: RigFx | undefined;
  try { if (fxCanvas.current) fx = new RigFx(fxCanvas.current); } catch { /* Body still works without the optional FX context. */ }
  let engine: ReturnType<typeof createEngine> | undefined;
  let sourceImage: HTMLImageElement | undefined;
  let wasPossessing=false;
  let last = -1, previousMask = "", previousIntent = "", wasHidden = false, fxSuppressed = false;
  const loadImage = async (name: string) => {
   const bytes = await invoke<ArrayBuffer | number[]>("capri2d_asset", { name });
   if (!live) throw new Error("Disposed");
   const buffer = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
   const objectUrl = URL.createObjectURL(new Blob([buffer], { type: "image/png" }));
   urls.push(objectUrl);
   const image = new Image(); image.src = objectUrl; await image.decode();
   return image;
  };
  const fail = (warn = true) => {
   cancelAnimationFrame(raf); engine?.dispose(); engine = undefined; fx?.clear();
   if (!live) return;
   current.current.onActive(false);
   if (warn && !warned) { warned = true; console.warn("Capri 2D: arte local o WebGL no disponible; se conserva la vista alternativa."); }
  };
  const tick = (now: number) => {
   if (!live || !engine) return;
   const state = current.current;
   const hidden = !state.visible || document.hidden;
   if(state.possessing!==wasPossessing){
    if(!hidden&&!state.reduced)fx?.burst(now,!state.possessing);
    wasPossessing=state.possessing;
   }
   director.update(state.sleepingPerched ? {...state.intent,resting:'sleep'} : state.intent, now, hidden);
   const suppressFx=hidden||state.reduced;
   if (suppressFx && !fxSuppressed) fx?.clear();
   fxSuppressed=suppressFx;
   if (!hidden) {
    const frame = state.reduced ? 0 : frameAt(now, director.fps());
    const intentKey = JSON.stringify([state.intent,state.reduced,state.possessing,state.sleepingPerched]);
    if (frame !== last || intentKey !== previousIntent || wasHidden) {
     last = frame; previousIntent = intentKey;
     const sample = director.sample(now,state.reduced);
     const mask = engine.draw(sample.pose, frame);
     if (!state.reduced) for (const cue of sample.cues) fx?.cue(cue,now,state.intent.direction);
     // Visual-only proxies have no input: never retain the invisible body's silhouette
     // or introduce rectangular hit areas over transparent local-art pixels.
     const bodyRects:InputRectangle[]=state.possessing?[]:engine.inputRectangles();
     const key = JSON.stringify(bodyRects);
     if (key !== previousMask) { previousMask = key; state.onMask(mask,bodyRects); }
    }
    if (!state.reduced) fx?.draw(now);
   }
   wasHidden = hidden;
   raf = requestAnimationFrame(tick);
  };
  const lost = (event: Event) => { event.preventDefault(); fail(false); };
  const restored = () => {
   if (!live || !sourceImage) return;
   try {
    engine = createEngine(element,sourceImage); last=-1; previousMask="";
    current.current.onActive(true); tick(performance.now());
   } catch { fail(); }
  };
  element.addEventListener("webglcontextlost", lost);
  element.addEventListener("webglcontextrestored", restored);
  void (async () => {
   const bytes = await invoke<ArrayBuffer | number[]>("capri2d_asset", { name: "capri-full.png" });
   if (!live) return;
   const buffer = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
   url = URL.createObjectURL(new Blob([buffer], { type: "image/png" }));
   const image = new Image(); image.src = url; await image.decode();
   if (!live) return;
   if (image.naturalWidth !== 240 || image.naturalHeight !== 420) throw new Error("Invalid cutout dimensions");
   sourceImage = image;
   engine = createEngine(element, image);
   for (const kind of ["grin","laugh","eyes"] as const) {
    void loadImage(`cutin-${kind}.png`).then(image => { if (live && fx) fx.cutins[kind] = image; }).catch(() => {});
   }
   current.current.onActive(true);
   tick(performance.now());
  })().catch(fail);
  return () => {
   live = false; cancelAnimationFrame(raf); engine?.dispose(); fx?.clear();
   for (const objectUrl of urls) URL.revokeObjectURL(objectUrl);
   element.removeEventListener("webglcontextlost", lost);
   element.removeEventListener("webglcontextrestored", restored);
   if (url) URL.revokeObjectURL(url);
   current.current.onActive(false);
  };
 }, [enabled]);
 return <>
  {possessing&&<div data-capri-biochip="true" style={{position:'absolute',left:54,top:104,width:36,height:36,pointerEvents:'none',filter:'sepia(1) saturate(3) hue-rotate(45deg)',transition:reduced?'none':'all 350ms'}}>{art['face-many.png']&&<img src={art['face-many.png']} alt="" style={{width:'100%',height:'100%',objectFit:'contain'}}/>}</div>}
  <canvas ref={canvas} className="capri3d-canvas" data-capri2d="true" aria-hidden="true" style={{ width: 144, height: 204, display: "block", pointerEvents: "none",opacity:possessing?0:1,transition:reduced?'none':'opacity 350ms' }} />
  <canvas ref={fxCanvas} data-capri2d-fx="true" aria-hidden="true" style={{ position:"absolute",left:0,top:0,width:144,height:204,pointerEvents:"none" }} />
 </>;
}
