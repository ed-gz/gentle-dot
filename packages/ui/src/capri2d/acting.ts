// Ported from https://github.com/mochiiwuff/capri-desktop (MIT).
// Exposure drawings are not tweened. Teleport/hurt adapt capri.js timelines to sheets.
import { REPERTOIRE } from './repertoire.ts';
export type Vec2 = [number, number];
export interface Drawing {
 head?: number; mane?: number; hair?: number; tilt?: number; bob?: number; sx?: number; sy?: number;
 arms?: number; armL?: number; armR?: number; reach?: number; long?: number; longL?: number; longR?: number;
 smear?: Vec2; echo?: Vec2; kickL?: number; kickR?: number; sit?: number;
 glitch?: number; split?: number; collapse?: number; dissolve?: number; alpha?: number;
 boil?: number; sparkle?: number; grade?: number;
 silAmount?: number; sil?: [number,number,number];
 /** Sleep mask rendered procedurally, never external artwork. */
 mask?: number;
}
type Key = [number, Drawing, string?];
export interface Act { loop?: boolean; directional?: boolean; fps?: number; priority?: number; keys: Key[] }
const rep = (n: number, keys: Key[]): Key[] => Array.from({length:n},()=>keys).flat();
export const NEUTRAL = {head:0,mane:0,hair:0,tilt:0,bob:0,sx:1,sy:1,armL:0,armR:0,longL:1,longR:1,smear:[0,0] as Vec2,echo:[0,0] as Vec2,kickL:0,kickR:0};
// Sit shortens the 73px thigh to 22%. Drop the hips to keep the feet at
// y=468 (8px above the padded canvas bottom), rather than floating mid-cell.
export const SEATED = {bob:107,tilt:-2,kickL:.04,kickR:.04,armL:-.4,armR:-.4};
export const ACTS = {
 ...REPERTOIRE,
 stand: {loop:true, keys:[
  [6,{bob:0,hair:-2.5,arms:.04}], [4,{bob:-2,hair:0,arms:0}],
  [6,{bob:-4,hair:2.5,arms:-.05}], [4,{bob:-2,hair:0,arms:0}],
 ]},
 sit: {loop:true,keys:[
  [12,{...SEATED,bob:0,hair:-.6,kickL:.06,kickR:.02}],
  [12,{...SEATED,bob:0,hair:.6,kickL:.02,kickR:.06}],
  [14,{...SEATED,bob:0,head:.04}],
 ]},
 sleep: {loop:true,keys:[
  [18,{head:.1,mane:-.12,bob:2,arms:-.3}], [1,{head:.16,mane:-.13,bob:4,arms:-.34}],
  [10,{head:.21,mane:-.15,bob:5,arms:-.36}], [1,{head:.06,mane:-.08,bob:0,smear:[0,8],arms:-.18}],
  [4,{head:.08,mane:-.1,bob:1,arms:-.26}],
 ]},
 talk: {priority:0,keys:rep(2,[[3,{head:.04,mane:.08}],[3,{head:0,mane:.03}]])},
 curious: {priority:1,directional:true,keys:[
  [1,{head:-.05,mane:.04}], [1,{head:.12,mane:.15,tilt:1,smear:[-12,4]}],
  [10,{head:.19,mane:.14,tilt:2}], [6,{head:.16,mane:.1,tilt:1.6}], [1,{head:.07,tilt:.6}],
 ]},
 victory: {priority:4,fps:24,directional:true,keys:[
  [3,{sy:.9,sx:1.05,bob:6,arms:-.3,mane:-.15}],
  [3,{sy:.82,sx:1.1,bob:10,arms:-.5,mane:-.3,head:-.04},'gather'],
  [1,{sy:1.24,sx:.85,bob:-16,arms:.55,mane:.45,smear:[0,22],echo:[12,0]},'launch'],
  [2,{sy:1.1,sx:.94,bob:-30,arms:1.45,mane:.85,echo:[20,-4]},'peak'],
  [10,{bob:-36,arms:1.32,mane:.78,head:.05}],
  [2,{bob:-34,arms:1.18,mane:.7,head:-.08},'laugh'],
  [2,{bob:-38,arms:1.36,mane:.8,head:.08}],
  ...rep(4,[[2,{bob:-34,arms:1.18,mane:.7,head:-.08}],[2,{bob:-38,arms:1.36,mane:.8,head:.08}]]),
  [2,{bob:-24,arms:.7,mane:.45,sy:1.04},'speak'],
  [2,{bob:-8,arms:.15,mane:.2,sy:1.06,sx:.96,smear:[0,-12]}],
  [2,{bob:3,arms:-.15,mane:-.06,sy:.88,sx:1.08}],
  [3,{bob:1,arms:.05,sy:.97,sx:1.02}], [2,{arms:0}],
 ]},
 point: {priority:2,fps:24,directional:true,keys:[
  [2,{head:.16,mane:.15,tilt:1,smear:[-10,2]},'spot'],
  [3,{head:.2,mane:.12,tilt:1.5}],
  [3,{reach:-.45,long:.8,head:.12,tilt:-5,sy:.9,sx:1.06,bob:5,mane:-.2}],
  [2,{reach:-.55,long:.75,head:.1,tilt:-6,sy:.86,sx:1.08,bob:7,mane:-.28},'coil'],
  [1,{reach:.9,long:2.3,head:.24,tilt:8,sx:.94,sy:1.1,mane:.6,smear:[-18,0],echo:[14,0]},'lock'],
  [1,{reach:1.08,long:2,head:.22,tilt:7,mane:.55,echo:[8,0]}],
  [2,{reach:1.02,long:1.42,head:.19,tilt:4,mane:.4}],
  [2,{reach:.98,long:1.58,head:.18,tilt:3,mane:.3}],
  [2,{reach:1,long:1.5,head:.17,tilt:3,mane:.22}],
 ]},
 pointing: {loop:true,directional:true,keys:[
  [12,{reach:1,long:1.5,head:.17,mane:.16,tilt:3}],
  [1,{reach:1.05,long:1.8,head:.2,mane:.24,tilt:4},'tap'],
  [2,{reach:1,long:1.52,head:.18,mane:.18,tilt:3}],
  [1,{reach:1.05,long:1.8,head:.2,mane:.24,tilt:4},'tap'],
  [10,{reach:1,long:1.5,head:.17,mane:.16,tilt:3,bob:-2}],
  [1,{reach:1,long:1.5,head:.02,mane:.12,tilt:2,smear:[10,0]}],
  [8,{reach:1,long:1.5,head:-.1,mane:.1,tilt:2}],
  [1,{reach:1,long:1.5,head:.12,mane:.16,tilt:3,smear:[-10,0]}],
  [8,{reach:1,long:1.5,head:.17,mane:.16,tilt:3,bob:-1}],
 ]},
 unpoint: {priority:2,fps:24,directional:true,keys:[
  [1,{reach:.6,long:.9,head:.08,tilt:-2,smear:[12,0],mane:.1}],
  [2,{reach:.1,long:.85,head:.04,tilt:-1}], [2,{reach:-.06,long:1,tilt:0}], [1,{}],
 ]},
 flinch: {priority:2,keys:[
  [2,{head:.22,tilt:4,sx:.92,sy:1.06,mane:-.12,bob:5,smear:[-10,0],arms:-.32}],
  [5,{head:.18,tilt:3.4,mane:-.1,bob:4,arms:-.22}],
  [1,{head:.09,tilt:1.5,bob:2,arms:-.08}],
 ]},
 land: {priority:3,fps:24,keys:[
  [2,{sy:.72,sx:1.22,bob:6,mane:-.22,arms:-.4},'land'],
  [2,{sy:.88,sx:1.08,bob:3,mane:-.1,arms:-.15}],
  [2,{sy:1.05,sx:.97,mane:.1,arms:.1}], [1,{}],
 ]},
 plop: {priority:3,fps:24,keys:[
  [2,{sy:.99,sx:1.02,mane:-.08,kickL:.08,kickR:.08,arms:-.44}],
  [2,{sy:1,sx:1,kickL:.04,kickR:.04,arms:-.4}], [1,{}],
 ]},
 fall: {loop:true,fps:24,keys:[
  [2,{sy:1.12,sx:.92,mane:.36,head:.05,smear:[0,-16],armL:.8,armR:.55}],
  [2,{sy:1.1,sx:.93,mane:.26,head:-.04,smear:[0,-12],armL:.55,armR:.82}],
 ]},
 // capri.js hurt(): one red drawing, then the flinch with glitch rising and fading.
 hurt: {priority:2,fps:12,keys:[
  [1,{head:.22,tilt:4,sx:.92,sy:1.06,mane:-.12,bob:5,smear:[-10,0],arms:-.32,sil:[1,.13,.32],silAmount:1},'impact'],
  [1,{head:.22,tilt:4,sx:.92,sy:1.06,mane:-.12,bob:5,arms:-.32,glitch:.7,split:7}],
  [5,{head:.18,tilt:3.4,mane:-.1,bob:4,arms:-.22,glitch:.3,split:2}],
  [1,{head:.09,tilt:1.5,bob:2,arms:-.08,glitch:.1}],
 ]},
 // capri.js vanish/arrive, held at the reference 24fps beats, within our native corner.
 teleport: {priority:3,fps:24,keys:[
  [2,{glitch:.35,split:3},'vanish'],
  [4,{collapse:1,glitch:1,dissolve:.5,split:9}],
  [2,{alpha:0,collapse:1,dissolve:.5}],
  [1,{collapse:1,glitch:.6,split:6},'arrive'],
  [4,{collapse:.2,glitch:.6,split:6}],
  [1,{sil:[.21,1,.48],silAmount:1}], [1,{sil:[.08,.06,.11],silAmount:1}],
  [5,{glitch:.2,split:2}], [1,{}],
 ]},
 wake: {priority:1,fps:12,keys:[
  [1,{head:.06,mane:-.08,bob:0,smear:[0,8],arms:-.18}],
  [4,{head:.08,mane:-.1,bob:1,arms:-.26}], [1,{}],
 ]},
} satisfies Record<string, Act>;
export type ActName = keyof typeof ACTS;
export function cadence(base: ActName, overlay?: ActName): number {
 if ((overlay && (ACTS[overlay] as Act).fps === 24) || base === 'fall') return 24;
 return base === 'sleep' ? 6 : 12;
}
export function resolvePose(pose: Drawing, dir = 1, facing = 1, directional = true): Drawing {
 const out = {...pose};
 const lean = directional && dir ? dir * facing : 0;
 if (lean) {
  if (pose.head !== undefined) out.head = pose.head * lean;
  if (pose.tilt !== undefined) out.tilt = pose.tilt * dir;
  if (pose.smear) out.smear = [pose.smear[0]*lean,pose.smear[1]];
  if (pose.echo) out.echo = [pose.echo[0]*lean,pose.echo[1]];
 }
 if (pose.arms !== undefined) out.armL = out.armR = pose.arms;
 if (pose.reach !== undefined) out[lean < 0 ? 'armL':'armR'] = pose.reach;
 if (pose.long !== undefined) out[lean < 0 ? 'longL':'longR'] = pose.long;
 delete out.arms; delete out.reach; delete out.long;
 return out;
}
/** Reference Player sampling plus a cursor so dropped browser frames never lose cues. */
export class RigPlayer {
 readonly act: Act;
 readonly total: number;
 private cuedFrame = -1;
 readonly name: ActName;
 readonly start: number;
 readonly dir: number;
 constructor(name: ActName, start = performance.now(), dir = 1) {
  this.name=name;this.start=start;this.dir=dir;
  this.act = ACTS[name]; this.total = this.act.keys.reduce((n,[hold])=>n+hold,0);
 }
 frame(now: number) { return Math.max(0, Math.floor((now-this.start)*(this.act.fps ?? 12)/1000)); }
 sample(now: number) {
  let f = this.frame(now);
  if (f >= this.total && !this.act.loop) return null;
  f %= this.total;
  for (let index=0;index<this.act.keys.length;index++) {
   const [hold,pose,cue] = this.act.keys[index]!;
   if (f < hold) return {pose,index,cue};
   f -= hold;
  }
  return null;
 }
 advance(now: number) {
  const f = this.frame(now), cues: string[] = [];
  // At most the latest cycle on resume: never replay minutes of hidden effects.
  const first = Math.max(this.cuedFrame+1,this.act.loop ? f-this.total+1 : 0);
  for (let cycle=Math.floor(first/this.total);cycle<=Math.floor(f/this.total);cycle++) {
   if (cycle && !this.act.loop) break;
   let offset = cycle*this.total;
   for (const [hold,,cue] of this.act.keys) {
    if (cue && offset>=first && offset<=f) cues.push(cue);
    offset += hold;
   }
  }
  this.cuedFrame = f;
  const drawing = this.sample(now);
  return {pose:drawing ? resolvePose(drawing.pose,this.dir,1,this.act.directional):null,cues};
 }
 consume(now: number) { this.cuedFrame = this.frame(now); }
}
