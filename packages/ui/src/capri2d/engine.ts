// Ported choreography/engine from https://github.com/mochiiwuff/capri-desktop (MIT); artwork not included — personal-use assets loaded locally.
export const SHEET_FPS = 12;
export interface Pose { bob?: number; hair?: number; head?: number; mane?: number; arms?: number; kickL?: number; kickR?: number; sit?: number; glitch?: number; split?: number }
export interface Sheet { loop?: boolean; keys: { hold: number; pose: Pose; cue?: string }[] }
export const STAND: Sheet = { loop: true, keys: [
 { hold: 6, pose: { bob: 0, hair: -2.5, arms: 0.04 } },
 { hold: 4, pose: { bob: -2, hair: 0, arms: 0 } },
 { hold: 6, pose: { bob: -4, hair: 2.5, arms: -0.05 } },
 { hold: 4, pose: { bob: -2, hair: 0, arms: 0 } },
] };
export function frameAt(ms: number, fps = SHEET_FPS): number { return Math.floor(Math.max(0, ms) * fps / 1000); }
export function sampleSheet(sheet: Sheet, frame: number) {
 const total = sheet.keys.reduce((sum, key) => sum + key.hold, 0);
 if (!total || sheet.keys.some(key => !Number.isInteger(key.hold) || key.hold <= 0)) throw new Error("Invalid exposure sheet");
 let remaining = sheet.loop ? Math.max(0, Math.floor(frame)) % total : Math.min(total - 1, Math.max(0, Math.floor(frame)));
 for (let index = 0; index < sheet.keys.length; index++) {
  const key = sheet.keys[index]!;
  if (remaining < key.hold) return { ...key, index };
  remaining -= key.hold;
 }
 throw new Error("Invalid exposure frame");
}
/** Acts leave unspecified fields to the stance underneath; completed one-shots release it. */
export function samplePose(base: Sheet, frame: number, act?: Sheet, actFrame = 0): Pose {
 const pose = sampleSheet(base, frame).pose;
 if (!act || (!act.loop && actFrame >= act.keys.reduce((sum,key) => sum + key.hold,0))) return pose;
 return { ...pose, ...sampleSheet(act, actFrame).pose };
}
const VERT = `attribute vec2 aPos; varying vec2 p; void main(){p=vec2(aPos.x*.5+.5, .5-aPos.y*.5)*vec2(352.,532.)-56.;gl_Position=vec4(aPos,0.,1.);}`;
// Sprite-space landmarks and inverse sampling preserve the rigid face, mirrored arm and knee pivots.
const FRAG = `precision highp float;
varying vec2 p; uniform sampler2D image;
uniform float hair,head,mane,arms,sit,kickL,kickR,glitch,split,seed,bob;
vec2 rot(vec2 q, vec2 c,float a){float s=sin(a),k=cos(a);q-=c;return c+vec2(k*q.x-s*q.y,s*q.x+k*q.y);}
vec4 tex(vec2 q){if(q.x<0.||q.y<0.||q.x>240.||q.y>420.)return vec4(0.);vec4 c=texture2D(image,q/vec2(240.,420.));return vec4(c.rgb*c.a,c.a);}
float arm(vec2 q){if(q.x>101.||q.y>234.)return 0.;float top=159.+(98.-q.x)*.5;float bot=q.x<50.?234.:178.+(98.-q.x)*.62;return step(top,q.y)*step(q.y,bot);}
float hash(vec2 q){q=fract(q*vec2(123.34,456.21));q+=dot(q,q+45.32);return fract(q.x*q.y);}
vec2 unsit(vec2 q){if(q.y<=232.)return q;float c=mix(1.,.3,sit);if(q.y<=232.+73.*c)q.y=232.+(q.y-232.)/c;else q.y+=73.*(1.-c);return q;}
float legL(vec2 q){return step(299.,q.y)*(1.-step(117.+max(0.,q.y-300.)*.15,q.x));}
float legR(vec2 q){return step(299.,q.y)*step(117.+max(0.,q.y-300.)*.15,q.x);}
vec4 torso(vec2 q){vec2 b=unsit(q);float knee=232.+73.*mix(1.,.3,sit);vec2 l=unsit(rot(q,vec2(106.,knee),-kickL));vec2 r=unsit(rot(q,vec2(142.,knee),kickR));vec4 body=(legL(b)+legR(b)+arm(b)>0.)?vec4(0.):tex(b);vec4 lc=legL(l)>0.?tex(l):vec4(0.);vec4 rc=legR(r)>0.?tex(r):vec4(0.);vec4 c=lc+body*(1.-lc.a);return rc+c*(1.-rc.a);}
vec4 rig(vec2 q){
 vec2 l=rot(q,vec2(98.,168.),-arms);vec2 r=rot(q,vec2(136.,168.),arms);r.x=234.-r.x;
 vec4 lc=arm(l)>0.?tex(l):vec4(0.);vec4 rc=arm(r)>0.?tex(r):vec4(0.);vec4 ac=lc+rc*(1.-lc.a);
 vec2 b=rot(q,vec2(118.,152.),-head*(1.-smoothstep(138.,162.,q.y)));
 vec2 d=b-vec2(116.,92.);float w=(1.-smoothstep(60.,182.,b.y))*smoothstep(16.,30.,distance(b,vec2(124.,132.)));b=vec2(116.,92.)+d/(1.+mane*w*.32);
 float hw=1.-smoothstep(5.,175.,b.y);b.x-=hair*hw*(.65+.35*sin(b.y*.055));b.y-=hair*.22*hw*sin(b.x*.045);
 vec4 body=torso(b);if(distance(q,vec2(98.,168.))<18.||distance(q,vec2(136.,168.))<18.)return body+ac*(1.-body.a);return ac+body*(1.-ac.a);
}
void main(){vec2 q=p-vec2(0.,bob);float band=floor(q.y/13.);q.x+=step(1.-glitch*.6,hash(vec2(band,seed)))*(hash(vec2(band+3.,seed))-.5)*72.*glitch;vec4 c=rig(q);if(split>0.){vec4 r=rig(q+vec2(split,0.));vec4 b=rig(q-vec2(split,split*.3));c=vec4(r.r,c.g,b.b,max(c.a,max(r.a,b.a)));}vec4 rim=rig(q-vec2(-2.6,2.2));c+=vec4(vec3(.48,.24,1.)*rim.a,rim.a)*(1.-c.a);gl_FragColor=c;}`;
export function createEngine(canvas: HTMLCanvasElement, image: HTMLImageElement) {
 const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
 if (!gl) throw new Error("WebGL unavailable");
 const program = gl.createProgram()!;
 const shaders: WebGLShader[] = [];
 const buffer = gl.createBuffer(), texture = gl.createTexture();
 const dispose = () => { gl.deleteTexture(texture); gl.deleteBuffer(buffer); gl.deleteProgram(program); shaders.forEach(shader => gl.deleteShader(shader)); };
 try {
  for (const [type, source] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]] as const) {
   const shader = gl.createShader(type)!; shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
   if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "Shader failed");
   gl.attachShader(program, shader);
  }
  gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Shader link failed");
  gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, "aPos"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.bindTexture(gl.TEXTURE_2D, texture); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  for (const parameter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, parameter, gl.LINEAR);
  for (const parameter of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, parameter, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, "image"), 0);
 } catch (error) { dispose(); throw error; }
 const uniforms = Object.fromEntries(["hair","head","mane","arms","sit","kickL","kickR","glitch","split","seed","bob"].map(name => [name, gl.getUniformLocation(program, name)]));
 const pixels = new Uint8Array(144 * 204 * 4);
 canvas.width = 144; canvas.height = 204; gl.viewport(0, 0, 144, 204);
 return {
  draw(pose: Pose, frame: number) {
   gl.useProgram(program); gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
   for (const [name, location] of Object.entries(uniforms)) gl.uniform1f(location, name === "seed" ? frame : (pose[name as keyof Pose] ?? 0));
   gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
   gl.readPixels(0,0,144,204,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
   return alphaMask(pixels,144,204);
  }, dispose,
 };
}
/** Bottom-up WebGL alpha -> existing top-down 24x34 native silhouette. */
export function alphaMask(pixels: Uint8Array, width: number, height: number): number[] {
 const mask = Array<number>(816).fill(0);
 for (let y=0;y<height;y++) for (let x=0;x<width;x++) if (pixels[(y*width+x)*4+3]! > 24) mask[Math.floor((height-1-y)*34/height)*24+Math.floor(x*24/width)]=1;
 return mask;
}
