// Held pointing choreography adapted from capri-desktop (MIT): https://github.com/mochiiwuff/capri-desktop
// Uses our existing GLB rig, not the reference's artwork or sprite renderer.
import * as THREE from "three";

export type Pose = Record<string, [number, number, number]>;
const tau = Math.PI * 2, sin = Math.sin;
const ease = (x: number) => { const u = Math.max(0, Math.min(1, x)); return u * u * (3 - 2 * u); };
const envelope = (t: number, a: number, b: number, rise = 0.25, fall = 0.25) => t <= a || t >= b ? 0 : ease((t - a) / rise) * ease((b - t) / fall);
const rest: Pose = { "Raiz.position": [0,0,0], "Raiz.scale": [1,1,1], Raiz:[0,0,0], Brazo_izquierdo:[0,0,40], Brazo_derecho:[0,0,-11], Antebrazo_izquierdo:[0,0,0], Antebrazo_derecho:[0,0,0], Mano_izquierda:[0,0,0], Mano_derecha:[0,0,0], Cabeza:[0,0,0], Muslo_izquierdo:[0,0,0], Muslo_derecho:[0,0,0], Pierna_izquierda:[0,0,0], Pierna_derecha:[0,0,0] };
function blend(a: Pose, b: Pose, weight: number): Pose {
 const pose: Pose = {};
 for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
  const from = a[key] ?? rest[key] ?? [0,0,0], to = b[key] ?? rest[key] ?? [0,0,0];
  pose[key] = from.map((v,i) => v + (to[i]! - v) * weight) as [number,number,number];
 }
 return pose;
}
function seated(t: number): Pose {
 const w = tau * t / 6, knee = 2.5 * sin(w), foot = Math.max(0,sin(4*w)) * (sin(w)>0?1:0);
 return { Raiz:[0,0,1.2*sin(w)], "Raiz.position":[0,-0.36+0.008*sin(2*w),0], Muslo_izquierdo:[-70,0,-18-knee], Pierna_izquierda:[70,0,18+knee], Muslo_derecho:[-70,0,18-knee], Pierna_derecha:[70-14*foot,0,-18+knee], Brazo_izquierdo:[-18,0,12-knee], Antebrazo_izquierdo:[0,0,28], Brazo_derecho:[-18,0,8-knee], Antebrazo_derecho:[0,0,-28], Cabeza:[3*sin(w),12*sin(w/2),6*sin(w+1)] };
}
function hanging(t: number): Pose {
 const w = tau*t/3.2, angle=9*sin(w), r=angle*Math.PI/180, wave=envelope(t%6.4,3.4,5);
 return { Raiz:[0,0,180+angle], "Raiz.position":[-0.68*sin(r),3.75-0.68+0.68*Math.cos(r),0], Muslo_izquierdo:[0,0,-3], Muslo_derecho:[0,0,3], Pierna_izquierda:[90,0,0], Pierna_derecha:[90,0,0], Brazo_izquierdo:[0,0,-40-14*sin(w-0.6)], Brazo_derecho:[0,0,62-14*sin(w-0.6)+70*wave], Antebrazo_izquierdo:[0,0,-15*sin(w-1.2)], Antebrazo_derecho:[0,0,15*sin(w-1.2)+35*wave*sin(tau*t*1.6)], Cabeza:[0,0,-8*sin(w-0.4)] };
}
function flying(t: number): Pose {
 const w=tau*t/1.1;
 return { "Raiz.position":[0,0.35+0.06*sin(w),0], Raiz:[-6,0,3*sin(w)], Brazo_izquierdo:[0,0,-30+8*sin(w)], Brazo_derecho:[0,0,52-8*sin(w)], Antebrazo_izquierdo:[0,0,-20], Antebrazo_derecho:[0,0,20], Muslo_izquierdo:[8*sin(w),0,2], Muslo_derecho:[-8*sin(w),0,-2], Pierna_izquierda:[25+10*sin(w+1),0,0], Pierna_derecha:[25-10*sin(w+1),0,0], Cabeza:[-10,0,0] };
}
export function pointingClip(targetX: number | undefined, originX: number): "pointingLeft" | "pointingRight" {
 return targetX !== undefined && targetX >= originX ? "pointingRight" : "pointingLeft";
}
function pointing(t: number, side: -1 | 1): Pose {
 const sway=sin(tau*t/4);
 // The mane is skinned to Cabeza in our rig: head yaw/lean carries it with the gaze.
 // Hold an extended arm, never a one-shot greeting that falls back during a long question.
 return { Raiz:[0,0,side*(2+0.5*sway)], "Raiz.position":[0,0.012*sway,0],
  Cabeza:[-4,side*(14+sway),side*4],
  ...(side<0 ? {Brazo_izquierdo:[0,0,-86+sway],Antebrazo_izquierdo:[0,0,-5],Mano_izquierda:[0,0,-4]} :
   {Brazo_derecho:[0,0,86+sway],Antebrazo_derecho:[0,0,5],Mano_derecha:[0,0,4]}) };
}
interface Clip { duration: number; loop?: boolean; pose(t: number): Pose }
export const clips = {
 pointingLeft:{duration:4,loop:true,pose:(t:number)=>pointing(t,-1)},
 pointingRight:{duration:4,loop:true,pose:(t:number)=>pointing(t,1)},
 quieta: { duration:6, loop:true, pose:(t:number):Pose => { const w=tau*t/6; return {"Raiz.position":[0,0.035*sin(w),0],Raiz:[1.5*sin(w),0,1.8*sin(w/2)],Cabeza:[2*sin(w),4*sin(w/2),1.5*sin(w+1)],Brazo_izquierdo:[0,0,40+2*sin(w)],Brazo_derecho:[0,0,-11-2*sin(w)]}; } },
 caminar: {duration:1.6,loop:true,pose:(t:number):Pose=>{const w=tau*t/1.6;return {"Raiz.position":[0,0.05+0.05*sin(2*w),0],Raiz:[9,0,2*sin(w)],Brazo_izquierdo:[0,0,58+6*sin(w)],Brazo_derecho:[0,0,-33-6*sin(w)],Antebrazo_izquierdo:[0,0,-8*sin(w-0.8)],Antebrazo_derecho:[0,0,8*sin(w-0.8)],Muslo_izquierdo:[22*sin(w),0,0],Muslo_derecho:[-22*sin(w),0,0],Pierna_izquierda:[26*Math.max(0,-sin(w)),0,0],Pierna_derecha:[26*Math.max(0,sin(w)),0,0],Cabeza:[-4,0,3*sin(w-1)]};}},
 volar:{duration:1.1,loop:true,pose:flying}, sentarse:{duration:1,pose:(t:number)=>blend(rest,seated(0),ease(t))}, sentada:{duration:12,loop:true,pose:seated}, pararse:{duration:0.9,pose:(t:number)=>blend(seated(0),rest,ease(t/0.9))},
 colgarse:{duration:0.9,pose:(t:number)=>blend(flying(t),hanging(0),ease(t/0.75))}, colgada:{duration:6.4,loop:true,pose:hanging},
 colgando:{duration:1.2,loop:true,pose:(t:number):Pose=>{const w=tau*t/1.2;return {Raiz:[0,0,6*sin(w)],Brazo_izquierdo:[0,0,-75+22*sin(2*w)],Brazo_derecho:[0,0,82+22*sin(2*w+Math.PI)],Antebrazo_izquierdo:[0,0,-25*sin(2*w+0.7)],Antebrazo_derecho:[0,0,25*sin(2*w+0.7)],Cabeza:[-8,0,9*sin(w+1)]};}},
 sorpresa:{duration:1.3,pose:(t:number):Pose=>{const e=envelope(t,0,1.3,0.12,0.55),j=t<0.45?Math.max(0,sin(Math.PI*t/0.45)):0;return {"Raiz.position":[0,0.28*j,0],"Raiz.scale":[1-0.05*j,1+0.08*j,1-0.05*j],Raiz:[-6*e,0,0],Brazo_izquierdo:[0,0,40-80*e],Brazo_derecho:[0,0,-11+90*e],Antebrazo_izquierdo:[0,0,-30*e],Antebrazo_derecho:[0,0,30*e],Cabeza:[-12*e,0,4*e]};}},
 dormir:{duration:4,loop:true,pose:(t:number):Pose=>{const b=sin(tau*t/4);return {"Raiz.position":[0,-0.22+0.03*b,0],Raiz:[8,0,5],Brazo_izquierdo:[0,0,62],Brazo_derecho:[0,0,-37],Antebrazo_izquierdo:[0,0,10],Antebrazo_derecho:[0,0,-10],Cabeza:[16+3*b,0,-14]};}},
 aburrida:{duration:4.6,pose:(t:number):Pose=>{const look=14*envelope(t,0.1,1.1)-14*envelope(t,1,2),yawn=envelope(t,2.1,3.4,0.35,0.35),sigh=envelope(t,3.4,4.6,0.3,0.6);return {"Raiz.position":[0,0.05*yawn-0.1*sigh,0],Raiz:[6*sigh,0,0],Brazo_izquierdo:[0,0,40-70*yawn+14*sigh],Brazo_derecho:[0,0,-11+75*yawn-14*sigh],Cabeza:[-16*yawn+10*sigh,0,look]};}},
 estirarse:{duration:3.2,pose:(t:number):Pose=>{const e=envelope(t,0,3.2,0.7,0.8);return {"Raiz.position":[0,0.12*e,0],Brazo_izquierdo:[0,0,40-165*e],Brazo_derecho:[0,0,-11+155*e],Antebrazo_izquierdo:[0,0,-25*e],Antebrazo_derecho:[0,0,25*e],Cabeza:[-15*e,0,6*e],Raiz:[-6*e,0,0]};}},
 saludar:{duration:3,pose:(t:number):Pose=>{const e=envelope(t,0,3,0.35,0.5);return {Brazo_derecho:[0,0,-11+120*e],Antebrazo_derecho:[0,0,35*e*sin(t*9)],Cabeza:[0,0,-6*e]};}},
 celebrar:{duration:2.4,pose:(t:number):Pose=>{const e=envelope(t,0,2.4);return {"Raiz.position":[0,0.18*Math.abs(sin(t*8))*e,0],Brazo_izquierdo:[0,0,40-140*e],Brazo_derecho:[0,0,-11+140*e],Pierna_izquierda:[25*e*Math.abs(sin(t*8)),0,0],Pierna_derecha:[25*e*Math.abs(sin(t*8)),0,0],Cabeza:[-10*e,0,6*sin(t*4)*e]};}},
 pensar:{duration:4,loop:true,pose:(t:number):Pose=>({Cabeza:[5,12,6+2*sin(t*2)],Brazo_derecho:[-30,0,45],Antebrazo_derecho:[-70,0,65],"Raiz.position":[0,0.025*sin(tau*t/4),0]})},
 reparar:{duration:2.4,loop:true,pose:(t:number):Pose=>({Cabeza:[14,0,4*sin(t*4)],Brazo_izquierdo:[-25,0,10],Antebrazo_izquierdo:[0,0,40+12*sin(t*8)],Brazo_derecho:[-25,0,15],Antebrazo_derecho:[0,0,-40-12*sin(t*8)]})},
 hablar:{duration:3,loop:true,pose:(t:number):Pose=>({Cabeza:[3*sin(t*5),3*sin(t*2),2*sin(t*3)],Brazo_derecho:[0,0,10+12*sin(t*4)],Antebrazo_derecho:[0,0,-15-8*sin(t*4)],"Raiz.position":[0,0.025*sin(tau*t/3),0]})},
 bailar:{duration:2.4,loop:true,pose:(t:number):Pose=>{const w=tau*t/2.4;return {Raiz:[0,8*sin(w),8*sin(w)],"Raiz.position":[0.12*sin(w),0.035*Math.abs(sin(2*w)),0],Brazo_izquierdo:[0,0,-35+20*sin(w)],Brazo_derecho:[0,0,55+20*sin(w)],Muslo_izquierdo:[0,0,-8*sin(w)],Muslo_derecho:[0,0,-8*sin(w)],Pierna_izquierda:[15+12*sin(w),0,0],Pierna_derecha:[15-12*sin(w),0,0]};}},
 salto:{duration:1.3,pose:(t:number):Pose=>{const crouch=envelope(t,0,0.4,0.15,0.15)+envelope(t,0.95,1.3,0.08,0.25),air=t>0.32&&t<0.98?sin(Math.PI*(t-0.32)/0.66):0;return {"Raiz.position":[0,air-0.2*crouch,0],Raiz:[-5*air,0,0],Muslo_izquierdo:[-40*crouch-70*air,0,-10*air],Muslo_derecho:[-40*crouch-70*air,0,10*air],Pierna_izquierda:[80*crouch+120*air,0,0],Pierna_derecha:[80*crouch+120*air,0,0],Brazo_izquierdo:[0,0,40-95*air+10*crouch],Brazo_derecho:[0,0,-11+110*air-10*crouch],Cabeza:[-12*air,0,0]};}},
 voltereta:{duration:1.6,pose:(t:number):Pose=>{const u=ease((t-0.35)/0.8),angle=tau*u,air=t>0.35&&t<1.15?sin(Math.PI*(t-0.35)/0.8):0,stretch=sin(Math.PI*Math.min(1,Math.max(0,(t-0.3)/0.9)));return {Raiz:[0,0,360*u],"Raiz.position":[1.3*sin(angle),1.3*(1-Math.cos(angle))+1.1*air,0],Muslo_izquierdo:[0,0,-32*stretch],Muslo_derecho:[0,0,32*stretch],Brazo_izquierdo:[0,0,40-85*stretch],Brazo_derecho:[0,0,-11+95*stretch]};}},
 triste:{duration:4,loop:true,pose:(t:number):Pose=>({Cabeza:[20,0,-8],Raiz:[8,0,0],"Raiz.position":[0,-0.06+0.015*sin(t),0],Brazo_izquierdo:[0,0,55],Brazo_derecho:[0,0,-25]})},
} satisfies Record<string,Clip>;
export type ProceduralClip = keyof typeof clips;
export function samplePose(name: ProceduralClip, seconds: number): Pose {
 const clip: Clip = clips[name], time=Math.max(0,Number.isFinite(seconds)?seconds:0);
 return { ...rest, ...clip.pose(clip.loop ? time%clip.duration : Math.min(time,clip.duration)) };
}
/** Capture once at a transition; slerp rotations, lerp position/scale over the reference's 300ms blend. */
export function createPosePlayer(scene: THREE.Object3D) {
 const tracks=Object.keys(rest).flatMap(key=>{ const [name,property="rotation"]=key.split("."); const object=scene.getObjectByName(name!); return object?[{key,object,property,base:property==="rotation"?object.quaternion.clone():property==="scale"?object.scale.clone():object.position.clone(),from:property==="rotation"?object.quaternion.clone():property==="scale"?object.scale.clone():object.position.clone()}]:[]; });
 let name:ProceduralClip="quieta",elapsed=0,transition=1;
 return {
  play(next:ProceduralClip) { name=next;elapsed=0;transition=0; for(const track of tracks) {
   if (track.property === "rotation") (track.from as THREE.Quaternion).copy(track.object.quaternion);
   else (track.from as THREE.Vector3).copy(track.property === "scale" ? track.object.scale : track.object.position);
  } },
  update(delta:number) {
   elapsed+=delta;transition=Math.min(1,transition+delta/0.3);const pose=samplePose(name,elapsed);
   for(const track of tracks) {
    const value=pose[track.key]!;
    if(track.property==="rotation") { const target=new THREE.Quaternion().setFromEuler(new THREE.Euler(...value.map(x=>x*Math.PI/180) as [number,number,number])); track.object.quaternion.copy(track.from as THREE.Quaternion).slerp(target,ease(transition)); }
    else { const target=new THREE.Vector3(...value); if(track.property==="position") target.add(track.base as THREE.Vector3); else target.multiply(track.base as THREE.Vector3); (track.property==="scale"?track.object.scale:track.object.position).copy(track.from as THREE.Vector3).lerp(target,ease(transition)); }
   }
  },
 };
}
