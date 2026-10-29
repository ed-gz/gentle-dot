import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { INTRO_BEATS, IntroDriver, type IntroBeat } from '@gentle-dot/ui/src/capri2d/intro.ts';
import { CapriPossession, crackedBorder } from '@gentle-dot/ui/src/capri2d/CapriPossession.tsx';
import './companion-theater.css';

/** One in-app animation layer. It never intercepts input, touches a system
 * window, or uses a second image of Capri. The existing 2D rig supplies her
 * gestures through onGesture; the screen effect is procedural geometry. */
export function createCompanionTheater(options: {
  canPlay(): boolean;
  onGesture?(name: 'estirarse' | 'guino' | 'saludar' | 'transformarse' | 'salto'): void;
  onFinish?(reason: 'complete' | 'interrupted'): void;
}) {
  const driver = new IntroDriver();
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let layer: HTMLDivElement | undefined;
  let root: Root | undefined;
  let frame = 0, started = 0, mode: 'intro' | 'possession' | undefined;
  let lastBeat: IntroBeat | undefined, lastPossession = -Infinity, replay = 0;
  let destroyed = false;
  const safe = () => {
    if (destroyed || document.hidden || motion.matches) return false;
    try { return options.canPlay(); } catch { return false; }
  };
  const stop = (reason: 'complete' | 'interrupted' = 'interrupted') => {
    const wasActive = Boolean(mode);
    driver.abort(); cancelAnimationFrame(frame); frame = 0; mode = undefined;
    if (root) { root.unmount(); root = undefined; }
    layer?.remove(); layer = undefined; lastBeat = undefined;
    if (wasActive) { try { options.onFinish?.(reason); } catch { /* Presentation cleanup must finish. */ } }
  };
  const interrupted = () => stop('interrupted');
  const visibility = () => { if (document.hidden) stop(); };
  const reduce = () => { if (motion.matches) stop(); };
  document.addEventListener('pointerdown', interrupted, true);
  document.addEventListener('keydown', interrupted, true);
  document.addEventListener('focusin', interrupted, true);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('resize', interrupted);
  motion.addEventListener('change', reduce);

  const makeLayer = (kind: 'intro' | 'possession') => {
    const node = document.createElement('div');
    node.className = 'capri-theater'; node.dataset.capriTheater = kind;
    node.setAttribute('aria-hidden', 'true'); document.body.append(node);
    layer = node; mode = kind;
    return node;
  };
  const el = (name: string, attrs: Record<string, string>) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const gestures: Partial<Record<IntroBeat, 'estirarse' | 'guino' | 'saludar' | 'transformarse' | 'salto'>> = {
    haul: 'estirarse', look: 'guino', wave: 'saludar', shatter: 'transformarse', dive: 'salto',
  };
  function tickIntro(now: number) {
    if (!layer || mode !== 'intro') return;
    if (!safe()) { stop(); return; }
    const sample = driver.sample(now);
    if (sample.beat === 'done') { stop('complete'); return; }
    layer.dataset.beat = sample.beat;
    const left = layer.querySelector<SVGGElement>('.capri-theater-left');
    const right = layer.querySelector<SVGGElement>('.capri-theater-right');
    const p = sample.progress;
    const haul = sample.beat === 'haul' ? Math.sin(p * Math.PI) : 0;
    const leftX = sample.beat === 'left-hand' ? -280 * (1 - p) : 18 * haul;
    const rightX = sample.beat === 'right-hand' ? -280 * (1 - p) : 18 * haul;
    const y = -90 * haul;
    left?.setAttribute('transform', `translate(${leftX} ${y})`);
    right?.setAttribute('transform', `translate(1000 0) scale(-1 1) translate(${rightX} ${y})`);
    if (lastBeat !== sample.beat) {
      lastBeat = sample.beat;
      const gesture = gestures[sample.beat];
      if (gesture) { try { options.onGesture?.(gesture); } catch { stop(); return; } }
    }
    frame = requestAnimationFrame(tickIntro);
  }
  function tickPossession(now: number) {
    if (mode !== 'possession') return;
    if (!safe()) { stop(); return; }
    if (now - started >= 6000) { stop('complete'); return; }
    frame = requestAnimationFrame(tickPossession);
  }
  return {
    startIntro(explicitReplay = false): boolean {
      if (mode || !safe()) return false;
      started = performance.now();
      if (!driver.start(explicitReplay ? `iphone-app-replay-${++replay}` : 'iphone-app', started)) return false;
      const node = makeLayer('intro');
      const svg = el('svg', { viewBox: '0 0 1000 1000', preserveAspectRatio: 'none', focusable: 'false' });
      const border = el('polygon', { points: crackedBorder(1000, 1000), class: 'capri-theater-border' });
      const left = el('g', { class: 'capri-theater-left' });
      const right = el('g', { class: 'capri-theater-right' });
      const arm = 'M0 690 Q110 695 178 570 Q205 525 238 535';
      const hand = 'M-8 24 L-13 -8 Q-12 -18 -7 -9 L-2 2 L-3 -22 Q0 -29 4 -22 L9 -4 L12 -22 Q16 -26 19 -19 L19 0 L25 -14 Q31 -18 32 -10 L28 11 L34 4 Q43 5 37 14 L20 31 Z';
      for (const group of [left, right]) {
        group.append(el('path', { d: arm, class: 'capri-theater-arm' }));
        group.append(el('path', { d: hand, transform: 'translate(245 525) scale(2.7)', class: 'capri-theater-hand' }));
      }
      right.setAttribute('transform', 'translate(1000 0) scale(-1 1)');
      svg.append(border, left, right); node.append(svg);
      frame = requestAnimationFrame(tickIntro); return true;
    },
    startPossession(): boolean {
      const now = performance.now();
      if (mode || !safe() || now - lastPossession < 600_000) return false;
      started = now; lastPossession = now;
      const node = makeLayer('possession'); root = createRoot(node);
      root.render(createElement(CapriPossession, { started: now }));
      frame = requestAnimationFrame(tickPossession); return true;
    },
    stop,
    active: () => mode,
    destroy() {
      if (destroyed) return; destroyed = true; stop();
      document.removeEventListener('pointerdown', interrupted, true);
      document.removeEventListener('keydown', interrupted, true);
      document.removeEventListener('focusin', interrupted, true);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', interrupted);
      motion.removeEventListener('change', reduce);
    },
  };
}

// Export the shared timeline for inspection, without introducing a new one.
export { INTRO_BEATS };
