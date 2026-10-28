/** Measure the frame after submission: GPU/compositor stalls happen after the
 * WebGL draw call returns. Leave time for input and storage on a slow renderer. */
export function createFramePacer() {
  let submitted: number | undefined;
  let next = 0, cooldown = 0;
  return {
    ready(now: number): boolean {
      if (submitted !== undefined) {
        const elapsed = now - submitted;
        cooldown = elapsed > 50 ? Math.min(250, (elapsed - 32) * 2) : cooldown * .75;
        if (cooldown < 1) cooldown = 0;
        next = now + cooldown; submitted = undefined;
      }
      return now >= next;
    },
    submitted(now: number) { submitted = now; },
    // An intentionally cancelled frame/background interval is not GPU cost.
    // Preserve an existing cooldown so streaming updates cannot defeat pacing.
    wake() { submitted = undefined; },
  };
}
