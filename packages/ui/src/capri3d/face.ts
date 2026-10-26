import * as THREE from "three";

/** Texture-space landmarks measured on the personal roja asset, not screen coordinates. */
const eyes = [[0.253, 0.307], [0.2775, 0.301]] as const;
const mouth = [0.2665, 0.3336] as const;
export interface FaceLayer { update(seconds: number, speaking: boolean, closed?: boolean): void }
/** Preserve the authored face; redraw only tiny mouth/lid patches on a private texture. */
export function attachFace(root: THREE.Object3D): FaceLayer {
 const layers: { context: CanvasRenderingContext2D; canvas: HTMLCanvasElement; image: CanvasImageSource; texture: THREE.CanvasTexture }[] = [];
 const maps = new Map<THREE.Texture, THREE.CanvasTexture>();
 root.traverse(object => {
  if (!(object instanceof THREE.Mesh)) return;
  for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
   if (!(material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshBasicMaterial) || !material.map) continue;
   const original = material.map;
   if (maps.has(original)) { material.map = maps.get(original)!; continue; }
   const image = original.image as HTMLImageElement | ImageBitmap | undefined;
   if (!image?.width || !image.height) continue;
   const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
   const context = canvas.getContext("2d");
   if (!context) continue;
   context.drawImage(image, 0, 0);
   const texture = new THREE.CanvasTexture(canvas);
   texture.flipY = original.flipY;
   texture.colorSpace = original.colorSpace;
   texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter;
   texture.generateMipmaps = false;
   material.map = texture; material.needsUpdate = true;
   maps.set(original, texture);
   layers.push({ context, canvas, image, texture });
  }
 });
 for (const original of maps.keys()) original.dispose();
 let previous = "";
 return {
  update(seconds, speaking, closed) {
   const blink = closed ?? seconds % 4.2 > 4.05;
   const opening = speaking ? Math.round((0.3 + 0.7 * Math.abs(Math.sin(seconds * 11))) * 4) : 0;
   const signature = `${blink}:${opening}`;
   if (previous === signature) return;
   previous = signature;
   for (const { context: ctx, canvas, image, texture } of layers) {
    const w = canvas.width, h = canvas.height;
    ctx.drawImage(image, 0, 0);
    if (opening) {
     const x = mouth[0] * w, y = mouth[1] * h;
     ctx.fillStyle = "#111011";
     ctx.fillRect(x - w * 0.005, y - h * 0.006, w * 0.01, h * 0.012);
     ctx.fillStyle = "#6e1935";
     ctx.beginPath(); ctx.ellipse(x, y, w * 0.0037, h * (0.001 + opening * 0.0006), 0, 0, Math.PI * 2); ctx.fill();
    }
    if (blink) for (const [u, v] of eyes) {
     ctx.fillStyle = "#04e241";
     ctx.beginPath(); ctx.ellipse(u * w, v * h, w * 0.0054, h * 0.011, 0, 0, Math.PI * 2); ctx.fill();
     ctx.strokeStyle = "#101714"; ctx.lineWidth = Math.max(1, w * 0.001);
     ctx.beginPath(); ctx.moveTo((u - 0.004) * w, v * h); ctx.lineTo((u + 0.004) * w, v * h); ctx.stroke();
    }
    texture.needsUpdate = true;
   }
  },
 };
}
