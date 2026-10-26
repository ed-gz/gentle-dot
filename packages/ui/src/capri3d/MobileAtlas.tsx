import { useEffect, useId, useState, type ReactNode } from 'react';
import type { CapriBehavior } from '@gentle-dot/theme-capri/behavior';
import { atlasAnimationForBehavior, loadMobileAtlas, type MobileAtlas as Atlas } from './mobile-atlas.ts';

export function MobileAtlas({ behavior, playing, fallback, load = loadMobileAtlas }: {
 behavior: CapriBehavior; playing: boolean; fallback: ReactNode;
 load?: (signal: AbortSignal) => Promise<Atlas>;
}) {
 const [atlas, setAtlas] = useState<Atlas>();
 const [failed, setFailed] = useState(false);
 const [index, setIndex] = useState({ name: '', frame: 0 });
 const clip = useId();
 useEffect(() => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  void load(controller.signal).then(value => {
   if (!controller.signal.aborted) { setAtlas(value);setFailed(false); }
  }).catch(() => {}).finally(() => clearTimeout(timeout));
  return () => { clearTimeout(timeout);controller.abort(); };
 }, [load]);
 // Same reply choice CapriCompanion passed to capriBehavior above.
 const name = atlasAnimationForBehavior(behavior.state, behavior.state === 'readingReply' ? 'reply' : undefined);
 const animation = atlas?.animations[name];
 const frameIndex = index.name === name ? index.frame : 0;
 const frame = animation?.frames[frameIndex];
 useEffect(() => {
  if (!playing || failed || !animation || !frame || animation.frames.length < 2) return;
  const once = ['attention', 'done', 'submitted'].includes(behavior.state);
  if (once && frameIndex === animation.frames.length - 1) return;
  const timer = setTimeout(() => setIndex({ name, frame: (frameIndex + 1) % animation.frames.length }), frame.durationMs);
  return () => clearTimeout(timer);
 }, [animation, frame, name, frameIndex, playing, failed, behavior.state]);
 if (!atlas || !animation || !frame || failed) return fallback;
 return <span aria-hidden="true" className="capri-sprite" data-animation={`3d-${name}`} data-frame={frameIndex} data-playing={playing}>
  <svg aria-hidden="true" width="100%" height="100%" viewBox={`0 0 ${animation.canvas.width} ${animation.canvas.height}`} preserveAspectRatio="xMidYMid meet" focusable="false">
   <defs><clipPath id={clip}><rect x={frame.offsetX} y={frame.offsetY} width={frame.width} height={frame.height} /></clipPath></defs>
   <image href={'/' + atlas.image} width={atlas.width} height={atlas.height} x={frame.offsetX - frame.x} y={frame.offsetY - frame.y}
    clipPath={`url(#${clip})`} style={{ imageRendering: 'pixelated' }} onError={() => setFailed(true)} />
  </svg>
 </span>;
}
