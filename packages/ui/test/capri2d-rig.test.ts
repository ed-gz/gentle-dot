import { expect, it } from "vitest";
import { ACTS, RigPlayer, cadence, resolvePose } from "../src/capri2d/acting.ts";
import { RigDirector } from "../src/capri2d/director.ts";

it("keeps the reference victory exposure counts and cues at 24fps", () => {
 const player = new RigPlayer("victory", 0);
 expect(cadence("stand", "victory")).toBe(24);
 expect(player.sample(124)!.pose.sy).toBe(.9);
 expect(player.advance(125).cues).toEqual(["gather"]);
 expect(player.advance(292).cues).toEqual(["launch", "peak"]);
 expect(player.advance(292).cues).toEqual([]);
 expect(player.sample(10000)).toBeNull();
});
it("plays stand on twos, asleep at six, and fall on ones", () => {
 expect(cadence("stand")).toBe(12);
 expect(cadence("sleep")).toBe(6);
 expect(cadence("fall")).toBe(24);
 const p = new RigPlayer("stand", 0);
 expect(p.sample(499)!.pose.hair).toBe(-2.5);
 expect(p.sample(500)!.pose.hair).toBe(0);
 expect(p.sample(1667)!.pose.hair).toBe(-2.5);
});
it("resolves mirrored reach and overlays only supplied fields", () => {
 const base = resolvePose({bob:-4,hair:2.5,arms:-.05},1,1);
 const point = resolvePose({reach:1,long:1.5,head:.17},-1,1);
 expect({...base,...point}).toMatchObject({bob:-4,hair:2.5,armL:1,armR:-.05,longL:1.5,head:-.17});
 expect(ACTS.pointing.loop).toBe(true);
});
it("dispatches crossed cues once, including the first drawing and loop boundaries", () => {
 const player = new RigPlayer("point", 0);
 expect(player.advance(0).cues).toEqual(["spot"]);
 expect(player.advance(450).cues).toEqual(["coil", "lock"]);
 expect(player.advance(450).cues).toEqual([]);
});
it("keeps the reference overlay over its running stance, then releases it", () => {
 const rig=new RigDirector();
 rig.update({outcome:{kind:'done',at:1}},0);
 expect(rig.sample(300).pose).toMatchObject({bob:-30,armL:1.45,armR:1.45,mane:.85,echo:[20,-4]});
 expect(rig.sample(10000).act).toBe('stand');
 expect(rig.sample(10000).pose.longL).toBe(1);
});
it("sustains pointing until withdrawal and retracts instead of replaying the jab", () => {
 const rig=new RigDirector();rig.update({question:'q',direction:-1},0);
 expect(rig.sample(5000).act).toBe('pointing');
 expect(rig.sample(5000).pose.armL).toBe(1);
 rig.update({},5100);
 expect(rig.sample(5100).act).toBe('unpoint');
 expect(rig.sample(6000).act).toBe('stand');
});
it("consumes hidden episodes and emits no reduced-motion cues or smears", () => {
 const rig=new RigDirector(),intent={outcome:{kind:'done' as const,at:1}};
 rig.update(intent,0,true);rig.update(intent,500);
 expect(rig.sample(500).act).toBe('stand');
 expect(rig.sample(500).cues).toEqual([]);
 rig.update({question:'q'},600);
 const still=rig.sample(1200,true);
 expect(still.cues).toEqual([]);
 expect(still.pose.smear).toEqual([0,0]);expect(still.pose.echo).toEqual([0,0]);
});
it("sits with clamped ledge bob, falls on ones, lands and wakes purposefully", () => {
 const rig=new RigDirector();rig.update({resting:'sit'},0);
 expect(rig.sample(0).pose.sit).toBe(1);
 expect(rig.sample(0).pose.bob).toBeLessThanOrEqual(2);
 rig.update({falling:true},1000);expect(rig.fps()).toBe(24);
 rig.update({},1100);expect(rig.sample(1100).act).toBe('land');
 rig.update({resting:'sleep'},3000);expect(rig.fps()).toBe(6);
 rig.update({},4000);expect(rig.sample(4000).act).toBe('wake');
});
