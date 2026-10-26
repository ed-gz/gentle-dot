import { useEffect, useRef } from "react";
import type { CapriBehavior } from "@gentle-dot/theme-capri/behavior";
import { loadBaseAsset, type AssetReader } from "./assets.ts";
import { clipForBehavior, type ClipChoice } from "./mapping.ts";
import type { CapriRenderer, RendererFactory } from "./renderer.ts";

const defaultFactory: RendererFactory = async options => {
 const { createRenderer } = await import("./renderer.ts");
 return createRenderer(options);
};
interface Props {
 enabled: boolean;
 preferred: boolean;
 visible: boolean;
 reduced: boolean;
 behavior: CapriBehavior;
 replyKind?: "reply" | "reading" | "submitted";
 choice?: ClipChoice;
 read: AssetReader;
 factory?: RendererFactory;
 onActive(active: boolean): void;
 onMask(cells: number[]): void;
}
export function Capri3D(props: Props) {
 const { enabled, preferred, read, factory = defaultFactory } = props;
 const canvas = useRef<HTMLCanvasElement>(null);
 const renderer = useRef<CapriRenderer | undefined>(undefined);
 const latest = useRef(props);
 latest.current = props;
 useEffect(() => {
  let live = true;
  const failure = () => {
   if (!live) return;
   renderer.current?.dispose(); renderer.current = undefined;
   latest.current.onActive(false);
  };
  latest.current.onActive(false);
  if (!enabled || !preferred) return;
  void (async () => {
   const base = await loadBaseAsset(read);
   if (!live || !base || !canvas.current) return;
   const instance = await factory({ canvas: canvas.current, base, read,
    mask: cells => { if (live) latest.current.onMask(cells); }, failure });
   if (!live) { instance.dispose(); return; }
   renderer.current = instance;
   const current = latest.current;
   instance.visibility(current.visible, current.reduced);
   await instance.choose(current.choice ?? clipForBehavior(current.behavior, current.replyKind));
   if (live && renderer.current === instance) current.onActive(true);
  })().catch(failure);
  return () => {
   live = false;
   renderer.current?.dispose(); renderer.current = undefined;
   latest.current.onActive(false);
  };
 }, [enabled, preferred, read, factory]);
 const { state, animation, target } = props.behavior;
 useEffect(() => {
  const instance = renderer.current;
  if (instance) void instance.choose(props.choice ?? clipForBehavior({ state, animation, target }, props.replyKind)).catch(() => {
   instance.dispose();
   if (renderer.current === instance) { renderer.current = undefined; latest.current.onActive(false); }
  });
 }, [state, animation, target, props.replyKind, props.choice]);
 useEffect(() => { renderer.current?.visibility(props.visible, props.reduced); }, [props.visible, props.reduced]);
 return <canvas ref={canvas} className="capri3d-canvas" width={240} height={340} aria-hidden="true" />;
}
