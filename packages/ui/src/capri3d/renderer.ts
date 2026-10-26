import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import type { AssetName, AssetReader } from "./assets.ts";
import type { ClipChoice } from "./mapping.ts";
import { encodeAlphaMask } from "./mask.ts";
import { injectLegs } from "./rig.ts";
import { createPosePlayer, clips, samplePose, type ProceduralClip } from "./procedural.ts";
import { FrameScheduler } from "./scheduler.ts";
import { attachFace, type FaceLayer } from "./face.ts";
import { faceFrame, headVisible, loadDesktopFaces, transitionFace, type DesktopForm } from "./desktop-faces.ts";
import { PERCH_SEAT_Y, perchCameraY } from "./perch.ts";

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

/** Pixel clearance also absorbs motion between the 30Hz framing samples. */
export const FRAME_MARGIN = 12;
export interface PoseBounds { world: THREE.Box3; seated: THREE.Box3 }

/** Capture bind transforms before any player mutates them; measuring never changes playback. */
export function createFramingSampler(scene: THREE.Object3D) {
 const bind = new Map<THREE.Object3D, { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }>();
 scene.traverse(object => bind.set(object, { position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone() }));
 const cache = new Map<ProceduralClip, PoseBounds>();
 const measure = (): PoseBounds => {
  scene.updateMatrixWorld(true);
  scene.traverse(object => { if (object instanceof THREE.SkinnedMesh) object.skeleton.update(); });
  // precise=true evaluates skinned vertices, not stale bind-pose geometry bounds.
  const world = new THREE.Box3().setFromObject(scene, true);
  const left = scene.getObjectByName("Muslo_izquierdo"), right = scene.getObjectByName("Muslo_derecho");
  const hip = left && right ? left.getWorldPosition(new THREE.Vector3()).add(right.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5) : new THREE.Vector3();
  return { world, seated: world.clone().translate(hip.negate()) };
 };
 return (names: ProceduralClip[], authored?: THREE.AnimationClip, start = 0, end = authored?.duration ?? 0): PoseBounds => {
  const saved = new Map<THREE.Object3D, { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }>();
  scene.traverse(object => saved.set(object, { position: object.position.clone(), rotation: object.rotation.clone(), scale: object.scale.clone() }));
  const result = measure(); // Includes the outgoing pose during the 300ms blend.
  try {
   for (const name of names) {
    let bounds = cache.get(name);
    if (!bounds) {
     bounds = { world: new THREE.Box3(), seated: new THREE.Box3() };
     const steps = Math.ceil(clips[name].duration * 30);
     for (let i = 0; i <= steps; i++) {
      for (const [object, transform] of bind) { object.position.copy(transform.position); object.quaternion.copy(transform.quaternion); object.scale.copy(transform.scale); }
      for (const [key, value] of Object.entries(samplePose(name, clips[name].duration * i / steps))) {
       const [node, property = "rotation"] = key.split(".");
       const object = scene.getObjectByName(node!);
       if (!object) continue;
       if (property === "rotation") object.rotation.set(...value.map(v => THREE.MathUtils.degToRad(v)) as [number, number, number]);
       else if (property === "position") object.position.add(new THREE.Vector3(...value));
       else object.scale.multiply(new THREE.Vector3(...value));
      }
      const sample = measure();
      bounds.world.union(sample.world); bounds.seated.union(sample.seated);
     }
     cache.set(name, bounds);
    }
    result.world.union(bounds.world); result.seated.union(bounds.seated);
    // Slerping between two rotations can extend beyond either endpoint's AABB
    // (notably colgada -> colgando). Measure the actual 300ms player blend too.
    for (let i = 0; i <= 18; i++) {
     const t = i / 60, u = t / 0.3, weight = u * u * (3 - 2 * u);
     for (const [object, transform] of bind) { object.position.copy(transform.position); object.quaternion.copy(transform.quaternion); object.scale.copy(transform.scale); }
     for (const [key, value] of Object.entries(samplePose(name, t))) {
      const [node, property = "rotation"] = key.split("."); const object = scene.getObjectByName(node!);
      if (!object) continue;
      const from = saved.get(object)!;
      if (property === "rotation") {
       const target = new THREE.Quaternion().setFromEuler(new THREE.Euler(...value.map(v => THREE.MathUtils.degToRad(v)) as [number, number, number]));
       object.quaternion.setFromEuler(from.rotation).slerp(target, weight);
      } else if (property === "position") {
       const target = bind.get(object)!.position.clone().add(new THREE.Vector3(...value));
       object.position.copy(from.position).lerp(target, weight);
      } else {
       const target = bind.get(object)!.scale.clone().multiply(new THREE.Vector3(...value));
       object.scale.copy(from.scale).lerp(target, weight);
      }
     }
     const sample = measure(); result.world.union(sample.world); result.seated.union(sample.seated);
    }
   }
   if (authored) {
    for (const [object, transform] of bind) { object.position.copy(transform.position); object.quaternion.copy(transform.quaternion); object.scale.copy(transform.scale); }
    const mixer = new THREE.AnimationMixer(scene);
    const action = mixer.clipAction(authored);
    action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
    try {
     const steps = Math.max(1, Math.ceil((end - start) * 60));
     for (let i = 0; i <= steps; i++) {
      mixer.setTime(start + (end - start) * i / steps);
      const sample = measure(); result.world.union(sample.world); result.seated.union(sample.seated);
     }
    } finally { mixer.stopAllAction(); mixer.uncacheRoot(scene); }
   }
   return result;
  } finally {
   for (const [object, transform] of saved) { object.position.copy(transform.position); object.rotation.copy(transform.rotation); object.scale.copy(transform.scale); }
   scene.updateMatrixWorld(true);
   scene.traverse(object => { if (object instanceof THREE.SkinnedMesh) object.skeleton.update(); });
  }
 };
}

