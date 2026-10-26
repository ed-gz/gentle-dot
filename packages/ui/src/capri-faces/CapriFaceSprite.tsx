import { useEffect, useState } from 'react';
import { CAPRI_FACES, faceAnimation } from '@gentle-dot/theme-capri/faces';
import href from '@gentle-dot/theme-capri/assets/capri-faces-v1.png';

/** Sparse authored frames; paused/hidden/reduced-motion consumers never run a clock. */
export function CapriFaceSprite({ action, playing = false, className = '' }: {
 action: string; playing?: boolean; className?: string;
}) {
 const name=faceAnimation(action),animation=CAPRI_FACES.animations[name];
 const [cursor,setCursor]=useState({name,index:0});
 const index=cursor.name===name?cursor.index%animation.frames.length:0;
 useEffect(()=>{
  if(!playing)return;
  const timer=setTimeout(()=>setCursor({name,index:(index+1)%animation.frames.length}),animation.frames[index]!.durationMs);
  return ()=>clearTimeout(timer);
 },[playing,name,index,animation]);
 const frame=animation.frames[index]!;
 return <span aria-hidden="true" className={`capri-sprite ${className}`} data-pose={action}
  data-faces-animation={name} data-animation={name} data-frame={index} data-playing={playing}
  style={{display:'block',width:'100%',height:'100%'}}>
  <svg aria-hidden="true" width="100%" height="100%" viewBox={`${frame.x} ${frame.y} ${frame.width} ${frame.height}`}
   preserveAspectRatio="xMidYMid meet" overflow="hidden" focusable="false">
   <image href={href} width={CAPRI_FACES.width} height={CAPRI_FACES.height}/>
  </svg>
 </span>;
}
