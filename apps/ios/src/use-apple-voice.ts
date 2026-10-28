import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceControls, VoicePhase } from '@gentle-dot/ui/src/useVoice.ts';
import { checkVoice, startVoice, stopVoice, cancelVoice, type VoiceAvailability } from './perception.ts';

/** Session dictation is an Apple transcript left in the composer for review. */
export function useAppleVoice(enabled: boolean): VoiceControls {
  const [availability, setAvailability] = useState<VoiceAvailability>();
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [note, setNote] = useState<string>();
  const [draft, setDraft] = useState<VoiceControls['draft']>();
  const owner = useRef({ epoch: 0, session: '', pending: false, enabled });
  owner.current.enabled = enabled;
  const cancel = useCallback(() => {
    const state = owner.current;
    const hadCapture = Boolean(state.session || state.pending);
    state.epoch++; state.session = ''; state.pending = false;
    setPhase('idle'); setElapsed(0); setDraft(undefined);
    if (hadCapture) void cancelVoice().catch(() => {});
  }, []);
  useEffect(() => {
    let live = true;
    if (enabled) void checkVoice().then(value => { if (live) setAvailability(value); }).catch(error => { if (live) setNote(String(error.message)); });
    else cancel();
    return () => { live = false; cancel(); };
  }, [enabled, cancel]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) cancel(); };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [cancel]);
  const stop = useCallback(() => {
    const state = owner.current;
    if (!state.session || state.pending) return;
    const id = state.session, epoch = state.epoch;
    state.pending = true; setPhase('transcribing');
    void stopVoice(id).then(value => {
      if (state.epoch === epoch && state.enabled) setDraft({ id: epoch, text: value.text });
    }).catch(error => { if (state.epoch === epoch) setNote(error.message); }).finally(() => {
      if (state.epoch === epoch) { state.pending = false; state.session = ''; setPhase('idle'); }
    });
  }, []);
  useEffect(() => {
    if (phase !== 'recording') return;
    const started = performance.now();
    const timer = setInterval(() => { const seconds = Math.floor((performance.now() - started) / 1000); setElapsed(seconds); if (seconds >= 85) stop(); }, 250);
    return () => clearInterval(timer);
  }, [phase, stop]);
  const start = useCallback(() => {
    const state = owner.current;
    if (!state.enabled || state.pending || state.session || !availability?.available) return;
    const epoch = ++state.epoch; state.pending = true; setNote(undefined); setDraft(undefined);
    void startVoice().then(value => {
      if (state.epoch !== epoch || !state.enabled) return;
      state.session = value.sessionId; setElapsed(0); setPhase('recording');
    }).catch(error => { if (state.epoch === epoch) setNote(error.message); }).finally(() => { if (state.epoch === epoch) state.pending = false; });
  }, [availability]);
  return { mic: availability?.available ? { available: true } : { available: false, reason: note ?? 'El dictado necesita SpeechAnalyzer disponible en este iPhone.' },
    phase, elapsed, level: 0, partial: '', note, draft, start, stop, cancel,
    draftTaken: id => setDraft(value => value?.id === id ? undefined : value),
    speaking: false, muted: true, stopSpeaking() {}, setMuted() {}, typed() {}, sent() {}, sendOnStop: false, setSendOnStop() {} };
}
