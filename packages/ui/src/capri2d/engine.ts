// Ported from https://github.com/mochiiwuff/capri-desktop (MIT).
// Artwork is loaded only from the user's personal local asset directory.
import { FRAG, VERT, UNIFORMS } from "./shaders.ts";
import { NEUTRAL, resolvePose, type Drawing } from "./acting.ts";
export const SHEET_FPS = 12;
export type Pose = Drawing;
export interface Sheet { loop?: boolean; keys: { hold: number; pose: Pose; cue?: string }[] }
export const STAND: Sheet = {loop:true,keys:[
 {hold:6,pose:{bob:0,hair:-2.5,arms:.04}}, {hold:4,pose:{bob:-2,hair:0,arms:0}},
 {hold:6,pose:{bob:-4,hair:2.5,arms:-.05}}, {hold:4,pose:{bob:-2,hair:0,arms:0}},
]};
export function frameAt(ms: number, fps = SHEET_FPS) { return Math.floor(Math.max(0,ms)*fps/1000); }
export function sampleSheet(sheet: Sheet, frame: number) {
 const total = sheet.keys.reduce((sum,key)=>sum+key.hold,0);
 if (!total || sheet.keys.some(key=>!Number.isInteger(key.hold)||key.hold<=0)) throw new Error('Invalid exposure sheet');
 let remaining = sheet.loop ? Math.max(0,Math.floor(frame))%total : Math.min(total-1,Math.max(0,Math.floor(frame)));
 for (let index=0;index<sheet.keys.length;index++) {
  const key = sheet.keys[index]!;
  if (remaining<key.hold) return {...key,index};
  remaining-=key.hold;
 }
 throw new Error('Invalid exposure frame');
}
export function samplePose(base: Sheet, frame: number, act?: Sheet, actFrame=0): Pose {
 const pose=sampleSheet(base,frame).pose;
 if (!act || (!act.loop && actFrame>=act.keys.reduce((sum,key)=>sum+key.hold,0))) return pose;
 return {...pose,...sampleSheet(act,actFrame).pose};
}
export const DEFAULT_RIG = {
 ...NEUTRAL,mask:0,seed:0,boil:.9,sit:0,glitch:0,glitchSeed:0,split:0,collapse:0,dissolve:0,
 sparkle:1,grade:1,sil:[.08,.06,.11] as [number,number,number],silAmount:0,
 misreg:[-2.6,2.2] as [number,number],alpha:1,
};
/** SpriteRenderer GPU setup/draw, with explicit resource ownership and native mask readback. */
export function createEngine(canvas: HTMLCanvasElement, image: HTMLImageElement) {
 const gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:true});
 if (!gl) throw new Error('WebGL unavailable');
 const program=gl.createProgram()!;
 const shaders: WebGLShader[]=[];
 const buffer=gl.createBuffer(), texture=gl.createTexture();
 const dispose=()=>{gl.deleteTexture(texture);gl.deleteBuffer(buffer);gl.deleteProgram(program);shaders.forEach(s=>gl.deleteShader(s));};
 const u: Record<string,WebGLUniformLocation|null>={};
 try {
  for (const [type,source] of [[gl.VERTEX_SHADER,VERT],[gl.FRAGMENT_SHADER,FRAG]] as const) {
   const shader=gl.createShader(type)!;shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);
   if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)??'Shader failed');
   gl.attachShader(program,shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program)??'Shader link failed');
  gl.useProgram(program);
  for (const name of UNIFORMS) u[name]=gl.getUniformLocation(program,name);
  gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
  const loc=gl.getAttribLocation(program,'aPos');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,0);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
  for (const p of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D,p,gl.LINEAR);
  for (const p of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D,p,gl.CLAMP_TO_EDGE);
  gl.uniform1i(u.uTex!,0);gl.uniform2f(u.uSize!,240,420);gl.uniform1f(u.uPad!,56);gl.uniform2f(u.uView!,352,532);
  gl.uniform3f(u.uRim!,.48,.24,1);gl.uniform1f(u.uPx!,532/204);
 } catch(error) {dispose();throw error;}
 canvas.width=144;canvas.height=204;gl.viewport(0,0,144,204);
 const pixels=new Uint8Array(144*204*4);
 return {
  draw(pose: Pose, frame: number) {
   const s={...DEFAULT_RIG,...resolvePose(pose,0),seed:frame,glitchSeed:frame};
   gl.useProgram(program);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
   const scalars=['mask','seed','boil','hair','head','mane','armL','armR','longL','longR','sit','kickL','kickR','glitch','glitchSeed','split','collapse','dissolve','sparkle','grade','alpha'] as const;
   for (const name of scalars) gl.uniform1f(u[`u${name[0]!.toUpperCase()}${name.slice(1)}`]!,s[name]);
   gl.uniform2f(u.uSmear!,...s.smear);gl.uniform2f(u.uEcho!,...s.echo);gl.uniform2f(u.uMisreg!,...s.misreg);
   gl.uniform4f(u.uSil!,...s.sil,s.silAmount);
   gl.uniform4f(u.uBody!,s.bob,s.tilt*Math.PI/180,s.sx,s.sy);
   gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
   gl.readPixels(0,0,144,204,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
   return alphaMask(pixels,144,204);
  },dispose,
 };
}
/** Bottom-up WebGL alpha -> existing top-down 24x34 native silhouette. */
export function alphaMask(pixels: Uint8Array,width: number,height: number): number[] {
 const mask=Array<number>(816).fill(0);
 for(let y=0;y<height;y++) for(let x=0;x<width;x++) if(pixels[(y*width+x)*4+3]!>24) mask[Math.floor((height-1-y)*34/height)*24+Math.floor(x*24/width)]=1;
 return mask;
}
