// Spawn choreography adapted from mochiiwuff/capri-desktop (MIT); see ./LICENSE.
// No upstream artwork is bundled. Times are milliseconds, not event-driven triggers.
export const INTRO_BEATS = [
 ['crackle',0],['left-hand',350],['right-hand',700],['haul',1000],
 ['impact-white',1650],['impact-ink',1710],['split',1770],['look',2050],
 ['blink',2550],['hi',2750],['wave',3550],['regrab',4350],['glance',4750],
 ['shatter',5050],['crouch',5700],['dive',6100],['unfold',7150],['done',8000],
] as const;
export type IntroBeat = typeof INTRO_BEATS[number][0];
export class IntroDriver {
 private consumed = new Set<string>();
 private began = 0;
 private ended = true;
 start(service: string, now: number, reduced = false, blocked = false): boolean {
  if (!service || this.consumed.has(service)) return false;
  this.consumed.add(service);
  this.began = now; this.ended = reduced || blocked;
  return !this.ended;
 }
 skip() { this.ended = true; }
 abort() { this.ended = true; }
 sample(now: number): {beat: IntroBeat; progress: number; elapsed: number} {
  const elapsed = Math.max(0, now-this.began);
  if (this.ended || elapsed >= 8000) return {beat:'done',progress:1,elapsed};
  let index = 0;
  while (index+1 < INTRO_BEATS.length && elapsed >= INTRO_BEATS[index+1]![1]) index++;
  const [beat, at] = INTRO_BEATS[index]!;
  const until = INTRO_BEATS[index+1]![1];
  return {beat, progress:(elapsed-at)/(until-at), elapsed};
 }
}
