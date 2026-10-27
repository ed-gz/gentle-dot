import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { injectLegs } from "../src/capri3d/rig.ts";
import { clips, samplePose, createPosePlayer, pointingClip } from "../src/capri3d/procedural.ts";
import { FrameScheduler } from "../src/capri3d/scheduler.ts";
import { speechDuration, RestProgression, restChoice, responseChoice } from "../src/capri3d/choreography.ts";
import { clipForBehavior } from "../src/capri3d/mapping.ts";
import { capriBehavior } from "@gentle-dot/theme-capri/behavior";
import { gestureChoice } from "../src/capri3d/gestures.ts";

describe("reference-compatible procedural rig", () => {
 it("holds the pointing arm on the target side through arbitrarily long waits, with head/mane follow and bounded sway",()=>{
  expect(pointingClip(-500,100)).toBe('pointingLeft');
  expect(pointingClip(500,100)).toBe('pointingRight');
  expect(pointingClip(undefined,100)).toBe('pointingLeft');
  for(const [name,arm,sign] of [['pointingLeft','Brazo_izquierdo',-1],['pointingRight','Brazo_derecho',1]] as const){
   expect(clips[name].loop).toBe(true);
   for(const t of [0,1,3,60,600]){
    const pose=samplePose(name,t);
    expect(pose[arm]![2]*sign).toBeGreaterThan(75);
    expect(Math.abs(pose.Cabeza![1])).toBeGreaterThan(8);
    expect(Object.values(pose).flat().every(Number.isFinite)).toBe(true);
   }
   expect(samplePose(name,0)).not.toEqual(samplePose(name,1));
   expect(samplePose(name,0)).toEqual(samplePose(name,clips[name].duration));
  }
 });
 it('releases the extended arm on return to rest using the existing blend',()=>{
  const scene=new THREE.Group(),arm=new THREE.Bone();arm.name='Brazo_derecho';scene.add(arm);
  const player=createPosePlayer(scene);player.play('pointingRight');player.update(1);
  expect(Math.abs(arm.rotation.z)).toBeGreaterThan(1);
  player.play('quieta');player.update(1);
  expect(Math.abs(arm.rotation.z)).toBeLessThan(.3);
 });
 it("adds thigh/shin joints, preserves bind pose and normalizes vertex weights, idempotently", () => {
  const root = new THREE.Group(), bone = new THREE.Bone(); bone.name = "Raiz"; root.add(bone);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-0.2,1.2,0, -0.2,0.68,0, -0.2,0.1,0, 0.4,1.2,0, 0.4,0.68,0, 0.4,0.1,0, 0,2,0],3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(28),4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(Array.from({length:28},(_,i)=>i%4===0?1:0),4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial()); root.add(mesh); root.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton([bone]));
  const before = mesh.getVertexPosition(2, new THREE.Vector3()).clone();
  expect(injectLegs(root)).toBe(true);
  expect(mesh.skeleton.bones.map(b=>b.name)).toEqual(["Raiz","Muslo_izquierdo","Pierna_izquierda","Muslo_derecho","Pierna_derecha"]);
  root.updateMatrixWorld(true); mesh.skeleton.update();
  expect(mesh.getVertexPosition(2,new THREE.Vector3()).distanceTo(before)).toBeLessThan(1e-5);
  expect(geometry.attributes.skinIndex!.getX(2)).toBe(2);
  for(let i=0;i<7;i++) expect([0,1,2,3].reduce((s,c)=>s+geometry.attributes.skinWeight!.getComponent(i,c),0)).toBeCloseTo(1);
  expect(injectLegs(root)).toBe(false);
 });
 it("ignores non-skinned and incomplete assets without poisoning them",()=>{ expect(injectLegs(new THREE.Group())).toBe(false); });
 it("samples every clip finitely and actually articulates knees",()=>{
  for(const name of Object.keys(clips) as (keyof typeof clips)[]) for(const time of [0,0.1,0.5,1,10,1000]) {
   const pose=samplePose(name,time); expect(Object.values(pose).flat().every(Number.isFinite)).toBe(true);
  }
  expect(samplePose("sentada",1).Muslo_izquierdo![0]).toBeLessThan(-60);
  expect(samplePose("caminar",0.2).Muslo_izquierdo).not.toEqual(samplePose("caminar",0.6).Muslo_izquierdo);
  expect(Object.keys(clips)).toEqual(expect.arrayContaining(["quieta","caminar","volar","sentarse","sentada","pararse","colgarse","colgada","saludar","celebrar","sorpresa","pensar","hablar","dormir","estirarse","aburrida","bailar","salto","voltereta"]));
 });
 it("blends from the visible pose and restores omitted tracks",()=>{
  const scene = new THREE.Group(), head = new THREE.Bone(); head.name="Cabeza"; scene.add(head);
  const player=createPosePlayer(scene); player.play("pensar"); player.update(1); const q=head.quaternion.clone();
  player.play("quieta"); player.update(0); expect(head.quaternion.angleTo(q)).toBeLessThan(1e-5);
  player.update(1); expect(Number.isFinite(head.quaternion.x)).toBe(true);
 });
});
it("caps active frames at 30fps, 24 on battery, and cancels hidden/reduced/captured work",()=>{
 vi.useFakeTimers(); const frame=vi.fn(); const scheduler=new FrameScheduler(frame);
 scheduler.set({visible:true}); vi.advanceTimersByTime(1000); expect(frame.mock.calls.length).toBeGreaterThanOrEqual(28); expect(frame.mock.calls.length).toBeLessThanOrEqual(30);
 frame.mockClear(); scheduler.set({visible:true,battery:true}); vi.advanceTimersByTime(1000); expect(frame.mock.calls.length).toBeGreaterThanOrEqual(23); expect(frame.mock.calls.length).toBeLessThanOrEqual(24);
 for(const state of [{visible:false},{visible:true,reduced:true},{visible:true,capture:true}]) { scheduler.set(state); frame.mockClear(); vi.advanceTimersByTime(1000); expect(frame).not.toHaveBeenCalled(); }
 scheduler.dispose(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
});
it("uses exactly the reference speech duration",()=>{ expect(speechDuration("hola")).toBe(2420); expect(speechDuration("x".repeat(1000))).toBe(9000); });
it("maps purposeful triggers to the richer library and preserves explicit GLB swaps",()=>{
 expect(clipForBehavior(capriBehavior({now:1,agentWorking:true,actionKind:"edit"}))).toMatchObject({procedural:"reparar"});
 expect(clipForBehavior(capriBehavior({now:1,agentWorking:true,actionKind:"thinking"}))).toMatchObject({procedural:"pensar"});
 expect(clipForBehavior(capriBehavior({now:1,outcome:{kind:"error",at:1}}))).toMatchObject({procedural:"sorpresa"});
 expect(responseChoice("reply").clip).toBe("Hablar");expect(responseChoice("done").clip).toBe("Reir");expect(responseChoice("attention").end).toBe(3);
 expect(restChoice("sit").procedural).toBe("sentada");expect(restChoice("sleep").model).toBe("roja_recostada_cerrados.glb");expect(restChoice("wake").model).toBe("roja_recostada_abiertos.glb");
 for(const [gesture,model] of [["guino","roja_guino.glb"],["brazos","roja_brazos.glb"],["transformarse","roja_transformacion.glb"]] as const) expect(gestureChoice(gesture).model).toBe(model);
});
it("uses deterministic idle checkpoints, never random wandering",()=>{
 vi.useFakeTimers();const rest=new RestProgression(vi.fn());rest.idle();
 vi.advanceTimersByTime(60000);expect(rest.pose).toBe("stretch");
 vi.advanceTimersByTime(3200);expect(rest.pose).toBe("float");
 vi.advanceTimersByTime(26800);expect(rest.pose).toBe("bored");
 vi.advanceTimersByTime(4600);expect(rest.pose).toBe("float");
 vi.advanceTimersByTime(25400);expect(rest.pose).toBe("sit");
 rest.dispose();vi.useRealTimers();
});

it("reduces resting work to 12fps and restores active cadence without catch-up",()=>{
 vi.useFakeTimers();let resting=true;const frame=vi.fn();
 const scheduler=new FrameScheduler(frame,()=>resting);
 scheduler.set({visible:true});vi.advanceTimersByTime(1000);
 expect(frame.mock.calls.length).toBeGreaterThanOrEqual(10);expect(frame.mock.calls.length).toBeLessThanOrEqual(12);
 resting=false;frame.mockClear();vi.advanceTimersByTime(1000);
 expect(frame.mock.calls.length).toBeGreaterThanOrEqual(27);expect(frame.mock.calls.length).toBeLessThanOrEqual(30);
 expect(frame.mock.calls.every(([delta])=>delta>0 && delta<=0.1)).toBe(true);
 resting=true;scheduler.set({visible:true,battery:true});frame.mockClear();vi.advanceTimersByTime(1000);
 expect(frame.mock.calls.length).toBe(11);
 scheduler.set({visible:false});frame.mockClear();vi.advanceTimersByTime(1000);expect(frame).not.toHaveBeenCalled();
 scheduler.dispose();expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();
});
