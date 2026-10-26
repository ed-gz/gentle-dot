import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import type { AssetName, AssetReader } from "./assets.ts";
import type { ClipChoice } from "./mapping.ts";
import { encodeAlphaMask } from "./mask.ts";

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
 let disposed = false, visible = false, reduced = false, generation = 0;
 let timer: ReturnType<typeof setTimeout> | undefined;
 let current: GLTF | undefined, currentName: AssetName | undefined;
 let mixer: THREE.AnimationMixer | undefined, action: THREE.AnimationAction | undefined;
 let choice: ClipChoice | undefined;
 let last = 0, lastMask = -Infinity, elapsed = 0;
 let queue = Promise.resolve();
 const stop = () => { clearTimeout(timer); timer = undefined; };
 const frame = (forceMask = false) => {
  if (disposed || !visible || !current) return;
  renderer.render(scene, camera);
  if (forceMask || performance.now() - lastMask >= 500) {
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
 const running = () => visible && !reduced && action && action.isRunning() && choice?.clip !== "Flotar_en_reposo";
 const tick = () => {
  timer = undefined;
  if (!running() || disposed) return;
  const now = performance.now();
  const delta = Math.min((now - last) / 1000, 0.1);
  last = now;
  elapsed += delta;
  mixer?.update(delta);
  if (choice?.end !== undefined && elapsed >= choice.end) {
   // Wave ends before teleport tracks. Clamp instead of playing the teleport section.
   mixer?.setTime(choice.end);
   action!.paused = true;
  }
  try { frame(!running()); } catch { stop(); options.failure(); return; }
  if (running()) timer = setTimeout(tick, 1000 / 30);
 };
 const resume = () => {
  stop();
  if (!visible || disposed) return;
  try { frame(true); } catch { options.failure(); return; }
  last = performance.now();
  if (running()) timer = setTimeout(tick, 1000 / 30);
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
  stop();
  options.canvas.removeEventListener("webglcontextlost", lost);
  mixer?.stopAllAction();
  if (current) mixer?.uncacheRoot(current.scene);
  for (const gltf of cache.values()) release(gltf);
  cache.clear();
  target.dispose();
  renderer.dispose();
 };
 try { cache.set("roja.glb", await parse(options.base)); }
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
    // Touch LRU; base plus at most two alternate models, including the visible one.
    cache.delete(name); cache.set(name, gltf);
    if (current) scene.remove(current.scene);
    mixer?.stopAllAction();
    if (current) mixer?.uncacheRoot(current.scene);
    while (cache.size > 3) {
     const victim = [...cache.keys()].find(key => key !== "roja.glb" && key !== name)!;
     release(cache.get(victim)!); cache.delete(victim);
    }
    if (request !== generation) return;
    stop();
    const switched = currentName !== undefined && currentName !== name;
    current = gltf; currentName = name; choice = next;
    scene.add(gltf.scene);
    mixer = new THREE.AnimationMixer(gltf.scene);
    elapsed = 0;
    const clip = next.clip ? gltf.animations.find(clip => clip.name === next.clip) : undefined;
    // Alternate models are authored poses; don't animate an arbitrary clip.
    action = clip ? mixer.clipAction(clip) : undefined;
    if (action) {
     action.setLoop(next.once ? THREE.LoopOnce : THREE.LoopRepeat, next.once ? 1 : Infinity);
     action.clampWhenFinished = true;
     action.play(); mixer.update(0);
    }
    gltf.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const halfHeight = Math.max(size.y * 0.62, size.x * 0.62 * 340 / 240, 0.1);
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
    resume();
   });
   return queue;
  },
  visibility(nextVisible, nextReduced) { visible = nextVisible; reduced = nextReduced; resume(); },
  dispose,
 };
};
