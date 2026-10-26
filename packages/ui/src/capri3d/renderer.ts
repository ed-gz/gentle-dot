import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import type { AssetName, AssetReader } from "./assets.ts";
import type { ClipChoice } from "./mapping.ts";
import { encodeAlphaMask } from "./mask.ts";
import { injectLegs } from "./rig.ts";
import { createPosePlayer, clips, type ProceduralClip } from "./procedural.ts";
import { FrameScheduler } from "./scheduler.ts";
import { attachFace, type FaceLayer } from "./face.ts";

/** WebGL stays behind this interface so the surface can be tested without a GPU. */
export interface CapriRenderer {
 choose(choice: ClipChoice): Promise<void>;
 visibility(visible: boolean, reduced: boolean): void;
 dispose(): void;
}
export interface RendererOptions {
 canvas: HTMLCanvasElement;
 base: ArrayBuffer;
 read: AssetReader;
 mask(cells: number[]): void;
 failure(): void;
}
export type RendererFactory = (options: RendererOptions) => Promise<CapriRenderer>;

function release(gltf: GLTF) {
 const textures = new Set<THREE.Texture>();
 gltf.scene.traverse(object => {
  if (!(object instanceof THREE.Mesh)) return;
  object.geometry.dispose();
  for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
   for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
   material.dispose();
  }
  if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
 });
 for (const texture of textures) texture.dispose();
}

/** Local GLBs may embed textures, but cannot cause the loader to fetch external resources. */
function embeddedOnly(bytes: ArrayBuffer) {
 const view = new DataView(bytes);
 if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2)
  throw new Error("Invalid GLB");
 const length = view.getUint32(12, true);
 if (view.getUint32(16, true) !== 0x4e4f534a || length > bytes.byteLength - 20) throw new Error("Invalid GLB JSON");
 const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length))) as {
  buffers?: { uri?: string }[]; images?: { uri?: string }[];
 };
 for (const entry of [...(json.buffers ?? []), ...(json.images ?? [])])
  if (entry.uri && !entry.uri.startsWith("data:")) throw new Error("External GLB resource rejected");
}