/** Fit both axes; perched bounds are hip-relative because the camera follows that anchor. */
export function fitPoseCamera(camera: THREE.OrthographicCamera, bounds: PoseBounds, perched: boolean) {
 const box = perched ? bounds.seated : bounds.world;
 const center = box.getCenter(new THREE.Vector3());
 const width = 240 - 2 * FRAME_MARGIN, height = 340 - 2 * FRAME_MARGIN;
 const halfHeight = perched
  ? Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) * 340 / width
  : (box.max.x - box.min.x) * 170 / width;
 const vertical = perched
  ? Math.max(box.max.y * 170 / (PERCH_SEAT_Y - FRAME_MARGIN), -box.min.y * 170 / (340 - PERCH_SEAT_Y - FRAME_MARGIN))
  : (box.max.y - box.min.y) * 170 / height;
 // Extra 8% protects interpolated rotations and sub-sample extrema, without per-frame zoom.
 const half = Math.max(halfHeight, vertical, 0.1) * 1.08;
 camera.left = -half * 240 / 340; camera.right = -camera.left;
 camera.top = half; camera.bottom = -half;
 camera.position.set(center.x, center.y, bounds.world.max.z + Math.max(half, box.max.z - box.min.z) * 4);
 camera.lookAt(center.x, center.y, bounds.world.min.z);
 camera.updateProjectionMatrix();
 camera.updateMatrixWorld(true);
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
 // The existing frame scheduler owns both forms. No CSS animation, RAF or second timer.
 const atlas = await loadDesktopFaces();
 let faceTexture: THREE.Texture | undefined;
 let pendingTexture: THREE.Texture | undefined;
 const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: faceTexture, transparent: true, depthTest: false, depthWrite: false }));
 head.visible = false; head.renderOrder = 10; scene.add(head);
 let form: DesktopForm = "3d", transition = false;
 const paintHead = () => {
  if (!atlas || !faceTexture || !choice) return;
  const glitch = atlas.manifest.animations["glitch-transition"];
  const duration = glitch?.frames.reduce((sum, f) => sum + Math.max(34, f.durationMs), 0) ?? 0;
  if (transition && elapsed * 1000 >= duration) transition = false;
  const animation = transition ? "glitch-transition" : choice.face?.animation;
  const clip = animation ? atlas.manifest.animations[animation] : undefined;
  const f = faceFrame(clip, elapsed * 1000, transition);
  head.visible = headVisible(form, transition, Boolean(f));
  if (current) current.scene.visible = form !== "face" || !f;
  if (!f || !clip || !head.visible) return;
  faceTexture.repeat.set(f.width / atlas.manifest.width, f.height / atlas.manifest.height);
  faceTexture.offset.set(f.x / atlas.manifest.width, 1 - (f.y + f.height) / atlas.manifest.height);
  const size = (camera.top - camera.bottom) * (form === "face" || transition ? 112 : 76) / 340;
  head.scale.set(size * f.width / clip.canvas.width, size * f.height / clip.canvas.height, 1);
  const topPx = choice.perch ? PERCH_SEAT_Y - (form === "face" || transition ? 112 : 76) : 12;
  const offsetX = (f.offsetX + f.width / 2 - clip.canvas.width / 2) * size / clip.canvas.width;
  const offsetY = (f.offsetY + f.height / 2 - clip.canvas.height / 2) * size / clip.canvas.height;
  head.position.set(camera.position.x + (form === "face" ? 0 : camera.right * 0.57) + offsetX, camera.position.y + camera.top - size / 2 - (camera.top - camera.bottom) * topPx / 340 - offsetY, camera.position.z - 1);
 };
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
 const framing = new WeakMap<THREE.Object3D, ReturnType<typeof createFramingSampler>>();
 const batteryApi = navigator as Navigator & { getBattery?: () => Promise<EventTarget & { charging: boolean }> };
 let batteryState: (EventTarget & { charging: boolean }) | undefined;
 const batteryChanged = () => { battery = batteryState?.charging === false; resume(); };
 void batteryApi.getBattery?.().then(state => { if (disposed) return; batteryState = state; state.addEventListener("chargingchange", batteryChanged); batteryChanged(); }).catch(() => {});
 const home = new THREE.Vector3();
 let queue = Promise.resolve();
 const scheduler = new FrameScheduler(delta => tick(delta));
 const stop = () => scheduler.dispose();
 const alignSeat = () => {
  if (!choice?.perch || !current) return;
  const left = current.scene.getObjectByName("Muslo_izquierdo");
  const right = current.scene.getObjectByName("Muslo_derecho");
  if (!left || !right) return;
  current.scene.updateMatrixWorld(true);
  const hip = left.getWorldPosition(new THREE.Vector3()).add(right.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
  camera.position.x = hip.x; camera.position.y = perchCameraY(hip.y, camera.top);
  camera.lookAt(hip.x, camera.position.y, hip.z);
 };
 const frame = (forceMask = false, silhouette = true) => {
  if (disposed || !visible || !current) return;
  alignSeat();
  paintHead();
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
  pendingTexture?.dispose(); head.material.dispose();
  renderer.dispose();
 };
 try {
  const base = await parse(options.base);
  injectLegs(base.scene);
  framing.set(base.scene, createFramingSampler(base.scene));
  players.set(base.scene, createPosePlayer(base.scene));
  cache.set("roja.glb", base);
  face = attachFace(base.scene);
 }
 catch (error) { dispose(); throw error; }
 // Never wait for an image decode before the model can render (including offline/absent assets).
 if (atlas) pendingTexture = new THREE.TextureLoader().load(atlas.href, texture => {
  if (disposed) { texture.dispose(); return; }
  texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false; texture.colorSpace = THREE.SRGBColorSpace;
  faceTexture = texture; head.material.map = texture; head.material.needsUpdate = true; resume();
 }, undefined, () => { /* A broken atlas leaves the visible 3D unchanged. */ });
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
     framing.set(gltf.scene, createFramingSampler(gltf.scene));
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
    current = gltf; currentName = name;
    const nextForm = next.face?.form ?? "3d";
    transition = Boolean(!reduced && faceTexture && transitionFace(form, nextForm)); form = nextForm;
    choice = next;
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
    const clip = !procedural ? next.clip ? gltf.animations.find(clip => clip.name === next.clip) : next.once ? gltf.animations[0] : undefined : undefined;
    const bounds = framing.get(gltf.scene)!([...(procedural ? [procedural] : []), ...(following ? [following] : [])], clip, next.start, next.end);
    if (procedural && player) { player.play(procedural); if (reduced) player.update(0.3); }
    // Alternate models are authored poses; don't animate an arbitrary clip.
    action = clip ? mixer.clipAction(clip) : undefined;
    if (action) {
     action.setLoop(next.once ? THREE.LoopOnce : THREE.LoopRepeat, next.once ? 1 : Infinity);
     action.clampWhenFinished = true;
     action.play(); mixer.update(0);
     if (next.start) mixer.setTime(next.start);
    }
    gltf.scene.updateMatrixWorld(true);
    // A stable frame for the entire gesture and its following rest pose, never its first frame.
    fitPoseCamera(camera, bounds, Boolean(next.perch));
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
