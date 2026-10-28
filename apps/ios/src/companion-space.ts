import type { Rect } from '@gentle-dot/ui/src/capri2d/roam.ts';

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width + 5 && a.x + a.width + 5 > b.x && a.y < b.y + b.height + 5 && a.y + a.height + 5 > b.y;
export const phonePositionFree = (point: Rect, occupied: Rect[]) => !occupied.some(rect => intersects(point, rect));
/** Explicit empty-space candidates; unavailable space never becomes a fallback. */
export function phonePerches(area: Rect, size: { width: number; height: number }, occupied: Rect[]): [number, number][] {
  const left = area.x + 4, right = area.x + area.width - size.width - 4;
  const top = area.y + 4, bottom = area.y + area.height - size.height - 4;
  if (right < left || bottom < top) return [];
  const points: [number, number][] = [];
  for (const ratio of [0, 1, .5, .25, .75]) for (const x of [right, left, (left + right) / 2]) {
    const y = top + (bottom - top) * ratio;
    if (phonePositionFree({ x, y, ...size }, occupied)) points.push([x, y]);
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
  // Above the bound, opt out of roaming instead of claiming unexamined space is empty.
  if (count >= 3000) return [{ x: 0, y: 0, width: area.width, height: area.height }];
  return rects;
}
