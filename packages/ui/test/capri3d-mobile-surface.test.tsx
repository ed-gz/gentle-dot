import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MobileAtlas } from '../src/capri3d/MobileAtlas.tsx';
import type { MobileAtlas as Atlas } from '../src/capri3d/mobile-atlas.ts';
import type { CapriBehavior } from '@gentle-dot/theme-capri/behavior';

const behavior: CapriBehavior = { state: 'idle', animation: 'idle', target: 'stay' };
const atlas: Atlas = { width: 4, height: 2, image: 'companion/capri-3d-core-v1.png', animations: {
 idle: { canvas: { width: 4, height: 6 }, frames: [0, 2].map(x => ({ x, y: 0, width: 2, height: 2, offsetX: 1, offsetY: 2, durationMs: 83 })) },
} };
afterEach(() => { cleanup();vi.useRealTimers(); });
it('keeps 2D when optional personal assets are missing', async () => {
 render(<MobileAtlas behavior={behavior} playing fallback={<span>2D</span>} load={async () => { throw new Error('missing'); }} />);
 await act(async () => {});
 expect(screen.getByText('2D')).toBeTruthy();
});
it('selects loaded atlas, advances frames, holds while paused and recovers on image error', async () => {
 vi.useFakeTimers();
 const load = async () => atlas;
 const view = render(<MobileAtlas behavior={behavior} playing fallback={<span>2D</span>} load={load} />);
 await act(async () => {});
 expect(view.container.querySelector('[data-animation="3d-idle"]')).toBeTruthy();
 act(() => vi.advanceTimersByTime(83));
 expect(view.container.querySelector('[data-frame="1"]')).toBeTruthy();
 view.rerender(<MobileAtlas behavior={behavior} playing={false} fallback={<span>2D</span>} load={load} />);
 act(() => vi.advanceTimersByTime(1000));
 expect(view.container.querySelector('[data-frame="1"]')).toBeTruthy();
 act(() => view.container.querySelector('image')!.dispatchEvent(new Event('error')));
 expect(screen.getByText('2D')).toBeTruthy();
});
it('falls back for a missing animation instead of presenting an unrelated action', async () => {
 render(<MobileAtlas behavior={{ ...behavior, state: 'done' }} playing fallback={<span>2D</span>} load={async () => atlas} />);
 await act(async () => {});
 expect(screen.getByText('2D')).toBeTruthy();
});
