// Ported from https://github.com/mochiiwuff/capri-desktop (MIT): Capri.animate semantics.
import { ACTS, NEUTRAL, SEATED, RigPlayer, cadence, resolvePose, type ActName, type Drawing } from './acting.ts';
export interface RigIntent {
 question?: string; direction?: number; outcome?: {kind:'done'|'error';at:number};
 resting?: 'stand'|'sit'|'sleep'|'wake'; travelling?: boolean; falling?: boolean; talking?: boolean;
 /** Coarse local events only. No drafts, commands, transcripts or pointer history. */
 pointer?: number; dragging?: boolean; watching?: boolean; working?: boolean; seated?: boolean;
 alert?: boolean; thinking?: boolean; workBeat?: string;
 gesture?: {name:string;at:number};
}
const gestures:Record<string,ActName>={saludar:'hop',salto:'hop',voltereta:'spin',bailar:'spin',transformarse:'split',guino:'curious',brazos:'gaze',estirarse:'uplink'};
export function selectAct(intent:RigIntent): ActName {
 if(intent.question)return 'point';
 if(intent.alert)return 'alarm';
 if(intent.dragging)return 'flinch';
 if(intent.outcome)return intent.outcome.kind==='done'?'victory':'hurt';
 if(intent.falling)return 'fall';
 if(intent.travelling)return 'teleport';
 if(intent.resting==='wake')return 'wake';
 if(intent.gesture && gestures[intent.gesture.name])return gestures[intent.gesture.name]!;
 if(intent.pointer!==undefined)return 'curious';
 if(intent.watching)return 'peek';
 if(intent.resting==='sleep')return 'sleep';
 if(intent.resting==='sit')return 'sit';
 if(intent.talking)return 'talk';
 return intent.working?(intent.thinking?'gaze':'look'):'stand';
}
export class RigDirector {
 private base=new RigPlayer('stand',0);
 private overlay:RigPlayer|undefined;
 private identity='';
 private prior:ActName='stand';
 private direction=1;
 private flashAt=-Infinity;
 private sleptAt=Infinity;
 private wakeUntil=-Infinity;
 private pointer:number|undefined;
 private seated=false;
 private pendingCues:string[]=[];
 private workBeat:string|undefined;
 update(intent:RigIntent,now:number,hidden=false){
  this.direction=intent.direction??1;
  this.seated=intent.resting==='sit'||Boolean(intent.seated);
  if(intent.working&&intent.workBeat!==this.workBeat&&intent.workBeat&&!intent.question&&!intent.alert&&!intent.dragging)this.pendingCues.push('work');
  this.workBeat=intent.working?intent.workBeat:undefined;
  const pointerNew=intent.pointer!==undefined&&intent.pointer!==this.pointer;
  this.pointer=intent.pointer;
  if(pointerNew)this.wakeUntil=now+15000;
  const sleeping=intent.resting==='sleep'&&!intent.question&&!intent.working&&!intent.talking&&!intent.dragging&&now>=this.wakeUntil;
  const baseName=intent.question?'pointing':intent.falling?'fall':sleeping?'sleep':intent.resting==='sit'?'sit':intent.watching?'peek':'stand';
  const wasSleeping=this.base.name==='sleep';
  if(this.base.name!==baseName||this.base.dir!==this.direction)this.base=new RigPlayer(baseName,now,this.direction);
  if(sleeping){if(!wasSleeping)this.sleptAt=now;}else this.sleptAt=Infinity;
  const name=wasSleeping&&!sleeping?'wake':selectAct({...intent,resting:sleeping?'sleep':intent.resting==='sleep'?'stand':intent.resting});
  const id=intent.question?`question:${intent.question}`:intent.outcome?`${intent.outcome.kind}:${intent.outcome.at}`:
   intent.dragging?'drag':intent.gesture?`gesture:${intent.gesture.at}:${intent.gesture.name}`:
   intent.pointer!==undefined?`pointer:${intent.pointer}`:intent.working?`${name}:${intent.workBeat??''}`:name;
  if(id!==this.identity){
   this.identity=id;
   const next=['stand','sleep','sit','peek','fall'].includes(name)?undefined:new RigPlayer(name,now,this.direction);
   // Explicit human gestures must not disappear behind a celebration. Only a
   // gesture selected by the priority rules can interrupt the current overlay.
   const humanGesture=Boolean(intent.gesture&&gestures[intent.gesture.name]===name);
   const release=humanGesture||Boolean(intent.question)||intent.alert||intent.dragging||this.prior==='point'||this.prior==='fall'||wasSleeping&&!sleeping;
   if(release||!this.overlay||!this.overlay.sample(now)||(next?.act.priority??0)>=(this.overlay.act.priority??0))this.overlay=next;
   if(this.prior==='point'&&!intent.question&&!next)this.overlay=new RigPlayer('unpoint',now,this.direction);
   if(this.prior==='fall'&&!intent.falling&&!next)this.overlay=new RigPlayer(intent.resting==='sit'?'plop':'land',now,this.direction);
   if(name==='sit'&&this.prior!=='sit')this.overlay=new RigPlayer('plop',now,this.direction);
   this.prior=name;
  }
  // Talk is the reference's short nod repeated while speech is actually visible.
  if(name==='talk'&&(!this.overlay||!this.overlay.sample(now)))this.overlay=new RigPlayer('talk',now,this.direction);
  if(hidden){this.overlay=undefined;this.base.consume(now);this.pendingCues=[];}
 }
 fps(){return cadence(this.base.name,this.overlay?.name);}
 sample(now:number,reduced=false):{pose:Drawing;cues:string[];act:ActName}{
  // The seated baseline also applies to reactions and reduced-motion statics.
  // Pose bob is relative to that baseline; keep the ledge contact nearly still.
  const ground=(pose:Drawing):Drawing=>this.seated?{...pose,bob:SEATED.bob+Math.max(-1,Math.min(1,pose.bob??0))}:pose;
  if(reduced){
   this.base.consume(now);this.overlay?.consume(now);this.pendingCues=[];
   const name=this.overlay?.name??this.base.name;
   const sheet=ACTS[name];
   const key=name==='victory'?sheet.keys.find(key=>key[2]==='peak')!:sheet.keys[0]!;
   const pose=resolvePose({...(this.seated?{...SEATED,bob:0}:{}),...key[1]},this.direction);
   return {pose:{...NEUTRAL,...ground(pose),sit:this.seated?1:0,smear:[0,0],echo:[0,0],glitch:0,split:0,silAmount:0,collapse:0,dissolve:0,alpha:1},cues:[],act:name};
  }
  const under=this.base.advance(now);
  const over=this.overlay?.advance(now);
  const cues=[...this.pendingCues,...(over?.cues??under.cues)];this.pendingCues=[];
  if(over&&!over.pose)this.overlay=undefined;
  const pose:Drawing={...NEUTRAL,...(this.seated?{...SEATED,bob:0}:{}),...under.pose,...over?.pose,sit:this.seated?1:0};
  if(cues.includes('peak'))this.flashAt=now;
  const flash=Math.floor((now-this.flashAt)*24/1000);
  if(flash>=0&&flash<3){pose.sil=flash===1?[.08,.06,.11]:[.21,1,.48];pose.silAmount=1;}
  if(this.overlay?.name==='hurt'){
   const age=now-this.overlay.start;
   pose.sil=[1,.13,.32];pose.silAmount=age<1000/12?1:0;
   const fade=age<1000/12?0:Math.pow(Math.max(0,1-(age-1000/12)/450),3);
   pose.glitch=.7*fade;pose.split=7*fade;
  }
  if(this.base.name==='sleep'){
   pose.alpha=.55;pose.sparkle=.35;pose.boil=.4;
   if(now-this.sleptAt>=20000){pose.mask=1;pose.alpha=0;}
  }
  return {pose:ground(pose),cues,act:this.overlay?.name??this.base.name};
 }
}
