import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceControls, VoicePhase } from '@gentle-dot/ui/src/useVoice.ts';
import { checkVoice, prepareVoice, startVoice, stopVoice, cancelVoice, VoiceRetryPending, type VoiceAvailability } from './perception.ts';
import { localIdentifier } from './local-identifiers.ts';
import { rememberVoiceOrigin, voiceOrigin, forgetVoiceOrigin, sessionVoiceOrigin } from './voice-origin.ts';

function availabilityNote(value: VoiceAvailability): string | undefined {
  if (value.microphonePermission === 'denied') return 'Activa el micrófono para Capri en Ajustes del iPhone.';
  if (value.available || value.status === 'assets_required') return undefined;
  if (value.status === 'unsupported_language') return 'La transcripción local en español no está disponible en este iPhone.';
  if (value.status === 'os_unsupported') return 'El dictado local necesita iOS 26 o posterior.';
  if (value.status === 'device_not_supported') return 'La transcripción local no está disponible en este dispositivo.';
  return 'No pude preparar el dictado local. Cierra y vuelve a abrir esta sesión para intentarlo.';
}

// A final result arriving after navigation remains scoped to its original
// session. It is never applied to the newly visible conversation.
const deferredTranscripts = new Map<string, string>();

/** Session dictation is an Apple transcript left in the composer for review. */
export function useAppleVoice(enabled: boolean, destination?: string): VoiceControls & { retryPending: boolean; discarding: boolean; discardPending(): void } {
  const [availability, setAvailability] = useState<VoiceAvailability>();
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [partial, setPartial] = useState('');
  const [note, setNote] = useState<string>();
  const [retryPending, setRetryPending] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [draft, setDraft] = useState<VoiceControls['draft']>();
  const owner = useRef({ epoch: 0, session: '', ownerId: '', pending: false, retry: false, enabled, destination });
  owner.current.enabled = enabled;
  owner.current.destination = destination;
  const release = useCallback((discardRetry: boolean) => {
    const state = owner.current;
    const ownerId = state.ownerId;
    const retainAudio = state.retry && !discardRetry;
    state.epoch++; state.session = ''; state.ownerId = ''; state.pending = false; state.retry = false;
    setPhase('idle'); setElapsed(0); setPartial(''); setDraft(undefined); setNote(undefined); setRetryPending(false);
    if (ownerId && !retainAudio) { forgetVoiceOrigin(ownerId); void cancelVoice(ownerId).catch(() => {}); }
  }, []);
  // Shared session components call cancel on unmount; preserve a completed
  // recording awaiting recovery through that cleanup.
  const cancel = useCallback(() => release(false), [release]);
  const discardPending = useCallback(() => {
    const state = owner.current, id = state.ownerId, epoch = state.epoch;
    if (!state.retry || !id || state.pending || discarding || !window.confirm('¿Descartar el audio pendiente de transcripción?')) return;
    state.pending = true;
    setDiscarding(true);
    void cancelVoice(id).then(() => {
      forgetVoiceOrigin(id);
      if (state.epoch === epoch) release(false);
    }).catch(error => {
      if (state.epoch === epoch) { state.pending = false; setNote(error.message || 'No pude descartar el audio. Inténtalo de nuevo.'); }
    }).finally(() => setDiscarding(false));
  }, [discarding, release]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (enabled && destination) {
      const deferred = deferredTranscripts.get(destination);
      if (deferred) { deferredTranscripts.delete(destination); setDraft({ id: ++owner.current.epoch, text: deferred }); }
    }
    const refresh = async () => {
      const value = await checkVoice();
      if (!live) return;
      if (value.recoveryPending && value.busy) {
        setAvailability({ ...value, available: false, status: 'voice_finishing' });
        setNote('Terminando el audio guardado…');
        timer = setTimeout(() => void refresh().catch(error => { if (live) setNote(String(error.message)); }), 500);
        return;
      }
      if (value.recoveryPending && value.ownerId && value.sessionId) {
        const expected = destination ? await sessionVoiceOrigin(destination) : undefined;
        if (!live) return;
        if (expected && voiceOrigin(value.ownerId) === expected) {
          owner.current.session = value.sessionId; owner.current.ownerId = value.ownerId; owner.current.retry = true;
          setRetryPending(true);
          setAvailability(value); setNote(value.recoveryIssue ?? 'El audio está guardado. Toca Dictar para reintentar la transcripción sin volver a grabar.');
        } else {
          setAvailability({ ...value, available: false, status: 'recovery_elsewhere' });
          setNote('Hay un audio pendiente en otra conversación. Vuelve a su destino original para reintentar.');
        }
        return;
      }
      setAvailability(value); setNote(availabilityNote(value));
    };
    if (enabled) void refresh().catch(error => { if (live) setNote(String(error.message)); });
    else release(false);
    return () => { live = false; clearTimeout(timer); release(false); };
  }, [enabled, destination, release]);
  useEffect(() => {
    // A native permission dialog may obscure the web view before a capture is
    // established. The native controller handles real background transitions.
    const hidden = () => { if (document.hidden && owner.current.session && !owner.current.retry) cancel(); };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [cancel]);
  const stop = useCallback(() => {
    const state = owner.current;
    if (!state.session || state.pending) return;
    const id = state.session, epoch = state.epoch, originalDestination = state.destination, originalOwner = state.ownerId;
    state.pending = true; state.retry = true; setRetryPending(false); setPartial(''); setPhase('transcribing');
    void stopVoice(id).then(value => {
      if (originalOwner) forgetVoiceOrigin(originalOwner);
      if (state.epoch === epoch && state.enabled) { state.retry = false; setNote(undefined); setDraft({ id: epoch, text: value.text }); }
      else if (originalDestination) {
        if (state.enabled && state.destination === originalDestination) setDraft({ id: ++state.epoch, text: value.text });
        else deferredTranscripts.set(originalDestination, value.text);
      }
    }).catch(error => {
      if (state.epoch === epoch) { state.retry = error instanceof VoiceRetryPending; setRetryPending(state.retry); if (!state.retry && state.ownerId) forgetVoiceOrigin(state.ownerId); setNote(error.message); }
    }).finally(() => {
      if (state.epoch === epoch) { state.pending = false; if (!state.retry) { state.session = ''; state.ownerId = ''; } setPhase('idle'); }
    });
  }, []);
  useEffect(() => {
    if (phase !== 'recording') return;
    const started = performance.now();
    const timer = setInterval(() => { const seconds = Math.floor((performance.now() - started) / 1000); setElapsed(seconds); if (seconds >= 85) stop(); }, 250);
    return () => clearInterval(timer);
  }, [phase, stop]);
  useEffect(() => {
    if (phase !== 'recording') return;
    const state = owner.current, id = state.session, epoch = state.epoch;
    let live = true, polling = false;
    const refresh = async () => {
      if (!live || polling || document.hidden) return;
      polling = true;
      try {
        const value = await checkVoice();
        if (!live || state.epoch !== epoch || state.session !== id || value.sessionId?.toLowerCase() !== id.toLowerCase()) return;
        if (!value.recording && value.readyToTranscribe) {
          // A stopped native capture must not continue to appear as recording.
          // stop() is owner/epoch scoped and will surface any loss of audio.
          stop();
          return;
        }
        // A lost preview is no longer a faithful representation of the audio.
        setPartial(value.previewIssue ? '' : value.partial ?? '');
        if (value.previewIssue) setNote(value.previewIssue);
      } catch { /* A failed preview never replaces the final transcript. */ }
      finally { polling = false; }
    };
    const timer = setInterval(() => void refresh(), 500); void refresh();
    return () => { live = false; clearInterval(timer); };
  }, [phase, stop]);
  const start = useCallback(() => {
    const state = owner.current;
    if (state.enabled && state.retry && state.session && !state.pending) { stop(); return; }
    if (!state.enabled || state.pending || state.session || !(availability?.available || availability?.status === 'assets_required')) return;
    const epoch = ++state.epoch, ownerId = localIdentifier(); state.ownerId = ownerId; state.pending = true; setNote(undefined); setDraft(undefined);
    void (async () => {
      if (!destination) throw new Error('Abre una sesión antes de dictar.');
      const origin = await sessionVoiceOrigin(destination);
      if (state.epoch !== epoch || !state.enabled) return;
      rememberVoiceOrigin(ownerId, origin);
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
    })().catch(error => { if (state.epoch === epoch) { forgetVoiceOrigin(ownerId); state.ownerId = ''; setNote(error.message); } }).finally(() => { if (state.epoch === epoch) state.pending = false; });
  }, [availability, destination, stop]);
  return { mic: discarding ? { available: false, reason: 'Descartando el audio pendiente.' } : availability?.available || availability?.status === 'assets_required' ? { available: true } : { available: false, reason: note ?? 'El dictado necesita SpeechAnalyzer disponible en este iPhone.' },
    phase, elapsed, level: 0, partial, note, draft, start, stop, cancel, retryPending, discarding, discardPending,
    draftTaken: id => setDraft(value => value?.id === id ? undefined : value),
    speaking: false, muted: true, stopSpeaking() {}, setMuted() {}, typed() {}, sent() {}, sendOnStop: false, setSendOnStop() {} };
}
