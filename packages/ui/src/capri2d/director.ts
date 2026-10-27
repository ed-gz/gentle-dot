// Ported from https://github.com/mochiiwuff/capri-desktop (MIT): Capri.animate semantics.
import { ACTS, NEUTRAL, RigPlayer, cadence, resolvePose, type ActName, type Drawing } from './acting.ts';
export interface RigIntent {
 question?: string; direction?: number; outcome?: {kind:'done'|'error';at:number};
 resting?: 'stand'|'sit'|'sleep'|'wake'; travelling?: boolean; falling?: boolean; talking?: boolean;
}
export function selectAct(intent:RigIntent): ActName {
 if(intent.question)return 'point';
 if(intent.outcome)return intent.outcome.kind==='done'?'victory':'hurt';
 if(intent.falling)return 'fall';
 if(intent.travelling)return 'teleport';
 if(intent.resting==='wake')return 'wake';
 if(intent.resting==='sleep')return 'sleep';
 if(intent.resting==='sit')return 'sit';
 return intent.talking?'talk':'stand';
}
export class RigDirector {
 private base=new RigPlayer('stand',0);
 private overlay:RigPlayer|undefined;
 private identity='';
 private prior:ActName='stand';
 private direction=1;
 private flashAt=-Infinity;
 update(intent:RigIntent,now:number,hidden=false){
  const baseName=intent.question?'pointing':intent.resting==='sit'?'sit':intent.resting==='sleep'?'sleep':'stand';
  this.direction=intent.direction??1;
  if(this.base.name!==baseName||this.base.dir!==this.direction)this.base=new RigPlayer(baseName,now,this.direction);
  const name=selectAct(intent);
  const id=intent.question?`question:${intent.question}`:intent.outcome?`${intent.outcome.kind}:${intent.outcome.at}`:name;
  if(id!==this.identity){
   this.identity=id;
   const next=name==='stand'||name==='sleep'||name==='sit'?undefined:
    new RigPlayer(name,now,this.direction);
   // Questions must release immediately on withdrawal; other acts retain reference priority.
   const release=this.prior==='point'||this.prior==='fall';
   if(release||!this.overlay||!this.overlay.sample(now)||(next?.act.priority??0)>=(this.overlay.act.priority??0))this.overlay=next;
   if(this.prior==='point'&&!intent.question&&!next)this.overlay=new RigPlayer('unpoint',now,this.direction);
   if(this.prior==='fall'&&!intent.falling&&!next)this.overlay=new RigPlayer('land',now,this.direction);
   if(this.prior==='sleep'&&name==='stand')this.overlay=new RigPlayer('wake',now,this.direction);
   if(name==='sit'&&this.prior!=='sit')this.overlay=new RigPlayer('plop',now,this.direction);
   this.prior=name;
  }
  if(hidden){this.overlay=undefined;this.base.consume(now);}
 }
 fps(){return cadence(this.base.name,this.overlay?.name);}
 sample(now:number,reduced=false):{pose:Drawing;cues:string[];act:ActName}{
  if(reduced){
   const name=this.overlay?.name??this.base.name;
   const sheet=ACTS[name];
   const key=name==='victory'?sheet.keys.find(key=>key[2]==='peak')!:sheet.keys[0]!;
   const pose=resolvePose(key[1],this.direction);
   return {pose:{...NEUTRAL,...pose,sit:this.base.name==='sit'?1:0,smear:[0,0],echo:[0,0],glitch:0,split:0,silAmount:0,collapse:0,dissolve:0,alpha:1},cues:[],act:name};
  }
  const under=this.base.advance(now);
  let act=this.overlay?.advance(now);
  if(act&&!act.pose){this.overlay=undefined;act=undefined;}
  const pose:Drawing={...NEUTRAL,...under.pose,...act?.pose,sit:this.base.name==='sit'?1:0};
  const cues=act?.cues??under.cues;
  if(cues.includes('peak'))this.flashAt=now;
  const flash=Math.floor((now-this.flashAt)*24/1000);
  if(flash>=0&&flash<3){pose.sil=flash===1?[.08,.06,.11]:[.21,1,.48];pose.silAmount=1;}
  if(this.overlay?.name==='hurt'){
   const age=now-this.overlay.start;
   pose.sil=[1,.13,.32];pose.silAmount=age<1000/12?1:0;
   const fade=age<1000/12?0:Math.pow(Math.max(0,1-(age-1000/12)/450),3);
   pose.glitch=.7*fade;pose.split=7*fade;
  }
  if(this.base.name==='sleep'){pose.alpha=.55;pose.sparkle=.35;pose.boil=.4;}
  if(this.base.name==='sit')pose.bob=Math.max(-3,Math.min(2,pose.bob??0));
  return {pose,cues,act:this.overlay?.name??this.base.name};
 }
}
