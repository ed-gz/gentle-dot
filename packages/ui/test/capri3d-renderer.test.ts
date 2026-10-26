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
it("renders no idle loop, caps gestures to 30fps and stops hidden/reduced-motion", async () => {
 const mask = vi.fn(); const failure = vi.fn();
 const renderer = await createRenderer({ canvas: document.createElement("canvas"), base: bytes(), read: async () => bytes(), mask, failure });
 renderer.visibility(true, false);
 await renderer.choose({ model: "roja.glb", clip: "Flotar_en_reposo" });
 const idleFrames = gpu.render.mock.calls.length;
 vi.advanceTimersByTime(2000); expect(gpu.render).toHaveBeenCalledTimes(idleFrames);
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
 vi.advanceTimersByTime(5000); expect(gpu.render).toHaveBeenCalledTimes(frames);
 await expect(renderer.choose({ model: "roja_inclinada.glb", clip: null })).resolves.toBeUndefined();
 renderer.dispose();
});
it("animates an authored travelling pose only until arrival and refreshes its silhouette", async () => {
 const mask = vi.fn();
 const renderer = await createRenderer({ canvas: document.createElement("canvas"), base: bytes(), read: async () => bytes(), mask, failure: vi.fn() });
 renderer.visibility(true, false);
 await renderer.choose({ model: "roja_flotando.glb", clip: null, motion: "walk", direction: -1, duration: 600 });
 gpu.render.mockClear();
 vi.advanceTimersByTime(700);
 expect(gpu.render).toHaveBeenCalled();
 const frames = gpu.render.mock.calls.length;
 vi.advanceTimersByTime(2000);
 expect(gpu.render).toHaveBeenCalledTimes(frames);
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
it("rejects an external resource before GLTFLoader can request it", async () => {
 const json = new TextEncoder().encode('{"buffers":[{"uri":"https://invalid.test/model.bin"}]}');
 const buffer = new ArrayBuffer(20 + json.length); const view = new DataView(buffer);
 view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(12, json.length, true); view.setUint32(16, 0x4e4f534a, true);
 new Uint8Array(buffer, 20).set(json);
 await expect(createRenderer({ canvas: document.createElement("canvas"), base: buffer, read: vi.fn(), mask: vi.fn(), failure: vi.fn() })).rejects.toThrow("External GLB resource");
 expect(gpu.parse).not.toHaveBeenCalled(); expect(gpu.dispose).toHaveBeenCalledOnce();
});
