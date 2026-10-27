// Window-ledged choreography adapted from capri-desktop (MIT):
// https://github.com/mochiiwuff/capri-desktop . No artwork is bundled.
export interface Rect { x:number; y:number; width:number; height:number }
export interface RoamFeed { laptop:Rect; region:Rect; x:number; y:number; width:number; height:number; herdr:boolean; roamZone?:{xRatio:number} }
export interface RoamGuards { composer?:boolean; question?:boolean; approval?:boolean; sleeping?:boolean; reduced?:boolean; stale?:boolean; paused?:boolean }
export interface RoamPosition { x:number; y:number; resting:'sit'|'stand'; direction:number }
/** Deterministic bottom/ledge circuit. No synthetic walk sheet: relocation uses teleport. */
export class RoamDirector {
 private resumeAt=0;
 private due=0;
 private geometry='';
 private index=0;
 dragged(now:number){this.resumeAt=now+10*60*1000;}
 step(feed:RoamFeed,now:number,g:RoamGuards):RoamPosition|undefined {
  if(g.composer||g.question||g.approval||g.sleeping||g.stale||g.paused||now<this.resumeAt)return;
  const key=JSON.stringify([feed.laptop,feed.region,feed.width,feed.height,feed.roamZone]);
  if(key===this.geometry&&(g.reduced||now<this.due))return;
  const l=feed.laptop;
  let r=feed.region;
  if(feed.herdr){
   const configured=feed.roamZone?.xRatio??0.5;
   if(!Number.isFinite(configured)||configured<0||configured>=1)return;
   const ratio=r.width<700?0.3:configured;
   const excluded=Math.ceil(r.width*ratio);
   r={...r,x:r.x+excluded,width:r.width-excluded};
   // Never expand a too-small permitted band back over agents.
   if(r.width<feed.width||r.height<feed.height)return;
  }
  if(![l.x,l.y,l.width,l.height,r.x,r.y,r.width,r.height,feed.width,feed.height].every(Number.isFinite)||l.width<feed.width||l.height<feed.height)return;
  const left=Math.max(l.x,Math.min(l.x+l.width-feed.width,r.x));
  const right=Math.max(left,Math.min(l.x+l.width-feed.width,r.x+r.width-feed.width));
  const top=Math.max(l.y,Math.min(l.y+l.height-feed.height,r.y));
  const bottom=Math.max(top,Math.min(l.y+l.height-feed.height,r.y+r.height-feed.height));
  const points=[[left,bottom],[right,bottom],[right,top],[left,top]] as const;
  const index=g.reduced?0:this.index++%points.length;
  const [x,y]=points[index]!;
  this.geometry=key;this.due=now+18000;
  return {x,y,resting:index===0||index===2?'sit':'stand',direction:index===1||index===2?-1:1};
 }
}
