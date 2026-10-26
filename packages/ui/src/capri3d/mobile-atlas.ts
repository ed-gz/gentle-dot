import type { CapriBehavior } from '@gentle-dot/theme-capri/behavior';
import { clipForBehavior } from './mapping.ts';

export interface AtlasFrame {
 x: number; y: number; width: number; height: number; offsetX: number; offsetY: number; durationMs: number;
}
export interface AtlasAnimation { canvas: { width: number; height: number }; frames: AtlasFrame[] }
export interface MobileAtlas {
 width: number; height: number; image: string; animations: Record<string, AtlasAnimation>;
}
export function atlasAnimationForBehavior(state: CapriBehavior['state'], replyKind?: 'reply' | 'reading' | 'submitted') {
 const choice = clipForBehavior({ state, animation: 'idle', target: 'stay' }, replyKind);
 if (!choice.clip) return choice.model === 'roja_inclinada.glb' ? 'typing' : 'error';
 switch (choice.clip) {
  case 'Pensar': return 'thinking';
  case 'Hablar': return 'talking';
  case 'Reir': return 'laughing';
  case 'Saludar_y_teletransportarse': return 'greeting';
  default: return 'idle';
 }
}
function object(value: unknown): Record<string, unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid manifest object');
 return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
 if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error('Invalid manifest integer');
 return value;
}
/** Validate every frame before presenting 3D; the default 2D sprite remains mounted on failure. */
export function validateAtlas(input: unknown): MobileAtlas {
 const manifest = object(input);
 const width = integer(manifest.width, 1, 4096), height = integer(manifest.height, 1, 4096);
 if (manifest.image !== 'companion/capri-3d-core-v1.png') throw new Error('Unexpected atlas image');
 const animations: Record<string, AtlasAnimation> = {};
 for (const [name, raw] of Object.entries(object(manifest.animations))) {
  const value = object(raw), canvas = object(value.canvas);
  const cw = integer(canvas.width, 1, 4096), ch = integer(canvas.height, 1, 4096);
  if (!Array.isArray(value.frames) || !value.frames.length || value.frames.length > 120) throw new Error('Invalid frame count');
  const frames = value.frames.map(raw => {
   const frame = object(raw);
   const x = integer(frame.x, 0, width), y = integer(frame.y, 0, height);
   const w = integer(frame.width, 1, width - x), h = integer(frame.height, 1, height - y);
   const offsetX = integer(frame.offsetX ?? 0, 0, cw - w), offsetY = integer(frame.offsetY ?? 0, 0, ch - h);
   // Generated mobile sheets contain rectangular trims, not authored polygon clips.
   if (frame.clip !== undefined) throw new Error('Unexpected clipping polygon');
   return { x, y, width: w, height: h, offsetX, offsetY, durationMs: integer(frame.durationMs, 80, 60000) };
  });
  animations[name] = { canvas: { width: cw, height: ch }, frames };
 }
 if (!animations.idle) throw new Error('Missing idle');
 return { width, height, image: manifest.image, animations };
}
export async function loadMobileAtlas(signal: AbortSignal): Promise<MobileAtlas> {
 const response = await fetch('/companion/capri-3d-core-v1.json', { signal });
 if (!response.ok) throw new Error('No personal atlas');
 const text = await response.text();
 if (text.length > 1024 * 1024) throw new Error('Manifest too large');
 const atlas = validateAtlas(JSON.parse(text));
 await new Promise<void>((done, reject) => {
  const image = new Image();
  const finish = (error?: Error) => {
   signal.removeEventListener('abort', abort);image.onload = image.onerror = null;
   if (error) { image.src = '';reject(error); } else done();
  };
  const abort = () => finish(new Error('Atlas load cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  image.onload = () => finish(image.naturalWidth === atlas.width && image.naturalHeight === atlas.height ? undefined : new Error('Atlas dimensions differ'));
  image.onerror = () => finish(new Error('Missing atlas PNG'));
  if (signal.aborted) abort();else image.src = '/' + atlas.image;
 });
 return atlas;
}