export const createRenderer: RendererFactory = async options => {
 const renderer = new THREE.WebGLRenderer({ canvas: options.canvas, alpha: true, antialias: false });
 renderer.setPixelRatio(1);
 renderer.setSize(240, 340, false);
 renderer.setClearColor(0, 0);
 const scene = new THREE.Scene();
 scene.add(new THREE.HemisphereLight(0xffffff, 0x686280, 2));
 const light = new THREE.DirectionalLight(0xffffff, 2);
 light.position.set(-3, 6, 8);
 scene.add(light);
 const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
 const target = new THREE.WebGLRenderTarget(240, 340);
 const pixels = new Uint8Array(240 * 340 * 4);
 const topDown = new Uint8Array(pixels.length);
 const loader = new GLTFLoader();
 const cache = new Map<AssetName, GLTF>();
 let face: FaceLayer | undefined;
 let disposed = false, visible = false, reduced = false, generation = 0;
 let battery = false;
 const players = new WeakMap<THREE.Object3D, ReturnType<typeof createPosePlayer>>();
 let player: ReturnType<typeof createPosePlayer> | undefined;
 let current: GLTF | undefined, currentName: AssetName | undefined;
 let mixer: THREE.AnimationMixer | undefined, action: THREE.AnimationAction | undefined;
 let choice: ClipChoice | undefined;
 let lastMask = -Infinity, elapsed = 0;
 let procedural: ProceduralClip | undefined;
 let phase = 0;
 let following: ProceduralClip | undefined;
 const framing = new WeakMap<THREE.Object3D, THREE.Box3>();
 const batteryApi = navigator as Navigator & { getBattery?: () => Promise<EventTarget & { charging: boolean }> };
 let batteryState: (EventTarget & { charging: boolean }) | undefined;
 const batteryChanged = () => { battery = batteryState?.charging === false; resume(); };
 void batteryApi.getBattery?.().then(state => { if (disposed) return; batteryState = state; state.addEventListener("chargingchange", batteryChanged); batteryChanged(); }).catch(() => {});
 const home = new THREE.Vector3();
 let queue = Promise.resolve();
 const scheduler = new FrameScheduler(delta => tick(delta));
 const stop = () => scheduler.dispose();
 const frame = (forceMask = false, silhouette = true) => {
  if (disposed || !visible || !current) return;
  renderer.render(scene, camera);
  if (silhouette && (forceMask || performance.now() - lastMask >= 500)) {
   renderer.setRenderTarget(target);
   try {
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, 240, 340, pixels);
   } finally { renderer.setRenderTarget(null); }
   for (let y = 0; y < 340; y++) topDown.set(pixels.subarray((339 - y) * 960, (340 - y) * 960), y * 960);
   options.mask(encodeAlphaMask(topDown, 240, 340));
   lastMask = performance.now();
  }
 };
 const running = () => visible && !reduced && !disposed;
 const tick = (delta: number) => {
  if (!running()) return;
  elapsed += delta;
  if (procedural) {
   phase += delta;
   if (following && phase >= clips[procedural].duration) {
    procedural = following; following = undefined; phase = 0; player?.play(procedural);
   }
   player?.update(delta);
  } else {
   mixer?.update(delta);
   // Authored resting GLBs have no playing clip. A live timer alone just
   // repaints identical pixels; breathe/sway without replacing their pose.
   if (current && !action) {
    current.scene.position.y = home.y + 0.025 * Math.sin(elapsed * Math.PI / 2);
    current.scene.rotation.z = 0.012 * Math.sin(elapsed * Math.PI / 3);
   }
  }
  if (currentName === "roja.glb") face?.update(elapsed, procedural === "hablar" || choice?.clip === "Hablar", procedural === "dormir" ? true : undefined);
  if (current && choice?.motion) {
   const t = elapsed * 1000 / (choice.duration ?? 1);
   if (choice.motion === "walk") {
    current.scene.rotation.y = t < 1 ? (choice.direction ?? 1) * 0.45 : 0;
    if (t >= 1 && procedural === "caminar") { procedural = "quieta"; player?.play("quieta"); }
   } else if (choice.motion === "land") {
    const squash = Math.max(0, 1 - t) * Math.sin(Math.min(t, 1) * Math.PI);
    current.scene.scale.y = 1 - squash * 0.12;
   } else if (choice.motion === "teleport") {
    // The native path switches at 50%, inside this transparent scanline envelope.
    const opacity = Math.min(1, Math.abs(t - 0.5) * 5);
    options.canvas.style.opacity = String(opacity);
    options.canvas.style.filter = t < 1 ? "drop-shadow(3px 0 #00e5ef) drop-shadow(-3px 0 #ed4fa7)" : "";
    options.canvas.style.clipPath = t < 1 ? `inset(${Math.floor(t * 17) % 3}% 0)` : "";
   }
  }
  if (!procedural && choice?.end !== undefined && elapsed + (choice.start ?? 0) >= choice.end) {
   // Wave ends before teleport tracks. Clamp instead of playing the teleport section.
   mixer?.setTime(choice.end);
   if (action) action.paused = true;
  }
  try { frame(!running()); } catch { stop(); options.failure(); return; }
 };
 const resume = () => {
  stop();
  if (!visible || disposed) return;
  try { frame(true); } catch { options.failure(); return; }
  scheduler.set({ visible, reduced, battery });
 };
 const parse = async (bytes: ArrayBuffer) => {
  embeddedOnly(bytes);
  const gltf = await loader.parseAsync(bytes, "");
  gltf.scene.traverse(object => {
   if (!(object instanceof THREE.Mesh)) return;
   object.frustumCulled = false;
   for (const material of Array.isArray(object.material) ? object.material : [object.material])
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) {
     value.magFilter = THREE.NearestFilter;
     value.minFilter = THREE.NearestFilter;
     value.generateMipmaps = false;
     value.needsUpdate = true;
    }
  });
  return gltf;
 };
 const lost = (event: Event) => { event.preventDefault(); stop(); options.failure(); };
 options.canvas.addEventListener("webglcontextlost", lost);
 const dispose = () => {
  if (disposed) return;
  disposed = true;
  generation++;
  batteryState?.removeEventListener("chargingchange", batteryChanged);
  stop();
  options.canvas.removeEventListener("webglcontextlost", lost);
  mixer?.stopAllAction();
  if (current) mixer?.uncacheRoot(current.scene);
  for (const gltf of cache.values()) release(gltf);
  cache.clear();
  target.dispose();
  renderer.dispose();
 };
 try {
  const base = await parse(options.base);
  injectLegs(base.scene);
  players.set(base.scene, createPosePlayer(base.scene));
  cache.set("roja.glb", base);
  face = attachFace(base.scene);
 }
 catch (error) { dispose(); throw error; }
 return {
  choose(next) {
   const request = ++generation;
   queue = queue.catch(() => {}).then(async () => {
    if (disposed || request !== generation) return;
    let name = next.model, gltf = cache.get(name);
    if (!gltf) {
     try { gltf = await parse(await options.read(name)); }
     catch { name = "roja.glb"; gltf = cache.get(name); next = { model: name, clip: "Pensar" }; }
     if (!gltf) throw new Error("Missing base model");
     if (disposed) { if (name !== "roja.glb") release(gltf); return; }
     cache.set(name, gltf);
    }
    // Two models total: base fallback plus the visible alternate.
    cache.delete(name); cache.set(name, gltf);
    if (current) { current.scene.position.copy(home); scene.remove(current.scene); }
    mixer?.stopAllAction();
    if (current) mixer?.uncacheRoot(current.scene);
    while (cache.size > 2) {
     const victim = [...cache.keys()].find(key => key !== "roja.glb" && key !== name)!;
     release(cache.get(victim)!); cache.delete(victim);
    }
    if (request !== generation) return;
    stop();
    options.canvas.style.opacity = "";
    options.canvas.style.filter = "";
    options.canvas.style.clipPath = "";
    const switched = currentName !== undefined && currentName !== name;
    current = gltf; currentName = name; choice = next;
    home.copy(gltf.scene.position);
    gltf.scene.rotation.set(0, 0, 0);
    gltf.scene.scale.set(1, 1, 1);
    scene.add(gltf.scene);
    mixer = new THREE.AnimationMixer(gltf.scene);
    elapsed = 0;
    const previousProcedural = procedural;
    player = players.get(gltf.scene);
    const aliases: Record<string, ProceduralClip> = { Flotar_en_reposo: "quieta", Pensar: "pensar", Hablar: "hablar", Reir: "celebrar" };
    procedural = name === "roja.glb" ? next.procedural ?? (next.motion === "walk" ? "caminar" : next.motion === "fall" ? "colgando" : aliases[next.clip ?? ""]) : undefined;
    following = undefined; phase = 0;
    if (procedural === "sentada" && previousProcedural !== "sentada") { procedural = "sentarse"; following = "sentada"; }
    else if (procedural === "colgada" && previousProcedural !== "colgada") { procedural = "colgarse"; following = "colgada"; }
    else if (previousProcedural === "sentada" && procedural === "quieta") { procedural = "pararse"; following = "quieta"; }
    else if (procedural === "sorpresa") following = "triste";
    if (procedural && !following && !("loop" in clips[procedural])) following = "quieta";
    if (procedural && player) { player.play(procedural); if (reduced) player.update(0.3); }
    const clip = !procedural ? next.clip ? gltf.animations.find(clip => clip.name === next.clip) : next.once ? gltf.animations[0] : undefined : undefined;
    // Alternate models are authored poses; don't animate an arbitrary clip.
    action = clip ? mixer.clipAction(clip) : undefined;
    if (action) {
     action.setLoop(next.once ? THREE.LoopOnce : THREE.LoopRepeat, next.once ? 1 : Infinity);
     action.clampWhenFinished = true;
     action.play(); mixer.update(0);
     if (next.start) mixer.setTime(next.start);
    }
    gltf.scene.updateMatrixWorld(true);
    // Stable bind-pose framing: changing a clip must not zoom/pan around its previous pose.
    const box = framing.get(gltf.scene) ?? new THREE.Box3().setFromObject(gltf.scene);
    framing.set(gltf.scene, box);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    const extraRoom = procedural === "voltereta" ? 1.65 : procedural === "salto" ? 1.25 : 1;
    const halfHeight = Math.max(size.y * 0.62, size.x * 0.62 * 340 / 240, 0.1) * extraRoom;
    camera.left = -halfHeight * 240 / 340; camera.right = -camera.left;
    camera.top = halfHeight; camera.bottom = -halfHeight;
    camera.position.set(center.x, center.y, center.z + Math.max(size.z, halfHeight) * 4);
    camera.lookAt(center); camera.updateProjectionMatrix();
    if (switched && !reduced) {
     options.canvas.classList.remove("capri3d-glitch");
     // Restart a short CSS-only glitch; it never moves the native window.
     void options.canvas.offsetWidth;
     options.canvas.classList.add("capri3d-glitch");
    }
    if (name === "roja.glb") face?.update(0, next.clip === "Hablar" && !reduced);
    resume();
   });
   return queue;
  },
  visibility(nextVisible, nextReduced) { visible = nextVisible; reduced = nextReduced; resume(); },
  dispose,
 };
};
