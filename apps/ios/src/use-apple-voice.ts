import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceControls, VoicePhase } from '@gentle-dot/ui/src/useVoice.ts';
import { checkVoice, prepareVoice, startVoice, stopVoice, cancelVoice, type VoiceAvailability } from './perception.ts';
import { localIdentifier } from './local-identifiers.ts';

function availabilityNote(value: VoiceAvailability): string | undefined {
  if (value.microphonePermission === 'denied') return 'Activa el micrófono para Capri en Ajustes del iPhone.';
  if (value.available || value.status === 'assets_required') return undefined;
  if (value.status === 'unsupported_language') return 'La transcripción local en español no está disponible en este iPhone.';
  if (value.status === 'os_unsupported') return 'El dictado local necesita iOS 26 o posterior.';
  if (value.status === 'device_not_supported') return 'La transcripción local no está disponible en este dispositivo.';
  return 'No pude preparar el dictado local. Cierra y vuelve a abrir esta sesión para intentarlo.';
}

/** Session dictation is an Apple transcript left in the composer for review. */
export function useAppleVoice(enabled: boolean): VoiceControls {
  const [availability, setAvailability] = useState<VoiceAvailability>();
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [note, setNote] = useState<string>();
  const [draft, setDraft] = useState<VoiceControls['draft']>();
  const owner = useRef({ epoch: 0, session: '', ownerId: '', pending: false, enabled });
  owner.current.enabled = enabled;
  const cancel = useCallback(() => {
    const state = owner.current;
    const ownerId = state.ownerId;
    state.epoch++; state.session = ''; state.ownerId = ''; state.pending = false;
    setPhase('idle'); setElapsed(0); setDraft(undefined); setNote(undefined);
    if (ownerId) void cancelVoice(ownerId).catch(() => {});
  }, []);
  useEffect(() => {
    let live = true;
    if (enabled) void checkVoice().then(value => { if (live) { setAvailability(value); setNote(availabilityNote(value)); } }).catch(error => { if (live) setNote(String(error.message)); });
    else cancel();
    return () => { live = false; cancel(); };
  }, [enabled, cancel]);
  useEffect(() => {
    // A native permission dialog may obscure the web view before a capture is
    // established. The native controller handles real background transitions.
    const hidden = () => { if (document.hidden && owner.current.session) cancel(); };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [cancel]);
  const stop = useCallback(() => {
    const state = owner.current;
    if (!state.session || state.pending) return;
    const id = state.session, epoch = state.epoch;
    state.pending = true; setPhase('transcribing');
    void stopVoice(id).then(value => {
      if (state.epoch === epoch && state.enabled) { setNote(undefined); setDraft({ id: epoch, text: value.text }); }
    }).catch(error => { if (state.epoch === epoch) setNote(error.message); }).finally(() => {
      if (state.epoch === epoch) { state.pending = false; state.session = ''; state.ownerId = ''; setPhase('idle'); }
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
    if (!state.enabled || state.pending || state.session || !(availability?.available || availability?.status === 'assets_required')) return;
    const epoch = ++state.epoch, ownerId = localIdentifier(); state.ownerId = ownerId; state.pending = true; setNote(undefined); setDraft(undefined);
    void (async () => {
      if (availability.status === 'assets_required') {
        setNote('Descargando la voz en español de Apple. Necesitas internet para esta primera preparación…');
        const prepared = await prepareVoice(ownerId);
        if (state.epoch !== epoch || !state.enabled) return;
        setAvailability(prepared);
        if (!prepared.available) throw new Error('Apple aún no terminó de preparar la voz. Comprueba la conexión y vuelve a intentarlo.');
      }
      setNote('Iniciando el micrófono. Si iOS pide permiso, acéptalo para dictar.');
      const value = await startVoice(ownerId);
      // cancel() already reached the native controller; a late second global
      // cancellation could stop a newer session in the main conversation.
      if (state.epoch !== epoch || !state.enabled) return;
      state.session = value.sessionId; setElapsed(0); setPhase('recording');
      setNote('Grabando. Toca el micrófono otra vez para revisar la transcripción.');
    })().catch(error => { if (state.epoch === epoch) { state.ownerId = ''; setNote(error.message); } }).finally(() => { if (state.epoch === epoch) state.pending = false; });
  }, [availability]);
  return { mic: availability?.available || availability?.status === 'assets_required' ? { available: true } : { available: false, reason: note ?? 'El dictado necesita SpeechAnalyzer disponible en este iPhone.' },
    phase, elapsed, level: 0, partial: '', note, draft, start, stop, cancel,
    draftTaken: id => setDraft(value => value?.id === id ? undefined : value),
    speaking: false, muted: true, stopSpeaking() {}, setMuted() {}, typed() {}, sent() {}, sendOnStop: false, setSendOnStop() {} };
}
