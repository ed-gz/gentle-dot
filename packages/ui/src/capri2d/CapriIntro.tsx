// "When she starts" choreography adapted from mochiiwuff/capri-desktop (MIT).
// See ./LICENSE. Personal close-up drawings load through the local-art allowlist.
import { useEffect, useState } from 'react';
import { INTRO_ART, useLocalArt } from './local-art.ts';
import { IntroDriver, INTRO_BEATS } from './intro.ts';
import './intro.css';
import { CapriPossession } from './CapriPossession.tsx';
interface Configuration { possession?:boolean; ready:boolean; started?:number; target:{x:number;y:number;width:number;height:number} }
declare global { interface Window { __CAPRI_INTRO__?:Configuration } }
const ease=(p:number)=>p*p*(3-2*p);
export function CapriIntro() {
 const [config,setConfig]=useState(window.__CAPRI_INTRO__);
 const art=useLocalArt(INTRO_ART,Boolean(config?.ready&&!config.possession));
 const [frame,setFrame]=useState({beat:'done',progress:1,elapsed:0} as ReturnType<IntroDriver['sample']>);
 useEffect(()=>{
  document.documentElement.dataset.surface='capri-intro';
  const ready=()=>setConfig({...window.__CAPRI_INTRO__!});
  window.addEventListener('capri-intro-ready',ready);ready();
  return()=>window.removeEventListener('capri-intro-ready',ready);
 },[]);
 useEffect(()=>{
  if(!config?.ready||config.possession)return;
  const driver=new IntroDriver();
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  driver.start('native-window',config.started??performance.now(),reduced.matches);
  let raf=0,last=-1;
  const abort=()=>{driver.abort();setFrame(driver.sample(performance.now()));};
  const reduce=()=>{if(reduced.matches)abort();};
  reduced.addEventListener('change',reduce);
  document.addEventListener('visibilitychange',abort);
  const tick=(now:number)=>{
   // Smooth travel; cel redraws capped at 24fps. No background or permanent loop.
   const sample=driver.sample(now);
   if(sample.beat==='done'||Math.floor(now/42)!==last){last=Math.floor(now/42);setFrame(sample);}
   if(sample.beat!=='done')raf=requestAnimationFrame(tick);
  };
  raf=requestAnimationFrame(tick);
  return()=>{cancelAnimationFrame(raf);driver.abort();reduced.removeEventListener('change',reduce);document.removeEventListener('visibilitychange',abort);};
 },[config?.ready,config?.started]);
 if(config?.ready&&config.possession)return <CapriPossession started={config.started??performance.now()}/>;
 if(!config?.ready||frame.beat==='done')return null;
 const {beat,progress:p,elapsed:t}=frame;
 const w=window.innerWidth,h=window.innerHeight;
 const target=config.target;
 const stage=INTRO_BEATS.findIndex(([name])=>name===beat);
 const diving=stage>=15;
 const travel=diving?ease(Math.min(1,(t-6100)/1050)):0;
 const size=Math.min(w*.35,h*.48,400);
 const finalSize=Math.min(target.width,target.height*.65);
 const headSize=size+(finalSize-size)*travel;
 const x=w*.5+(target.x+target.width*.5-w*.5)*travel;
 const y=h*.43+(target.y+target.height*.26-h*.43)*travel-(diving?Math.sin(travel*Math.PI)*h*.12:0);
 const shake=stage>=4&&stage<=6?Math.sin(t*.15)*2:0;
 const headLift=beat==='haul'?(1-ease(p))*h*.6:0;
 const cel=Math.min(3,1+Math.floor(p*3));
 const faceName=beat==='blink'?'face-calm.png':beat==='hi'?`intro-mouth${cel}.webp`:beat==='wave'?`intro-wave${cel}.webp`:beat==='haul'||beat==='regrab'?'intro-grab.webp':beat==='look'||beat==='glance'||beat==='shatter'?'intro-happy.webp':'intro-smear.webp';
 const sceneName=faceName.startsWith('intro-')?faceName:undefined;
 const sceneSource=sceneName?art[sceneName]:undefined;
 const faceSource=!sceneSource?(art[faceName]??(beat==='hi'?art['face-smug.png']:undefined)):undefined;
 const arms=stage>=1&&stage<14&&!sceneSource;
 const right=stage>=2;
 const wave=beat==='wave';
 const armEndY=h*.4;
 return <div className="capri-intro" data-beat={beat} aria-hidden="true" style={{transform:`translate(${shake}px,${-shake}px)`}}>
  {stage<14&&<svg className="capri-intro-limbs" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
   <path className="capri-intro-edge" d={`M4 ${h*.2} L12 ${h*.23} L4 ${h*.27} L9 ${h*.31} L4 ${h*.35} L4 ${h-4} L${w*.3} ${h-8} M${w-4} 4 L${w-4} ${h*.2} L${w-13} ${h*.23} L${w-4} ${h*.28} L${w-9} ${h*.31} L${w-4} ${h*.35} L${w-4} ${h-4} M4 4 L${w*.3} 8 L${w*.32} 4 L${w*.34} 9 L${w*.36} 4 L${w-4} 4`} />
   {arms&&[false,true].map((isRight)=>{
    if(isRight&&!right)return null;
    const reach=wave?ease(Math.min(1,p*5)):beat==='regrab'?1-ease(Math.min(1,p*4)):0;
    const handX=isRight?w-15+(w*.78-w+15)*reach:15;
    const handY=isRight?armEndY+(h*.22-armEndY)*reach:armEndY;
    const shoulderX=w*.5+(isRight?size*.33:-size*.33);
    const shattering=beat==='shatter';
    return <g key={String(isRight)} opacity={shattering?1-p:1}>
     <path className="capri-intro-arm" d={`M${shoulderX} ${h*.5+headLift*.4} Q${isRight?w*.78:w*.22} ${h*.68-headLift*.2} ${handX} ${handY}`} pathLength="1" style={{strokeDasharray:1,strokeDashoffset:shattering?p:0}} />
     <g transform={`translate(${handX},${handY}) rotate(${isRight?(wave?-35+Math.sin(p*Math.PI*4)*18:180):0})`}>
      <path className="capri-intro-hand" d="M-8 24 L-13 -8 Q-12 -18 -7 -9 L-2 2 L-3 -22 Q0 -29 4 -22 L9 -4 L12 -22 Q16 -26 19 -19 L19 0 L25 -14 Q31 -18 32 -10 L28 11 L34 4 Q43 5 37 14 L20 31 Z" />
     </g>
    </g>;
   })}
  </svg>}
  {!sceneSource&&beat==='shatter'&&Array.from({length:24},(_,i)=>{
   const right=i%2===0;
   const inward=Math.floor(i/2)/12;
   const q=Math.max(0,(p-inward*.55)/.45);
   return <i key={i} className="capri-intro-shard" style={{left:`${(right?1-inward*.45:inward*.45)*100}%`,top:`${40+q*30}%`,opacity:q>0?1-q:0,transform:`translate(${(right?1:-1)*q*60}px,${q*70}px) rotate(${i*27+q*180}deg)`}}/>;
  })}
  {!sceneSource&&stage>=3&&<div className={`capri-intro-head ${beat==='split'?'capri-intro-split':''}`} style={{left:x,top:y+headLift,width:headSize,height:headSize,transform:`translate(-50%,-50%) scaleY(${beat==='crouch'?1-p*.4:beat==='unfold'?1-p:1}) rotate(${beat==='look'?Math.sin(p*Math.PI*2)*8:beat==='glance'?12:0}deg)`}}>
   {faceSource&&<img src={faceSource} alt="" style={{width:'100%',height:'100%',objectFit:'contain'}}/>}
  </div>}
  {sceneSource&&<img className="capri-intro-scene" src={sceneSource} alt=""/>}
  {stage>=9&&stage<=12&&<div className="capri-intro-tag" style={{left:w*.5+size*.35,top:h*.3}}><b>hi</b><span>{'CAPRI'.slice(0,Math.min(5,Math.floor((t-2750)/95)))}</span></div>}
  {(beat==='impact-white'||beat==='impact-ink')&&<div className="capri-intro-flash" style={{background:beat==='impact-white'?'#fff9e5':'#08080d'}}/>}
  <small className="capri-intro-skip" style={{left:target.x,top:Math.min(h-24,target.y+target.height)}}>Clic en Capri pequeña para omitir</small>
 </div>;
}
