/** The dictation preview belongs in the composer field itself, where the final
 * transcript will land, so nothing jumps when the capture ends. The mirror owns
 * the field only while its own last value is still there: any foreign edit ends
 * it instead of overwriting what the person typed. */
export type DictationMirror = { base: string; shown: string };

export function beginDictationMirror(base: string): DictationMirror {
  return { base, shown: base };
}

/** `current` is the live field value; a separator is only added after a draft
 * with visible content, matching the final insertion. */
export function nextDictationMirror(mirror: DictationMirror, current: string, partial: string, limit: number):
  { kind: 'mirror'; mirror: DictationMirror; text: string } | { kind: 'user-edited' } | { kind: 'too-long' } {
  if (current !== mirror.shown) return { kind: 'user-edited' };
  const text = `${mirror.base}${mirror.base.trim() ? '\n' : ''}${partial}`;
  if (text.length > limit) return { kind: 'too-long' };
  if (text === mirror.shown) return { kind: 'mirror', mirror, text };
  return { kind: 'mirror', mirror: { base: mirror.base, shown: text }, text };
}

/** Give the field back to the final insertion: the transcript is written once,
 * over the draft the person had before dictating. */
export function releaseDictationMirror(mirror: DictationMirror, current: string): string {
  return current === mirror.shown ? mirror.base : current;
}
