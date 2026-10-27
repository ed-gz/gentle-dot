// Procedural window face inspired by capri-desktop (MIT); see ./LICENSE.
// No upstream artwork: jagged strokes, eyes and mouth are generated geometry.
import {useEffect,useState} from 'react';
export function crackedBorder(width:number,height:number){
 const w=Math.max(20,width),h=Math.max(20,height);
 const points:string[]=[];
 for(let side=0;side<4;side++)for(let i=0;i<25;i++){
  const t=i/24,offset=i%3===1?10:i%3===2?4:7;
  const [x,y]=side===0?[t*w,offset]:side===1?[w-offset,t*h]:side===2?[(1-t)*w,h-offset]:[offset,(1-t)*h];
  points.push(`${x},${y}`);
 }
 return points.join(' ');
}
export function CapriPossession({started}:{started:number}){
 const [time,setTime]=useState(0);
 const [aborted,setAborted]=useState(false);
 useEffect(()=>{
  let raf=0,last=-1;
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  const abort=()=>setAborted(true);
  const reduce=()=>{if(motion.matches)abort();};reduce();
  document.addEventListener('visibilitychange',abort);motion.addEventListener('change',reduce);
  const tick=(now:number)=>{const t=now-started;if(Math.floor(t/60)!==last){last=Math.floor(t/60);setTime(t);}if(t<6000)raf=requestAnimationFrame(tick);};
  raf=requestAnimationFrame(tick);
  return()=>{cancelAnimationFrame(raf);document.removeEventListener('visibilitychange',abort);motion.removeEventListener('change',reduce);};
 },[started]);
 if(aborted||time>=6000)return null;
 const w=innerWidth,h=innerHeight,cx=w*.72,cy=h*.3;
 const opacity=Math.min(1,time/450,(6000-time)/700);
 const blink=time%2800>2650?.08:1;
 return <svg data-capri-possession="true" aria-hidden="true" viewBox={`0 0 ${w} ${h}`} style={{position:'fixed',inset:0,width:'100%',height:'100%',pointerEvents:'none',opacity}}>
  <polygon points={crackedBorder(w,h)} fill="none" stroke="#ff65ad" strokeWidth="3"/>
  {Array.from({length:12},(_,i)=>{const x=w*(i+1)/13;return <path key={i} d={`M${x} 7 l-12 17 18 8 -9 20 M${w-x} ${h-7} l10 -18 -16 -9 6 -16`} stroke="#ff65ad" strokeWidth="2" fill="none"/>;})}
  <g stroke="#f4ff9a" strokeWidth="5" fill="#a6f776" transform={`translate(${cx},${cy})`}>
   <ellipse cx="-65" cy="0" rx="35" ry={22*blink}/><ellipse cx="65" cy="0" rx="35" ry={22*blink}/>
   <path d={`M-38 63 Q0 ${88+Math.sin(time/130)*10} 38 63 Q0 108 -38 63`} stroke="#ff65ad" fill="#291a32"/>
  </g>
 </svg>;
}
