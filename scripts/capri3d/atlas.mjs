/** Pure alpha trimming + bounded shelf packing. No GLB, browser or image library needed. */
export function packFrames(source, image, limit = 4096) {
 if (!source.length || limit < 1 || limit > 4096) throw new Error('Invalid atlas');
 const animations = {}, frames = [];
 let x = 0, y = 0, row = 0, width = 0, height = 0;
 for (const item of source) {
  const { name, width: w, height: h, rgba, durationMs } = item;
  if (!/^[a-z-]+$/.test(name) || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 ||
   w > 4096 || h > 4096 || rgba.length !== w * h * 4 || !Number.isInteger(durationMs) || durationMs < 80)
   throw new Error('Invalid frame');
  let left = w, top = h, right = -1, bottom = -1;
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) if (rgba[(py * w + px) * 4 + 3]) {
   left = Math.min(left, px); top = Math.min(top, py); right = Math.max(right, px); bottom = Math.max(bottom, py);
  }
  if (right < 0) { left = top = right = bottom = 0; }
  const fw = right - left + 1, fh = bottom - top + 1;
  if (fw > limit || fh > limit) throw new Error('Atlas overflow');
  if (x + fw > limit) { x = 0; y += row + 1; row = 0; }
  if (y + fh > limit) throw new Error('Atlas overflow');
  const animation = animations[name] ??= { canvas: { width: w, height: h }, frames: [] };
  if (animation.canvas.width !== w || animation.canvas.height !== h || animation.frames.length >= 120)
   throw new Error('Invalid animation');
  const frame = { x, y, width: fw, height: fh, offsetX: left, offsetY: top, durationMs };
  animation.frames.push(frame);
  const trimmed = new Uint8ClampedArray(fw * fh * 4);
  for (let py = 0; py < fh; py++) trimmed.set(rgba.subarray(((top + py) * w + left) * 4, ((top + py) * w + left + fw) * 4), py * fw * 4);
  frames.push({ ...frame, rgba: trimmed });
  width = Math.max(width, x + fw); height = Math.max(height, y + fh);
  row = Math.max(row, fh); x += fw + 1;
 }
 return { manifest: { width, height, image, animations }, frames };
}
