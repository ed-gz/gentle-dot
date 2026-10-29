import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceControls, VoicePhase } from '@gentle-dot/ui/src/useVoice.ts';
import { checkVoice, prepareVoice, cancelVoice, voiceCancelWithDeadline, voiceAvailabilityNote, VoiceCancelUnconfirmed, VoiceRetryPending, type VoiceAvailability } from './perception.ts';
import { createRetainedVoiceBridge, type RetainedVoiceRecord } from './retained-voice.ts';
import { createNativeVoiceReceipts, type NativeVoiceReceipt } from './native-voice-receipts.ts';
import { createProtectedVoice, cleanupDeliveredVoiceReceipt, prepareNativeVoiceCapacity } from './protected-voice.ts';
import { createSessionVoiceDrafts } from './session-voice-drafts.ts';
import { localIdentifier } from './local-identifiers.ts';
import { rememberVoiceOrigin, voiceOrigin, forgetVoiceOrigin, sessionVoiceOrigin, markVoiceCancellation, clearVoiceCancellation, pendingVoiceCancellation } from './voice-origin.ts';

function retryableVoiceStatus(value: VoiceAvailability | undefined): boolean {
  return Boolean(value?.available || value?.status === 'assets_required' || value?.status === 'assets_downloading' || value?.status === 'asset_status_unknown');
}

const retainedBridge = createRetainedVoiceBridge();
const receipts = createNativeVoiceReceipts();
const sessionDrafts = createSessionVoiceDrafts();
const protectedVoice = createProtectedVoice({ bridge: retainedBridge, receipts,
  isDelivered: receipt => sessionDrafts.delivered(receipt.audio.destination, receipt) });

