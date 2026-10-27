// Ported from https://github.com/mochiiwuff/capri-desktop (MIT).
// Code only. Texture landmarks refer to the user's local 240x420 cutout.
export const VERT = `
attribute vec2 aPos;
uniform vec2 uView;
uniform float uPad;
// Native adaptation: do the reference CSS body transform in sprite space so
// the alpha readback and the visible figure always have exactly the same shape.
uniform vec4 uBody; // bob, tilt radians, sx, sy
uniform float uSit;
varying vec2 vPx;
void main() {
 vec2 uv = aPos * 0.5 + 0.5;
 vec2 q = vec2(uv.x, 1.0 - uv.y) * uView - uPad;
 vec2 pivot = vec2(128.0, mix(418.0, 232.0, uSit));
 q -= pivot + vec2(0.0, uBody.x);
 float c = cos(uBody.y), s = sin(uBody.y);
 q = vec2(c*q.x+s*q.y, -s*q.x+c*q.y);
 vPx = pivot + q / uBody.zw;
 gl_Position = vec4(aPos, 0.0, 1.0);
}`;
export const FRAG = `
precision highp float;
varying vec2 vPx;
uniform sampler2D uTex;
uniform vec2 uSize;
uniform float uSeed, uBoil, uHair, uHead, uMane;
uniform float uArmL, uArmR, uLongL, uLongR;
uniform float uSit, uKickL, uKickR;
uniform vec2 uSmear, uEcho;
uniform float uGlitch, uGlitchSeed, uSplit, uCollapse, uDissolve, uSparkle, uGrade;
uniform vec4 uSil;
uniform vec2 uMisreg;
uniform vec3 uRim;
uniform float uAlpha, uPx, uMask;
// Procedural sleep face adapted from fx.js drawMask, in sprite coordinates.
// Kept in the body pass so native hit-test alpha matches the visible small form.
float cross2(vec2 a, vec2 b) { return a.x*b.y-a.y*b.x; }
bool triangle(vec2 p, vec2 a, vec2 b, vec2 c) {
 float x=cross2(b-a,p-a), y=cross2(c-b,p-b), z=cross2(a-c,p-c);
 return (x>=0.0&&y>=0.0&&z>=0.0)||(x<=0.0&&y<=0.0&&z<=0.0);
}
vec4 sleepMask(vec2 q) {
 vec2 p=q-vec2(124.0,132.0);
 bool face=triangle(p,vec2(-48,-20),vec2(48,-26),vec2(46,20))||triangle(p,vec2(-48,-20),vec2(46,20),vec2(-45,23));
 bool spike=triangle(p,vec2(-32,-20),vec2(-37,-50),vec2(30,-48))||triangle(p,vec2(-37,-50),vec2(24,-75),vec2(30,-48))||triangle(p,vec2(24,-75),vec2(34,-99),vec2(49,-90))||triangle(p,vec2(24,-75),vec2(49,-90),vec2(30,-48));
 bool fang=triangle(p,vec2(-6,22),vec2(22,21),vec2(8,52));
 if(!face&&!spike&&!fang)return vec4(0.0);
 vec3 col=fang?vec3(1.0,.95,.97):vec3(.21,1.0,.48);
 // Two sleeping chevrons; no synthetic random winks or unnecessary eye polling.
 float ex=min(abs(p.x+23.0),abs(p.x-22.0));
 if(face&&ex<15.0&&abs(p.y-(5.0-ex*.6))<2.5)col=vec3(.08,.06,.11);
 return vec4(col,1.0);
}
const vec2 NECK = vec2(118.0, 152.0);
const vec2 SHOULDER_L = vec2(98.0, 168.0);
const float MIRROR = 234.0;
const vec2 SHOULDER_R = vec2(136.0, 168.0);
const vec2 MANE = vec2(116.0, 92.0);
const vec2 FACE = vec2(124.0, 132.0);
const float AXIS = 118.0;
const float HIP = 232.0;
const float KNEE = 305.0;
const float KNEE_LX = 106.0;
const float KNEE_RX = 142.0;
float hash(vec2 p) {
 p = fract(p * vec2(123.34, 456.21));
 p += dot(p, p + 45.32);
 return fract(p.x * p.y);
}
float vnoise(vec2 p) {
 vec2 i = floor(p), f = fract(p);
 f = f * f * (3.0 - 2.0 * f);
 return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec2 rot(vec2 p, vec2 c, float a) {
 float s = sin(a), k = cos(a);
 p -= c;
 return c + vec2(k * p.x - s * p.y, s * p.x + k * p.y);
}
vec4 tex(vec2 p) {
 if (p.x < 0.0 || p.y < 0.0 || p.x > uSize.x || p.y > uSize.y) return vec4(0.0);
 return texture2D(uTex, p / uSize);
}
vec3 rgb2hsv(vec3 c) {
 vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
 vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
 vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
 float d = q.x - min(q.w, q.y);
 return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
 vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
 vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
 return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
vec3 grade(vec3 c, out float red) {
 vec3 h = rgb2hsv(c);
 float hx = h.x < 0.5 ? h.x + 1.0 : h.x;
 float lit = smoothstep(0.1, 0.3, h.z);
 red = smoothstep(0.78, 0.85, hx) * (1.0 - smoothstep(1.06, 1.1, hx)) * lit * smoothstep(0.06, 0.2, h.y);
 float green = smoothstep(0.22, 0.27, h.x) * (1.0 - smoothstep(0.47, 0.52, h.x)) * lit * smoothstep(0.15, 0.3, h.y);
 hx = mix(hx, 0.968, red * 0.6 * uGrade);
 h.x = fract(hx);
 h.y = mix(h.y, max(h.y, 0.86), red * uGrade);
 h.y = mix(h.y, min(1.0, h.y * 1.1 + 0.06), green * uGrade);
 h.z = mix(h.z, min(1.0, h.z * 1.5 + 0.1), (red + green) * uGrade);
 return hsv2rgb(h);
}
vec4 cel(vec2 s) {
 vec4 c = tex(s);
 if (c.a <= 0.0) return vec4(0.0);
 float red;
 c.rgb = grade(c.rgb, red);
 if (red > 0.0 && uSparkle > 0.0) {
  vec2 cell = floor(s / max(0.8, uPx * 1.2));
  float star = step(0.976, hash(cell + 3.1)) * 0.85;
  float tw = step(0.993, hash(cell + uSeed * 1.37));
  c.rgb = mix(c.rgb, vec3(1.0, 0.95, 0.97), clamp((star + tw) * red * uSparkle, 0.0, 1.0));
 }
 return vec4(c.rgb * c.a, c.a);
}
float legSep(float y) { return 117.0 + max(0.0, y - 300.0) * 0.15; }
float legL(vec2 s) { return step(KNEE - 6.0, s.y) * (1.0 - step(legSep(s.y), s.x)); }
float legR(vec2 s) { return step(KNEE - 6.0, s.y) * step(legSep(s.y), s.x); }
float thighScale() { return mix(1.0, 0.3, uSit); }
vec2 unsit(vec2 q) {
 if (uSit <= 0.0 || q.y <= HIP) return q;
 float c = thighScale();
 if (q.y <= HIP + (KNEE - HIP) * c) q.y = HIP + (q.y - HIP) / c;
 else q.y += (KNEE - HIP) * (1.0 - c);
 return q;
}
float armL(vec2 s) {
 if (s.x > 101.0 || s.y > 234.0) return 0.0;
 float top = 159.0 + (98.0 - s.x) * 0.5;
 float bot = s.x < 50.0 ? 234.0 : 178.0 + (98.0 - s.x) * 0.62;
 return step(top, s.y) * step(s.y, bot);
}
vec2 mirrorArm(vec2 s) { return vec2(MIRROR - s.x, s.y); }
const vec2 ARM_DIR = vec2(-0.85954, 0.51108);
vec2 stretchArm(vec2 s, float k) {
 if (k == 1.0) return s;
 vec2 v = s - SHOULDER_L;
 float along = dot(v, ARM_DIR);
 return SHOULDER_L + ARM_DIR * (along / k) + (v - ARM_DIR * along);
}
vec2 armLeft(vec2 q) { return stretchArm(rot(q, SHOULDER_L, -uArmL), uLongL); }
vec2 armRight(vec2 q) { return stretchArm(mirrorArm(rot(q, SHOULDER_R, uArmR)), uLongR); }
bool legsRigged() { return uSit > 0.0 || uKickL != 0.0 || uKickR != 0.0; }
vec4 torso(vec2 q) {
 if (!legsRigged()) return armL(q) > 0.0 ? vec4(0.0) : cel(q);
 float kneeY = HIP + (KNEE - HIP) * thighScale();
 vec2 qB = unsit(q);
 vec2 qL = unsit(rot(q, vec2(KNEE_LX, kneeY), -uKickL));
 vec2 qR = unsit(rot(q, vec2(KNEE_RX, kneeY), uKickR));
 vec4 b = legL(qB) + legR(qB) + armL(qB) > 0.0 ? vec4(0.0) : cel(qB);
 vec4 l = legL(qL) > 0.0 ? cel(qL) : vec4(0.0);
 vec4 r = legR(qR) > 0.0 ? cel(qR) : vec4(0.0);
 vec4 c = l + b * (1.0 - l.a);
 return r + c * (1.0 - r.a);
}
float armAlpha(vec2 q) {
 vec2 qL = armLeft(q), qR = armRight(q);
 return max(armL(qL) * tex(qL).a, armL(qR) * tex(qR).a);
}
vec2 bend(vec2 q) {
 q = rot(q, NECK, -uHead * smoothstep(162.0, 138.0, q.y));
 if (uMane != 0.0) {
  vec2 d = q - MANE;
  float spikes = 0.55 + 0.9 * vnoise(vec2(atan(d.y, d.x) * 2.6, 4.0));
  float w = smoothstep(182.0, 60.0, q.y) * smoothstep(16.0, 30.0, distance(q, FACE));
  q = MANE + d / (1.0 + uMane * w * 0.32 * spikes);
 }
 float hw = smoothstep(175.0, 5.0, q.y);
 q.x -= uHair * hw * (0.65 + 0.35 * sin(q.y * 0.055));
 q.y -= uHair * 0.22 * hw * sin(q.x * 0.045);
 return q;
}
vec4 rig(vec2 q) {
 vec2 qL = armLeft(q), qR = armRight(q);
 vec4 l = armL(qL) > 0.0 ? cel(qL) : vec4(0.0);
 vec4 r = armL(qR) > 0.0 ? cel(qR) : vec4(0.0);
 vec4 arms = l + r * (1.0 - l.a);
 vec4 b = torso(bend(q));
 bool joint = distance(q, SHOULDER_L) < 18.0 || distance(q, SHOULDER_R) < 18.0;
 if (joint) return b + arms * (1.0 - b.a);
 if (arms.a < 0.5 && b.a > 0.5 && (uArmL != 0.0 || uArmR != 0.0)) {
  float edge = max(max(armAlpha(q + vec2(1.8, 0.0)), armAlpha(q - vec2(1.8, 0.0))),
   max(armAlpha(q + vec2(0.0, 1.8)), armAlpha(q - vec2(0.0, 1.8))));
  if (edge > 0.5) return vec4(uRim, 1.0);
 }
 return arms + b * (1.0 - arms.a);
}
float rigAlpha(vec2 q) { return rig(q).a; }
vec2 settle(vec2 p) {
 vec2 q = p;
 q.x = AXIS + (q.x - AXIS) / max(1.0 - uCollapse, 0.025);
 q.y = 240.0 + (q.y - 240.0) / (1.0 + uCollapse * 0.4);
 if (uGlitch > 0.0) {
  float bh = mix(5.0, 26.0, hash(vec2(uGlitchSeed, 7.0)));
  float band = floor(q.y / bh);
  float on = step(1.0 - uGlitch * 0.6, hash(vec2(band, uGlitchSeed)));
  q.x += on * (hash(vec2(band + 3.0, uGlitchSeed)) - 0.5) * 72.0 * uGlitch;
 }
 q += (vec2(vnoise(q * 0.075 + uSeed * 13.7), vnoise(q * 0.075 + uSeed * 7.3 + 31.0)) - 0.5) * 2.0 * uBoil;
 return q;
}
void main() {
 vec2 p = vPx;
 if(uMask>0.5){gl_FragColor=sleepMask(p);return;}
 if (uDissolve > 0.0) {
  vec2 g = rot(p, vec2(110.0, 210.0), 0.55);
  vec2 cell = floor(g / vec2(16.0, 9.0));
  if (hash(cell + floor(uGlitchSeed)) < uDissolve) discard;
 }
 vec2 q = settle(p);
 vec4 c = rig(q);
 vec3 col = c.rgb;
 float a = c.a;
 if (uSplit > 0.0) {
  vec4 cr = rig(q + vec2(uSplit, 0.0));
  vec4 cb = rig(q - vec2(uSplit, uSplit * 0.3));
  col = vec3(cr.r, col.g, cb.b);
  a = max(a, max(cr.a, cb.a));
 }
 if (uSmear != vec2(0.0)) {
  float hw = smoothstep(178.0, 140.0, q.y);
  for (int i = 1; i <= 2; i++) {
   vec4 m = rig(q - uSmear * hw * float(i) * 0.5);
   col += m.rgb * (1.0 - a);
   a += m.a * (1.0 - a);
  }
 }
 col = mix(col, uSil.rgb * a, uSil.a);
 if (uEcho != vec2(0.0)) {
  float e1 = rigAlpha(q - uEcho) * (1.0 - a);
  col += vec3(0.21, 1.0, 0.48) * e1;
  a += e1;
  float e2 = rigAlpha(q + uEcho) * (1.0 - a);
  col += vec3(1.0, 0.13, 0.32) * e2;
  a += e2;
 }
 float rim = rigAlpha(q - uMisreg) * (1.0 - a);
 col += uRim * rim;
 a += rim;
 gl_FragColor = vec4(col, a) * uAlpha;
}`;
export const UNIFORMS = ['uMask','uBody','uView','uPad','uTex','uSize','uSeed','uBoil','uHair','uHead','uMane','uArmL','uArmR','uLongL','uLongR','uSit','uKickL','uKickR','uSmear','uEcho','uGlitch','uGlitchSeed','uSplit','uCollapse','uDissolve','uSparkle','uGrade','uSil','uMisreg','uRim','uAlpha','uPx'] as const;
