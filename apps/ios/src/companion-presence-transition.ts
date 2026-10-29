import { ACTS, NEUTRAL, RigPlayer, type Drawing } from '@gentle-dot/ui/src/capri2d/acting.ts';

/** The shared PC act contains vanish, two transparent frames, and arrive.
 * Split it at the transparent interval so hiding never plays the arrival and
 * showing never replays the outgoing effect. Times come from the shared act. */
const FPS = ACTS.teleport.fps;
const transparent = ACTS.teleport.keys.findIndex(([, pose]) => 'alpha' in pose && pose.alpha === 0);
const arrive = ACTS.teleport.keys.findIndex(([, , cue]) => cue === 'arrive');
if (transparent < 0 || arrive <= transparent) throw new Error('La coreografía de presencia no tiene una transición transparente válida.');
const frameBefore = (index: number) => ACTS.teleport.keys.slice(0, index).reduce((total, [hold]) => total + hold, 0);
const vanishFrames = frameBefore(transparent), arriveFrame = frameBefore(arrive);
const totalFrames = ACTS.teleport.keys.reduce((total, [hold]) => total + hold, 0);
const milliseconds = (frames: number) => frames * 1000 / FPS;

type Transition = { target: boolean; started: number; player: RigPlayer };
export type PresenceSample = {
  /** Whether the layer should currently be drawn. The hit target should be
   * disabled throughout a transition even while the layer remains visible. */
  visible: boolean;
  transitioning: boolean;
  targetVisible: boolean;
  pose?: Drawing;
  cues: string[];
};

/** Presentation only: no timers, DOM, input mask, persistence or native work.
 * The caller supplies its existing animation clock and must sample until the
 * transition settles, even if the target is hidden. On background/context loss
 * or when motion becomes reduced, call settle() and render the final state. */
export function createPresenceTransition(initialVisible = true) {
  let target = initialVisible;
  let active: Transition | undefined;
  const settled = (): PresenceSample => ({ visible: target, transitioning: false, targetVisible: target, cues: [] });
  function sample(now: number): PresenceSample {
    if (!Number.isFinite(now)) throw new Error('El reloj de presencia no es válido.');
    if (!active) return settled();
    const elapsed = Math.max(0, now - active.started);
    const duration = milliseconds(active.target ? totalFrames - arriveFrame : vanishFrames);
    if (elapsed >= duration) { active = undefined; return settled(); }
    const { pose, cues } = active.player.advance(now);
    return { visible: true, transitioning: true, targetVisible: target, pose: { ...NEUTRAL, ...pose }, cues };
  }
  return {
    /** Consume the returned sample immediately: its cues are emitted once. */
    request(visible: boolean, now: number, animate: boolean): PresenceSample {
      if (!Number.isFinite(now)) throw new Error('El reloj de presencia no es válido.');
      if (visible === target && active && animate) return sample(now);
      if (visible === target && !active) return settled();
      target = visible;
      if (!animate) { active = undefined; return settled(); }
      const player = new RigPlayer('teleport', now - (visible ? milliseconds(arriveFrame) + 0.01 : 0));
      // An arrival begins at frame 8; suppress the earlier vanish cue while
      // retaining arrive itself. The epsilon avoids floating rounding to 8.
      if (visible) player.consume(now - milliseconds(1) - 0.01);
      active = { target: visible, started: now, player };
      return sample(now);
    },
    sample,
    settle(): PresenceSample { active = undefined; return settled(); },
  };
}
