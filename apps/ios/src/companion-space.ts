import type { Rect } from '@gentle-dot/ui/src/capri2d/roam.ts';

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width + 5 && a.x + a.width + 5 > b.x && a.y < b.y + b.height + 5 && a.y + a.height + 5 > b.y;
export const phonePositionFree = (point: Rect, occupied: Rect[]) => !occupied.some(rect => intersects(point, rect));
/** Explicit empty-space candidates; unavailable space never becomes a fallback. */
export function phonePerches(area: Rect, size: { width: number; height: number }, occupied: Rect[]): [number, number][] {
  const left = area.x + 4, right = area.x + area.width - size.width - 4;
  const top = area.y + 4, bottom = area.y + area.height - size.height - 4;
  if (![left, right, top, bottom, size.width, size.height].every(Number.isFinite) || size.width <= 0 || size.height <= 0 || right < left || bottom < top) return [];
  const candidates: [number, number][] = [];
  const add = (x: number, y: number) => {
    x = Math.max(left, Math.min(right, x)); y = Math.max(top, Math.min(bottom, y));
    if (!Number.isFinite(x) || !Number.isFinite(y) || candidates.some(([a, b]) => Math.abs(a - x) < 1 && Math.abs(b - y) < 1)) return;
    if (phonePositionFree({ x, y, ...size }, occupied)) candidates.push([x, y]);
  };
  // More than the old three columns: narrow screens often leave a usable
  // vertical strip between bubbles even when the corners are occupied.
  for (const y of [0, 1, .5, .25, .75, .125, .875]) for (const x of [1, 0, .5, .25, .75]) {
    add(left + (right - left) * x, top + (bottom - top) * y);
  }
  // Also try immediately beside controls/text. This finds irregular gaps
  // between the grid positions without probing the pixels of the content.
  for (const rect of occupied.slice(0, 24)) {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) continue;
    const midX = rect.x + (rect.width - size.width) / 2, midY = rect.y + (rect.height - size.height) / 2;
    add(rect.x - size.width - 6, midY); add(rect.x + rect.width + 6, midY);
    add(midX, rect.y - size.height - 6); add(midX, rect.y + rect.height + 6);
  }
  // The shared director visits candidates in order. Spread successive safe
  // perches across the available area, rather than repeatedly teleporting a
  // few pixels along one edge. Keep the original preferred first position.
  const points: [number, number][] = [];
  if (candidates.length) points.push(candidates.shift()!);
  while (candidates.length && points.length < 128) {
    const last = points[points.length - 1]!;
    let farthest = 0, distance = -1;
    candidates.forEach(([x, y], i) => { const d = (x - last[0]) ** 2 + (y - last[1]) ** 2; if (d > distance) { distance = d; farthest = i; } });
    points.push(candidates.splice(farthest, 1)[0]!);
  }
  return points;
}

/** Read visible text geometry only. No content or pointer history is collected. */
export function occupiedPhoneSpace(panel: HTMLElement, area: DOMRect): Rect[] {
  const rects: Rect[] = [];
  const add = (r: DOMRect) => { if (r.width && r.height && r.bottom > area.top && r.top < area.bottom) rects.push({ x: r.left - area.left, y: r.top - area.top, width: r.width, height: r.height }); };
  for (const control of panel.querySelectorAll('button, input, textarea, select, summary, img, video, [role="button"]')) {
    if (!control.closest('[hidden], #stage')) for (const rect of control.getClientRects()) add(rect);
  }
  const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
  let count = 0;
  while (walker.nextNode() && count++ < 3000) {
    const text = walker.currentNode;
    if (!text.textContent?.trim() || text.parentElement?.closest('[hidden], #stage, script, style')) continue;
    const range = document.createRange(); range.selectNodeContents(text);
    for (const rect of range.getClientRects()) add(rect);
  }
  // Above the bound, regard the whole panel as occupied. A reserved companion
  // shelf outside that panel remains usable, without treating unexamined text
  // or controls inside the panel as empty space.
  if (count >= 3000) {
    const bounds = panel.getBoundingClientRect();
    return [{ x: bounds.left - area.left, y: bounds.top - area.top, width: bounds.width, height: bounds.height }];
  }
  return rects;
}
