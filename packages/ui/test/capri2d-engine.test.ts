import { expect, it, vi } from "vitest";
import { UNIFORMS } from "../src/capri2d/shaders.ts";
import { alphaInputRectangles, alphaMask, createEngine, frameAt, samplePose, sampleSheet, STAND } from "../src/capri2d/engine.ts";
it("projects alpha bottom-up into the native 24x34 grid, ignoring transparent pixels", () => {
 const pixels = new Uint8Array(144*204*4);
 expect(alphaMask(pixels,144,204).every(cell => cell === 0)).toBe(true);
 pixels[3] = 255; pixels[((203*144+143)*4)+3]=255;
 const mask = alphaMask(pixels,144,204);
 expect(mask).toHaveLength(816); expect(mask[33*24]).toBe(1); expect(mask[23]).toBe(1);
 expect(mask.reduce((a,b)=>a+b,0)).toBe(2);
});
it("shapes input to individual visible pixels, not the coarse grid cell", () => {
 const pixels=new Uint8Array(144*204*4);
 pixels[3]=255; pixels[7]=255; pixels[(143*4)+3]=255;
 expect(alphaInputRectangles(pixels,144,204)).toEqual([[0,203,2,1],[143,203,1,1]]);
 expect(alphaInputRectangles(new Uint8Array(144*204*4),144,204)).toEqual([]);
});
it("maps elapsed milliseconds to drawings on twos", () => {
 expect(frameAt(0)).toBe(0); expect(frameAt(83)).toBe(0);
 expect(frameAt(84)).toBe(1); expect(frameAt(1000)).toBe(12);
 expect(frameAt(-10)).toBe(0);
});
it("selects exact held-key boundaries and wraps the four drawing stand", () => {
 expect(sampleSheet(STAND, 0).pose.hair).toBe(-2.5);
 expect(sampleSheet(STAND, 5).index).toBe(0);
 expect(sampleSheet(STAND, 6).index).toBe(1);
 expect(sampleSheet(STAND, 10).index).toBe(2);
 expect(sampleSheet(STAND, 16).index).toBe(3);
 expect(sampleSheet(STAND, 20).index).toBe(0);
});
it("overlays only supplied act fields on the base stance and releases on completion", () => {
 const act = { keys: [{ hold: 2, pose: { head: 0.2 } }] };
 expect(samplePose(STAND, 10, act, 0)).toEqual({ bob: -4, hair: 2.5, arms: -0.05, head: 0.2 });
 expect(samplePose(STAND, 10, act, 2)).toEqual(sampleSheet(STAND, 10).pose);
});
it("clamps one-shot sheets and preserves cues", () => {
 const sheet = { keys: [{ hold: 2, pose: {}, cue: "ready" }, { hold: 1, pose: { head: 0.2 }, cue: "peak" }] };
 expect(sampleSheet(sheet, 1).cue).toBe("ready");
 expect(sampleSheet(sheet, 2).cue).toBe("peak");
 expect(sampleSheet(sheet, 99).index).toBe(1);
 expect(() => sampleSheet({ keys: [] }, 0)).toThrow();
});
it("binds the entire reference shader rig including smear, echo, grading and body-space mask transforms", () => {
 const calls: Record<string,ReturnType<typeof vi.fn>>={};
 const gl=new Proxy({}, {get(_target,key:string){
  if(key.toUpperCase()===key)return 1;
  if(!calls[key])calls[key]=vi.fn((...args:unknown[])=>{
   if(key==='getUniformLocation')return args[1];
   if(key==='getShaderParameter'||key==='getProgramParameter')return true;
   if(key==='getAttribLocation')return 0;
   if(key.startsWith('create'))return {};
   return undefined;
  });
  return calls[key];
 }}) as WebGLRenderingContext;
 const canvas={getContext:()=>gl,width:0,height:0} as unknown as HTMLCanvasElement;
 const engine=createEngine(canvas,{} as HTMLImageElement);
 engine.draw({armL:.5,armR:1.2,longR:2.3,smear:[-18,0],echo:[14,0],sx:.94,sy:1.1,tilt:8,bob:-16},7);
 const bound=new Set(['uniform1i','uniform1f','uniform2f','uniform3f','uniform4f'].flatMap(method=>calls[method]!.mock.calls.map(args=>args[0])));
 expect([...bound].sort()).toEqual([...UNIFORMS].sort());
 expect(calls.uniform1f).toHaveBeenCalledWith('uLongR',2.3);
 expect(calls.uniform2f).toHaveBeenCalledWith('uSmear',-18,0);
 expect(calls.uniform2f).toHaveBeenCalledWith('uEcho',14,0);
 expect(calls.uniform4f).toHaveBeenCalledWith('uBody',-16,8*Math.PI/180,.94,1.1);
 expect(calls.readPixels).toHaveBeenCalledOnce();
 expect(canvas).toMatchObject({width:144,height:204});
 engine.draw({mask:1,alpha:0},120);
 expect(calls.uniform1f).toHaveBeenCalledWith('uMask',1);
 engine.dispose();expect(calls.deleteTexture).toHaveBeenCalledOnce();expect(calls.deleteShader).toHaveBeenCalledTimes(2);
});
