// Window-ledged choreography adapted from capri-desktop (MIT):
// https://github.com/mochiiwuff/capri-desktop . No artwork is bundled.
export interface Rect { x:number; y:number; width:number; height:number }
export interface RoamFeed { laptop:Rect; region:Rect; x:number; y:number; width:number; height:number; herdr:boolean; blankGrid?:{columns:number;rows:number;scores:number[];perches?:[number,number][]}|null; roamZone?:{xRatio:number} }
export interface RoamGuards { composer?:boolean; question?:boolean; approval?:boolean; sleeping?:boolean; reduced?:boolean; stale?:boolean; paused?:boolean }
export interface RoamPosition { x:number; y:number; resting:'sit'|'stand'; direction:number }
const FLAT_VARIANCE=16;
/** Full rectangular footprint must be flat; uncertain cells count as text. */
export function perchCandidates(feed:RoamFeed):[number,number][]|undefined {
 const grid=feed.blankGrid;
 if(!feed.herdr||!grid)return;
 const {region:r,laptop:l,width:w,height:h}=feed;
 const ratio=r.width<700?0.3:(feed.roamZone?.xRatio??0.5);
 if(!Number.isFinite(ratio)||ratio<0||ratio>=1||![r.x,r.y,r.width,r.height,l.x,l.y,l.width,l.height,w,h].every(Number.isFinite)||w<=0||h<=0)return [];
 const left=Math.max(l.x,r.x+Math.ceil(r.width*ratio)),right=Math.min(l.x+l.width,r.x+r.width);
 const top=Math.max(l.y,r.y),bottom=Math.min(l.y+l.height,r.y+r.height);
 const fits=(x:number,y:number)=>x>=left&&x+w<=right&&y>=top&&y+h<=bottom;
 // Match Area::clamp_rect's inset before testing pixels: native placement must
 // not shift a validated footprint onto neighboring text.
 const clamp=(rect:Rect,x:number,y:number):[number,number]=>{
  const margin=Math.min(12,Math.floor(Math.max(0,rect.width-w)/2),Math.floor(Math.max(0,rect.height-h)/2));
  return [Math.max(rect.x+margin,Math.min(rect.x+Math.max(margin,rect.width-w-margin),x)),Math.max(rect.y+margin,Math.min(rect.y+Math.max(margin,rect.height-h-margin),y))];
 };
 const band={x:r.x+Math.ceil(r.width*ratio),y:r.y,width:r.width-Math.ceil(r.width*ratio),height:r.height};
 const place=(x:number,y:number)=>clamp(l,...clamp(band,x,y));
 const points:[number,number][]=[];
 const {columns,rows,scores}=grid;
 if(Number.isInteger(columns)&&Number.isInteger(rows)&&columns>0&&rows>0&&columns<=96&&rows<=64&&scores.length===columns*rows){
  const locations=grid.perches?.slice(0,128)??Array.from({length:columns*rows},(_,i):[number,number]=>[Math.round(r.x+(i%columns+0.5)*r.width/columns-w/2),Math.round(r.y+(Math.floor(i/columns)+0.5)*r.height/rows-h/2)]);
  for(const [rawX,rawY] of locations){
   if(!Number.isFinite(rawX)||!Number.isFinite(rawY))continue;
   const [x,y]=place(rawX,rawY);
   if(!fits(x,y))continue;
   const c0=Math.floor((x-r.x)*columns/r.width),c1=Math.ceil((x+w-r.x)*columns/r.width);
   const r0=Math.floor((y-r.y)*rows/r.height),r1=Math.ceil((y+h-r.y)*rows/r.height);
   let flat=true;
   for(let cy=r0;cy<r1&&flat;cy++)for(let cx=c0;cx<c1;cx++){
    const variance=scores[cy*columns+cx];
    if(variance===undefined||!Number.isFinite(variance)||variance<0||variance>=FLAT_VARIANCE){flat=false;break;}
   }
   if(flat&&!points.some(p=>p[0]===x&&p[1]===y))points.push([x,y]);
  }
 }
 if(points.length>=2)return points;
 // A bounded native shortlist may miss blank space after right-band clipping.
 if(grid.perches)return perchCandidates({...feed,blankGrid:{...grid,perches:undefined}});
 // Only the original HERDR corner bands may cover text. Never reinterpret the
 // permitted band's left edge as the window's top-left corner.
 const corners:[number,number][]=[];
 for(const [a,b] of [[r.x,Math.min(r.x+260,r.x+r.width)],[Math.max(r.x,r.x+r.width-260),r.x+r.width]]){
  const x0=Math.max(left,a!),x1=Math.min(right,b!)-w,y=top;
  if(y>r.y+140||x1<x0||!fits(x0,y))continue;
  for(const rawX of [x0,x1]){
   const [x,cy]=place(rawX,y);
   if(x<a!||x+w>b!||cy>r.y+140||!fits(x,cy))continue;
   if(!corners.some(p=>p[0]===x&&p[1]===cy))corners.push([x,cy]);
  }
 }
 return corners;
}
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
  const points=perchCandidates(feed)??[[left,bottom],[right,bottom],[right,top],[left,top]];
  if(!points.length)return;
  const index=g.reduced?0:this.index++%points.length;
  const [x,y]=points[index]!;
  this.geometry=key;this.due=now+18000;
  return {x,y,resting:feed.blankGrid?'sit':index===0||index===2?'sit':'stand',direction:index===1||index===2?-1:1};
 }
}
