#!/usr/bin/env node
// Personal build tool: source GLBs and every derived byte stay outside version control.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, '.cache/capri3d-atlases');
const models = join(homedir(), '.local/share/dev.gentleman.gentle-dot/capri-3d');
const three = join(root, 'packages/ui/node_modules/three');
const allowedModels = ['roja.glb', 'roja_inclinada.glb', 'roja_recostada_cerrados.glb'];
// Fixed, walk-free choices mirror mapping.ts. No teleport, dance or random travel clips.
const choices = [
 { name: 'idle', model: 'roja.glb', clip: 'Flotar_en_reposo' },
 { name: 'thinking', model: 'roja.glb', clip: 'Pensar' },
 { name: 'talking', model: 'roja.glb', clip: 'Hablar' },
 { name: 'laughing', model: 'roja.glb', clip: 'Reir' },
 { name: 'greeting', model: 'roja.glb', clip: 'Saludar_y_teletransportarse', end: 3 },
 { name: 'typing', model: 'roja_inclinada.glb', clip: null },
 { name: 'error', model: 'roja_recostada_cerrados.glb', clip: null },
];
for (const model of allowedModels) {
 const bytes = await readFile(join(models, model));
 if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) throw new Error('Invalid GLB');
 const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
 for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])])
  if (resource.uri && !resource.uri.startsWith('data:')) throw new Error('External GLB resource rejected');
}
await mkdir(join(output, 'browser-temp'), { recursive: true });
process.env.TMPDIR = join(output, 'browser-temp');
const server = createServer(async (request, response) => {
 try {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') {
   response.setHeader('Content-Type', 'text/html');
   response.end('<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>');return;
  }
  let file;
  if (path === '/atlas.mjs') file = join(root, 'scripts/capri3d/atlas.mjs');
  else if (allowedModels.includes(path.slice(1))) file = join(models, path.slice(1));
  else if (/^\/three\/(build|examples\/jsm)\/[a-zA-Z0-9_./-]+\.js$/.test(path) && !path.includes('..')) file = join(three, path.slice(7));
  else { response.writeHead(404);response.end();return; }
  response.setHeader('Content-Type', file.endsWith('.glb') ? 'model/gltf-binary' : 'text/javascript');
  response.end(await readFile(file));
 } catch { response.writeHead(500);response.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
 browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
 const page = await browser.newPage();
 page.on('console', message => console.log(message.text()));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const result = await page.evaluate(async choices => {
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { packFrames } = await import('/atlas.mjs');
  const width = 192, height = 272, fps = 12;
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);renderer.setSize(width, height);renderer.setClearColor(0, 0);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x686280, 2));
  const light = new THREE.DirectionalLight(0xffffff, 2);light.position.set(-3, 6, 8);scene.add(light);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
  const loader = new GLTFLoader(), cache = new Map(), frames = [];
  const capture = document.createElement('canvas');capture.width = width;capture.height = height;
  const context = capture.getContext('2d', { willReadFrequently: true });
  for (const choice of choices) {
   let gltf = cache.get(choice.model);
   if (!gltf) { gltf = await loader.loadAsync('/' + choice.model);cache.set(choice.model, gltf); }
   gltf.scene.traverse(object => {
    if (!object.isMesh) return;
    object.frustumCulled = false;
    for (const material of Array.isArray(object.material) ? object.material : [object.material])
     for (const value of Object.values(material)) if (value?.isTexture) {
      value.magFilter = value.minFilter = THREE.NearestFilter;value.generateMipmaps = false;value.needsUpdate = true;
     }
   });
   scene.add(gltf.scene);
   const mixer = new THREE.AnimationMixer(gltf.scene);
   const clip = choice.clip ? gltf.animations.find(clip => clip.name === choice.clip) : null;
   if (choice.clip && !clip) throw new Error('Missing clip ' + choice.clip);
   const duration = clip ? Math.min(choice.end ?? clip.duration, clip.duration) : 0;
   if (duration > 10) throw new Error('Clip exceeds native 120-frame bound: ' + choice.clip);
   const count = clip ? Math.max(1, Math.ceil(duration * fps)) : 1;
   if (clip) { const action = mixer.clipAction(clip);action.setLoop(THREE.LoopOnce, 1);action.clampWhenFinished = true;action.play(); }
   // Fit the complete gesture, not just its first frame; never recenter per frame.
   const bounds = new THREE.Box3();
   for (let i = 0; i < count; i++) {
    mixer.setTime(i / fps);gltf.scene.updateMatrixWorld(true);bounds.union(new THREE.Box3().setFromObject(gltf.scene, true));
   }
   const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
   const half = Math.max(size.y * .62, size.x * .62 * height / width, .1);
   camera.left = -half * width / height;camera.right = -camera.left;camera.top = half;camera.bottom = -half;
   camera.position.set(center.x, center.y, center.z + Math.max(size.z, half) * 4);camera.lookAt(center);camera.updateProjectionMatrix();
   for (let i = 0; i < count; i++) {
    mixer.setTime(i / fps);renderer.render(scene, camera);
    context.clearRect(0, 0, width, height);context.drawImage(renderer.domElement, 0, 0);
    frames.push({ name: choice.name, width, height, rgba: context.getImageData(0, 0, width, height).data, durationMs: clip ? 83 : 1000 });
   }
   console.log(`${choice.name}: ${count} frames (${duration.toFixed(3)} s)`);
   mixer.stopAllAction();mixer.uncacheRoot(gltf.scene);scene.remove(gltf.scene);
  }
  const { manifest, frames: packed } = packFrames(frames, 'companion/capri-3d-core-v1.png');
  const atlas = document.createElement('canvas');atlas.width = manifest.width;atlas.height = manifest.height;
  const ctx = atlas.getContext('2d');
  for (const frame of packed) ctx.putImageData(new ImageData(frame.rgba, frame.width, frame.height), frame.x, frame.y);
  renderer.dispose();
  return { manifest, png: atlas.toDataURL('image/png').split(',')[1] };
 }, choices);
 await writeFile(join(output, 'capri-3d-core-v1.png'), Buffer.from(result.png, 'base64'));
 // Manifest last: consumers never see a new manifest before its PNG exists.
 await writeFile(join(output, 'capri-3d-core-v1.json'), JSON.stringify(result.manifest));
 for (const extension of ['json', 'png']) {
  const file = join(output, `capri-3d-core-v1.${extension}`);
  console.log(`${file}: ${(await stat(file)).size} bytes`);
 }
} finally { await browser?.close();await new Promise(done => server.close(done)); }
