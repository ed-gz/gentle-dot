import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as THREE from "three";
const gpu = vi.hoisted(() => ({ render: vi.fn(), dispose: vi.fn(), reads: vi.fn(), parse: vi.fn() }));
vi.mock("three", async importOriginal => {
 const actual = await importOriginal<typeof import("three")>();
 return { ...actual, WebGLRenderer: class {
  setPixelRatio() {} setSize() {} setClearColor() {} setRenderTarget() {}
  render = gpu.render; dispose = gpu.dispose;
  readRenderTargetPixels(_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown, pixels: Uint8Array) {
   gpu.reads(); pixels.fill(0); pixels[3] = 255;
  }
 } };
});
vi.mock("three/addons/loaders/GLTFLoader.js", () => ({ GLTFLoader: class { parseAsync = gpu.parse; } }));
vi.mock("../src/capri3d/desktop-faces.ts", async original => ({
 ...await original<typeof import("../src/capri3d/desktop-faces.ts")>(), loadDesktopFaces: vi.fn(async () => undefined),
}));
import { loadDesktopFaces } from "../src/capri3d/desktop-faces.ts";
import { createRenderer } from "../src/capri3d/renderer.ts";
function bytes() {
 const json = new TextEncoder().encode('{"asset":{"version":"2.0"}}  ');
 const buffer = new ArrayBuffer(20 + json.length);
 const view = new DataView(buffer);
 view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true);
 view.setUint32(12, json.length, true); view.setUint32(16, 0x4e4f534a, true);
 new Uint8Array(buffer, 20).set(json); return buffer;
}
function model() {
 const scene = new THREE.Group();
 scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial()));
 return { scene, animations: ["Pensar", "Flotar_en_reposo", "Reir", "Saludar_y_teletransportarse"].map(name => new THREE.AnimationClip(name, name.startsWith("Saludar") ? 10 : 1, [])) };
}
beforeEach(() => {
 vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
 vi.clearAllMocks(); gpu.parse.mockImplementation(async () => model());
});
afterEach(() => vi.useRealTimers());
it("renders continuous idle, caps gestures to 30fps and stops hidden/reduced-motion", async () => {
 const mask = vi.fn(); const failure = vi.fn();
 const renderer = await createRenderer({ canvas: document.createElement("canvas"), base: bytes(), read: async () => bytes(), mask, failure });
 renderer.visibility(true, false);
 await renderer.choose({ model: "roja.glb", clip: "Flotar_en_reposo" });
 const idleFrames = gpu.render.mock.calls.length;
 vi.advanceTimersByTime(2000); expect(gpu.render.mock.calls.length - idleFrames).toBeGreaterThan(50);
 expect(gpu.render.mock.calls.length - idleFrames).toBeLessThanOrEqual(64);
 await renderer.choose({ model: "roja.glb", clip: "Pensar" });
 gpu.render.mockClear(); mask.mockClear();
 vi.advanceTimersByTime(1000);
 // Each mask sample renders once more into a readback target; normal frames remain <=30.
 expect(gpu.render.mock.calls.length).toBeLessThanOrEqual(33);
 expect(mask.mock.calls.length).toBeLessThanOrEqual(2);
 renderer.visibility(false, false); gpu.render.mockClear();
 vi.advanceTimersByTime(1000); expect(gpu.render).not.toHaveBeenCalled();
 renderer.visibility(true, true); gpu.render.mockClear();
 vi.advanceTimersByTime(1000); expect(gpu.render).not.toHaveBeenCalled();
 renderer.dispose(); expect(failure).not.toHaveBeenCalled(); expect(gpu.dispose).toHaveBeenCalledOnce();
});
it("keeps idle lively with bounded silhouette readbacks and cancels when hidden", async () => {
 const renderer = await createRenderer({ canvas: document.createElement("canvas"), base: bytes(), read: async () => bytes(), mask: vi.fn(), failure: vi.fn() });
 renderer.visibility(true, false);
 await renderer.choose({ model: "roja.glb", clip: "Flotar_en_reposo" });
 gpu.render.mockClear(); gpu.reads.mockClear();
 vi.advanceTimersByTime(4340);
 expect(gpu.render.mock.calls.length).toBeGreaterThan(120);
 expect(gpu.render.mock.calls.length).toBeLessThanOrEqual(139);
 expect(gpu.reads.mock.calls.length).toBeLessThanOrEqual(9);
 renderer.visibility(false, false); gpu.render.mockClear();
 vi.advanceTimersByTime(20_000); expect(gpu.render).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
 renderer.visibility(true, true); gpu.render.mockClear();
 vi.advanceTimersByTime(20_000); expect(gpu.render).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
 renderer.dispose();
});
it("steps the base body during travel and clears the offsets on arrival", async () => {
 const base = model(); gpu.parse.mockResolvedValueOnce(base);
 const renderer = await createRenderer({ canvas: document.createElement("canvas"), base: bytes(), read: async () => bytes(), mask: vi.fn(), failure: vi.fn() });
 renderer.visibility(true, false);
 await renderer.choose({ model: "roja.glb", clip: "Flotar_en_reposo", motion: "walk", direction: -1, duration: 600 });
 vi.advanceTimersByTime(100);
 expect(base.scene.rotation.y).toBeLessThan(0);
 vi.advanceTimersByTime(600);
 expect(base.scene.position.y).toBe(0); expect(base.scene.rotation.y).toBe(0);
 renderer.dispose(); expect(vi.getTimerCount()).toBe(0);
});
it("keeps only two models total, base plus the visible alternate", async () => {
 const read = vi.fn(async () => bytes());
 const renderer = await createRenderer({ canvas: document.createElement("canvas"), base: bytes(), read, mask: vi.fn(), failure: vi.fn() });
 await renderer.choose({ model: "roja_inclinada.glb", clip: null });
 await renderer.choose({ model: "roja_recostada_cerrados.glb", clip: null });
 await renderer.choose({ model: "roja_inclinada.glb", clip: null });
 expect(read).toHaveBeenCalledTimes(3);
 await renderer.choose({ model: "roja_sentada.glb", clip: null });
 await renderer.choose({ model: "roja_recostada_cerrados.glb", clip: null });
 expect(read).toHaveBeenCalledTimes(5);
 await renderer.choose({ model: "roja.glb", clip: "Pensar" });
 expect(read).toHaveBeenCalledTimes(5); renderer.dispose();
});
it("stops the attention wave before teleport and falls back to base when an alternate is missing", async () => {
 const renderer = await createRenderer({ canvas: document.createElement("canvas"), base: bytes(), read: async () => { throw Error("missing"); }, mask: vi.fn(), failure: vi.fn() });
 renderer.visibility(true, false);
 await renderer.choose({ model: "roja.glb", clip: "Saludar_y_teletransportarse", once: true, end: 3 });
 vi.advanceTimersByTime(3500); const frames = gpu.render.mock.calls.length;
 vi.advanceTimersByTime(5000); expect(gpu.render.mock.calls.length - frames).toBeLessThanOrEqual(160);
 expect(gpu.render.mock.calls.length).toBeGreaterThan(frames);
 await expect(renderer.choose({ model: "roja_inclinada.glb", clip: null })).resolves.toBeUndefined();
 renderer.dispose();
});
it("continues visible rendering after arrival and refreshes its silhouette", async () => {
 const mask = vi.fn();
 const renderer = await createRenderer({ canvas: document.createElement("canvas"), base: bytes(), read: async () => bytes(), mask, failure: vi.fn() });
 renderer.visibility(true, false);
 await renderer.choose({ model: "roja_flotando.glb", clip: null, motion: "walk", direction: -1, duration: 600 });
 gpu.render.mockClear();
 vi.advanceTimersByTime(700);
 expect(gpu.render).toHaveBeenCalled();
 const frames = gpu.render.mock.calls.length;
 vi.advanceTimersByTime(2000);
 expect(gpu.render.mock.calls.length - frames).toBeLessThanOrEqual(64);
 expect(gpu.render.mock.calls.length).toBeGreaterThan(frames);
 expect(mask.mock.calls.length).toBeGreaterThanOrEqual(2);
 renderer.dispose();
 expect(vi.getTimerCount()).toBe(0);
});
it("moves through a transparent teleport midpoint and clears the effect on the next pose", async () => {
 const canvas = document.createElement("canvas");
 const renderer = await createRenderer({ canvas, base: bytes(), read: async () => bytes(), mask: vi.fn(), failure: vi.fn() });
 renderer.visibility(true, false);
 await renderer.choose({ model: "roja.glb", clip: "Saludar_y_teletransportarse", start: 2.85, end: 4.65, once: true, motion: "teleport", duration: 1800 });
 vi.advanceTimersByTime(900);
 expect(Number(canvas.style.opacity)).toBeLessThan(0.15);
 vi.advanceTimersByTime(1100);
 expect(Number(canvas.style.opacity)).toBe(1);
 await renderer.choose({ model: "roja.glb", clip: "Flotar_en_reposo" });
 expect(canvas.style.filter).toBe("");
 expect(canvas.style.opacity).toBe("");
 renderer.dispose();
});
it.each(["roja_sentada.glb", "roja_recostada_cerrados.glb"] as const)("animates the authored rest pose %s, not just its render count, without rAF", async name => {
 const base = model(), resting = model();
 resting.scene.position.set(2, 3, 4);
 gpu.parse.mockResolvedValueOnce(base).mockResolvedValueOnce(resting);
 const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => { throw Error("No compositor frame callback"); });
 const renderer = await createRenderer({ canvas: document.createElement("canvas"), base: bytes(), read: async () => bytes(), mask: vi.fn(), failure: vi.fn() });
 try {
  renderer.visibility(true, false);
  await renderer.choose({ model: name, clip: null });
  const initial = resting.scene.position.clone();
  vi.advanceTimersByTime(510);
  expect(resting.scene.position.y).not.toBe(initial.y);
  expect(resting.scene.position.y).toBeGreaterThan(3);
  expect(resting.scene.position.y).toBeLessThanOrEqual(3.025);
  expect(resting.scene.rotation.z).not.toBe(0);
  expect(resting.scene.position.x).toBe(2);
  expect(resting.scene.position.z).toBe(4);
  const first = resting.scene.position.clone();
  vi.advanceTimersByTime(510);
  expect(resting.scene.position.y).not.toBe(first.y);
  renderer.visibility(false, false);
  const hidden = resting.scene.position.clone();
  vi.advanceTimersByTime(1000);
  expect(resting.scene.position.equals(hidden)).toBe(true);
  renderer.visibility(true, true);
  vi.advanceTimersByTime(1000);
  expect(resting.scene.position.equals(hidden)).toBe(true);
  await renderer.choose({ model: "roja.glb", clip: "Flotar_en_reposo" });
  expect(resting.scene.position.equals(initial)).toBe(true);
  await renderer.choose({ model: name, clip: null });
  expect(resting.scene.position.equals(initial)).toBe(true);
  expect(resting.scene.rotation.z).toBe(0);
  expect(raf).not.toHaveBeenCalled();
 } finally { renderer.dispose(); raf.mockRestore(); }
 expect(vi.getTimerCount()).toBe(0);
});
it("keeps the seated hip on the native border anchor throughout sitting and idle", async () => {
 const base = model();
 const root = new THREE.Bone(); root.name = "Raiz"; base.scene.add(root);
 for (const [name, x] of [["Muslo_izquierdo", -0.1], ["Muslo_derecho", 0.1]] as const) {
  const bone = new THREE.Bone(); bone.name = name; bone.position.set(x, 0.2, 0); root.add(bone);
 }
 gpu.parse.mockResolvedValueOnce(base);
 const renderer = await createRenderer({ canvas: document.createElement("canvas"), base: bytes(), read: async () => bytes(), mask: vi.fn(), failure: vi.fn() });
 try {
  renderer.visibility(true, false);
  await renderer.choose({ model: "roja.glb", clip: null, procedural: "sentada", perch: true });
  for (const duration of [0, 300, 900, 1000]) {
   vi.advanceTimersByTime(duration);
   const camera = gpu.render.mock.calls.at(-1)![1] as THREE.Camera;
   camera.updateMatrixWorld(true);
   const hip = base.scene.getObjectByName("Muslo_izquierdo")!.getWorldPosition(new THREE.Vector3()).add(base.scene.getObjectByName("Muslo_derecho")!.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5).project(camera);
   expect((1 - hip.y) * 170).toBeCloseTo(244);
   expect(root.rotation.z).toBeLessThan(0.1); // seated, never the upside-down colgada clip.
  }
 } finally { renderer.dispose(); }
});
it("shares one render owner for heads, metamorphosis in both directions, and 3D fallback", async () => {
 const frame = (x: number) => ({ x, y: 0, width: 20, height: 20, offsetX: 0, offsetY: 0, durationMs: 100 });
 vi.mocked(loadDesktopFaces).mockResolvedValueOnce({ href: "fixture.png", manifest: { width: 100, height: 20, animations: {
  "glitch-transition": { canvas: { width: 20, height: 20 }, frames: [frame(0), frame(20)] },
  "typing-watch": { canvas: { width: 20, height: 20 }, frames: [frame(40)] },
 } } });
 const texture = new THREE.Texture(document.createElement("img"));
 const load = vi.spyOn(THREE.TextureLoader.prototype, "load").mockImplementation((_url, ready) => { ready?.(texture); return texture; });
 const base = model(); gpu.parse.mockResolvedValueOnce(base);
 const renderer = await createRenderer({ canvas: document.createElement("canvas"), base: bytes(), read: async () => bytes(), mask: vi.fn(), failure: vi.fn() });
 try {
  renderer.visibility(true, false);
  await renderer.choose({ model: "roja.glb", clip: null, face: { form: "face", animation: "typing-watch" } });
  const scene = gpu.render.mock.calls.at(-1)![0] as THREE.Scene;
  const head = scene.children.find(child => child instanceof THREE.Sprite) as THREE.Sprite;
  expect(head.visible).toBe(true); expect(base.scene.visible).toBe(false);
  expect(texture.offset.x).toBe(0); // 3D -> face uses metamorphosis first.
  vi.advanceTimersByTime(250); expect(texture.offset.x).toBe(0.4);
  await renderer.choose({ model: "roja.glb", clip: null, face: { form: "3d" } });
  expect(texture.offset.x).toBe(0); expect(base.scene.visible).toBe(true);
  vi.advanceTimersByTime(250); expect(head.visible).toBe(false);
  expect(vi.getTimerCount()).toBe(1);
  renderer.visibility(false, false); gpu.render.mockClear();
  vi.advanceTimersByTime(2000); expect(gpu.render).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
 } finally { renderer.dispose(); load.mockRestore(); }
});
it("rejects an external resource before GLTFLoader can request it", async () => {
 const json = new TextEncoder().encode('{"buffers":[{"uri":"https://invalid.test/model.bin"}]}');
 const buffer = new ArrayBuffer(20 + json.length); const view = new DataView(buffer);
 view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(12, json.length, true); view.setUint32(16, 0x4e4f534a, true);
 new Uint8Array(buffer, 20).set(json);
 await expect(createRenderer({ canvas: document.createElement("canvas"), base: buffer, read: vi.fn(), mask: vi.fn(), failure: vi.fn() })).rejects.toThrow("External GLB resource");
 expect(gpu.parse).not.toHaveBeenCalled(); expect(gpu.dispose).toHaveBeenCalledOnce();
});