/** Session dictation is an Apple transcript left in the composer for review. */
export function useAppleVoice(enabled: boolean, destination?: string): VoiceControls & { retryPending: boolean; discarding: boolean; discardPending(): void; deferDraft(id: number): void } {
  const [availability, setAvailability] = useState<VoiceAvailability>();
  const [retryAvailability, setRetryAvailability] = useState(false);
  const [retryCancellation, setRetryCancellation] = useState(false);
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [preparing, setPreparing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [partial, setPartial] = useState('');
  const [note, setNote] = useState<string>();
  const [retryPending, setRetryPending] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [draft, setDraft] = useState<{ id: number; text: string; receipt?: NativeVoiceReceipt }>();
  const pendingReceipt = useRef<{ id: number; receipt: NativeVoiceReceipt; destination: string } | undefined>(undefined);
  const owner = useRef<{ epoch: number; session: string; ownerId: string; pending: boolean; retry: boolean; enabled: boolean; destination?: string; record?: RetainedVoiceRecord; needsAttach: boolean; discardPending: boolean }>({ epoch: 0, session: '', ownerId: '', pending: false, retry: false, enabled, destination, needsAttach: false, discardPending: false });
  owner.current.enabled = enabled;
  owner.current.destination = destination;
  const release = useCallback((discardRetry: boolean, forceCancel = false) => {
    const state = owner.current;
    const ownerId = state.ownerId;
    const retainAudio = state.retry && !discardRetry && !forceCancel;
    state.epoch++; state.session = ''; state.ownerId = ''; state.pending = false; state.retry = false; state.record = undefined; state.needsAttach = false; state.discardPending = false;
    setPhase('idle'); setPreparing(false); setElapsed(0); setLevel(0); setPartial(''); setDraft(undefined); setNote(undefined); setRetryPending(false); setRetryCancellation(false);
    if (ownerId && !retainAudio) {
      // Navigation can outlive the cancellation callback. Keep the original
      // identity until native confirms, so another view can safely retry.
      markVoiceCancellation(ownerId);
      const epoch = state.epoch;
      if (forceCancel) { state.pending = true; setRetryCancellation(true); setNote('Deteniendo el dictado…'); }
      void voiceCancelWithDeadline(() => cancelVoice(ownerId))
        .then(() => { clearVoiceCancellation(ownerId); forgetVoiceOrigin(ownerId);
          if (forceCancel && state.epoch === epoch && state.enabled) { state.pending = false; setRetryCancellation(false); setRecoveryRevision(value => value + 1); } })
        .catch(() => {
          if (state.epoch === epoch && state.enabled && pendingVoiceCancellation() === ownerId) {
            state.pending = false;
            setRetryCancellation(true);
            setNote('No pude confirmar que el micrófono se detuvo. Toca el micrófono para reintentar.');
          }
        });
    }
  }, []);
  // Shared session components call cancel on unmount; preserve a completed
  // recording awaiting recovery through that cleanup.
  const cancel = useCallback(() => release(false), [release]);
  const cancelPending = useCallback(() => release(false, true), [release]);
  const discardPending = useCallback(() => {
    const state = owner.current, id = state.ownerId, epoch = state.epoch;
    const record = state.record;
    if (!state.retry || !id || !record || state.pending || discarding || (!state.discardPending && !window.confirm('¿Eliminar este audio pendiente? No se podrá recuperar la grabación.'))) return;
    state.pending = true;
    setDiscarding(true);
    void retainedBridge.discard(record).then(() => {
      forgetVoiceOrigin(id);
      if (state.epoch === epoch) { state.ownerId = ''; state.session = ''; state.record = undefined; state.retry = false; state.discardPending = false; setRetryPending(false); setNote('Audio eliminado.'); }
    }).catch(error => {
      if (state.epoch === epoch) setNote(error.message || 'No pude confirmar que se eliminó el audio.');
    }).finally(() => { if (state.epoch === epoch) state.pending = false; setDiscarding(false); });
  }, [discarding]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (pendingVoiceCancellation()) {
        if (live) { setRetryCancellation(true); setNote('No pude confirmar que el micrófono se detuvo. Toca el micrófono para reintentar.'); }
        return;
      }
      const inspected = await retainedBridge.inspectState();
      const value = await checkVoice();
      if (!live) return;
      if (inspected.state !== 'none') {
        const expected = destination ? await sessionVoiceOrigin(destination) : undefined;
        if (!live) return;
        const record = inspected.record;
        if (!expected || record.destination !== expected) { setAvailability({ ...value, available: false, status: 'recovery_elsewhere' }); setNote('Hay un audio pendiente en otra conversación. Vuelve a su destino original para reintentar.'); return; }
        const state = owner.current; state.record = record; state.ownerId = record.owner; state.retry = true;
        if (inspected.state === 'discard-pending') { state.session = ''; state.discardPending = true; setRetryPending(true); setAvailability(value); setNote('La eliminación del audio espera confirmación.'); return; }
        const active = value.sessionId?.toLowerCase() === record.id.toLowerCase() && value.ownerId?.toLowerCase() === record.owner.toLowerCase();
        if (active && value.busy) { setAvailability({ ...value, available: false, status: 'voice_finishing' }); setNote('Terminando el audio guardado…'); timer = setTimeout(() => void refresh().catch(error => { if (live) setNote(String(error.message)); }), 500); return; }
        if (record.state === 'capturing' && !(active && value.recoveryPending)) { state.session = ''; setRetryPending(true); setAvailability(value); setNote('La grabación quedó incompleta. El audio se conserva.'); return; }
        state.session = record.id; state.needsAttach = !active; setRetryPending(true); setAvailability(value);
        setNote('Hay audio guardado. Toca Dictar para reintentar.'); return;
      }
      if (pendingVoiceCancellation()) {
        setRetryCancellation(true); setNote('No pude confirmar que el micrófono se detuvo. Toca el micrófono para reintentar.');
        return;
      }
      setRetryAvailability(false);
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
          setAvailability(value); setNote(value.recoveryIssue ?? 'Toca Dictar para reintentar. El audio puede perderse si iOS cierra Capri.');
        } else {
          setAvailability({ ...value, available: false, status: 'recovery_elsewhere' });
          setNote('Hay un audio pendiente en otra conversación. Vuelve a su destino original para reintentar.');
        }
        return;
      }
      setAvailability(value); setNote(voiceAvailabilityNote(value));
    };
    if (enabled) void refresh().catch(error => { if (live) { setAvailability(undefined); setRetryAvailability(true); setNote(`${String(error.message)} Toca el micrófono para reintentar.`); } });
    else release(false);
    return () => { live = false; clearTimeout(timer); release(false); };
  }, [enabled, destination, release, recoveryRevision]);
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
    state.pending = true; state.retry = true; setRetryPending(false); setLevel(0); setPartial(''); setPhase('transcribing');
    const record = state.record;
    void (async () => {
      if (!record || !originalDestination || record.id.toLowerCase() !== id.toLowerCase()) throw new Error('No pude verificar el audio de este dictado.');
      const saved = state.needsAttach ? await protectedVoice.recover(record) : await protectedVoice.finish(record);
      if (state.epoch !== epoch || !state.enabled || state.destination !== originalDestination) return;
      if (originalOwner) forgetVoiceOrigin(originalOwner);
      state.retry = false; state.record = saved.receipt.audio; state.needsAttach = false;
      pendingReceipt.current = { id: epoch, receipt: saved.receipt, destination: originalDestination };
      setNote(undefined); setDraft({ id: epoch, text: saved.receipt.transcript.text, receipt: saved.receipt });
    })().catch(error => {
      if (state.epoch === epoch) { state.retry = Boolean(state.record) || error instanceof VoiceRetryPending; setRetryPending(state.retry); if (!state.retry && state.ownerId) forgetVoiceOrigin(state.ownerId); setNote(error.message); }
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
        setLevel(value.microphoneLevel ?? 0);
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
    const pendingCancellation = pendingVoiceCancellation();
    if (state.enabled && pendingCancellation && !state.pending) {
      const epoch = state.epoch;
      state.pending = true; setNote('Deteniendo el micrófono…');
      void voiceCancelWithDeadline(() => cancelVoice(pendingCancellation)).then(async () => {
        clearVoiceCancellation(pendingCancellation); forgetVoiceOrigin(pendingCancellation);
        if (state.epoch === epoch) {
          if (state.ownerId === pendingCancellation) { state.ownerId = ''; state.session = ''; state.retry = false; setRetryPending(false); }
          setRetryCancellation(Boolean(pendingVoiceCancellation()));
          setNote('Micrófono detenido. Toca de nuevo para dictar.');
          // Cancellation can leave a retained recording. Reinspect the exact
          // owner/destination before offering another start or discard.
          setRecoveryRevision(value => value + 1);
        }
      }).catch(error => { if (state.epoch === epoch) { setRetryCancellation(true); setNote(error.message); } })
        .finally(() => { if (state.epoch === epoch) state.pending = false; });
      return;
    }
    if (state.enabled && state.retry && state.session && !state.pending) { stop(); return; }
    if (!state.enabled || state.pending || state.session || !(retryAvailability || retryableVoiceStatus(availability))) return;
    const epoch = ++state.epoch, ownerId = localIdentifier(); state.ownerId = ownerId; state.pending = true; setPreparing(true); setNote(undefined); setDraft(undefined);
    void (async () => {
      if (!destination) throw new Error('Abre una sesión antes de dictar.');
      const origin = await sessionVoiceOrigin(destination);
      if (state.epoch !== epoch || !state.enabled) return;
      rememberVoiceOrigin(ownerId, origin);
      // A failed status query is not proof that dictation is unsupported.
      // Retry explicitly on tap instead of leaving the control disabled forever.
      // Assets can disappear or change after the view's initial status check.
      // Query again on every user attempt so an assets_required response can
      // lead to preparation on the next tap instead of an endless retry loop.
      const current = await checkVoice();
      if (state.epoch !== epoch || !state.enabled) return;
      if (!current) throw new Error('No pude comprobar la voz. Vuelve a intentarlo.');
      setAvailability(current); setRetryAvailability(false);
      if (!current.available && current.status !== 'assets_required') {
        throw new Error(voiceAvailabilityNote(current) ?? 'La voz no está disponible en este iPhone.');
      }
      if (current.status === 'assets_required') {
        setNote('Descargando la voz en español de Apple. Necesitas internet para esta primera preparación…');
        const prepared = await prepareVoice(ownerId);
        if (state.epoch !== epoch || !state.enabled) return;
        setAvailability(prepared);
        if (!prepared.available) throw new Error(voiceAvailabilityNote(prepared) ?? 'Apple aún no terminó de preparar la voz. Comprueba la conexión y vuelve a intentarlo.');
      }
      await prepareNativeVoiceCapacity({ list: receipts.list, eligible: receipt => receipt.audio.destination.startsWith('session:'),
        cleanup: receipt => cleanupDeliveredVoiceReceipt(receipt, { delivered: value => sessionDrafts.delivered(receipt.audio.destination, value),
          release: protectedVoice.release, get: receipts.get, discard: receipts.discard }) });
      if (state.epoch !== epoch || !state.enabled) return;
      setNote('Iniciando el micrófono. Si iOS pide permiso, acéptalo para dictar.');
      const started = await protectedVoice.start(ownerId, origin);
      // cancel() already reached the native controller; a late second global
      // cancellation could stop a newer session in the main conversation.
      if (state.epoch !== epoch || !state.enabled) return;
      state.record = started.record; state.needsAttach = false; state.session = started.session.sessionId; setElapsed(0); setPhase('recording');
      setNote('Grabando. Toca el micrófono otra vez para revisar la transcripción.');
    })().catch(error => { if (state.epoch === epoch) {
      if (error instanceof VoiceCancelUnconfirmed) { markVoiceCancellation(ownerId); setRetryCancellation(true); }
      else forgetVoiceOrigin(ownerId);
      state.ownerId = ''; setNote(error.message);
    } }).finally(() => { if (state.epoch === epoch) { state.pending = false; setPreparing(false); } });
  }, [availability, destination, retryAvailability, stop]);
  return { mic: discarding ? { available: false, reason: 'Descartando el audio pendiente.' } : retryCancellation || retryAvailability || retryableVoiceStatus(availability) ? { available: true } : { available: false, reason: note ?? 'El dictado necesita SpeechAnalyzer disponible en este iPhone.' },
    phase, inputBusy: preparing, elapsed, level, partial, note, draft, start, stop, cancel, cancelPending, retryPending, discarding, discardPending,
    deferDraft: id => {
      const pending = pendingReceipt.current;
      if (!pending || pending.id !== id) return;
      setDraft(value => value?.id === id ? undefined : value);
      const state = owner.current;
      if (state.enabled && state.destination === pending.destination) {
        state.record = pending.receipt.audio; state.session = pending.receipt.audio.id; state.ownerId = pending.receipt.audio.owner; state.retry = true;
        setRetryPending(true); setNote('El dictado se conserva. Toca Dictar para revisarlo de nuevo.');
      }
    },
    draftTaken: id => {
      const pending = pendingReceipt.current;
      if (!pending || pending.id !== id) return;
      setDraft(value => value?.id === id ? undefined : value);
      void (async () => {
        const target = await sessionVoiceOrigin(pending.destination);
        if (target !== pending.receipt.audio.destination || !await sessionDrafts.delivered(target, pending.receipt)) throw new Error('No se confirmó el borrador. El dictado se conserva.');
        await cleanupDeliveredVoiceReceipt(pending.receipt, { delivered: receipt => sessionDrafts.delivered(target, receipt),
          release: protectedVoice.release, get: receipts.get, discard: receipts.discard });
        if (pendingReceipt.current === pending) pendingReceipt.current = undefined;
      })().catch(error => {
        if (pendingReceipt.current !== pending) return;
        const state = owner.current;
        if (state.enabled && state.destination === pending.destination) {
          state.record = pending.receipt.audio; state.session = pending.receipt.audio.id; state.ownerId = pending.receipt.audio.owner; state.retry = true;
          setRetryPending(true); setNote(error.message || 'El dictado se conserva; vuelve a intentarlo.');
        }
      });
    },
    speaking: false, muted: true, stopSpeaking() {}, setMuted() {}, typed() {}, sent() {}, sendOnStop: false, setSendOnStop() {} };
}
