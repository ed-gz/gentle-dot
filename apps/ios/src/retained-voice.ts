import { invoke, isTauri } from '@tauri-apps/api/core';
import { parseVoiceAvailability, voiceAvailabilityNote, parseVoiceSession, parseVoiceTranscript, voiceCancelWithDeadline, voiceStartWithDeadline, type VoiceSession, type VoiceTranscript } from './perception.ts';

/** Experimental boundary only: no UI calls it and no receipt authorizes audio deletion. */
export type RetainedVoiceRecord = {
  id: string; owner: string; destination: string; locale: string; kind: 'speech' | 'dictation'; createdAt: number;
} & ({ state: 'capturing' } | { state: 'ready'; byteCount: number; sha256: string });
export type RetainedVoiceResult = { record: Extract<RetainedVoiceRecord, { state: 'ready' }>; transcript: VoiceTranscript };
export type RetainedVoiceInspection = { state: 'none' } | { state: 'retained' | 'discard-pending'; record: RetainedVoiceRecord };
const MAX_BYTES = 128 * 1024 * 1024;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
const destinationOK = (value: unknown): value is string => value === 'chat' || (typeof value === 'string' && /^session:[a-f0-9]{64}$/.test(value));
const localeOK = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && /^es(?:-[a-z0-9]{1,8})*$/i.test(value);
const recordError = () => new Error('No pude verificar el audio. Revisa su estado antes de continuar.');
export class RetainedVoiceAssetsRequired extends Error {
  constructor() { super('Prepara el idioma del audio para volver a transcribirlo.'); this.name = 'RetainedVoiceAssetsRequired'; }
}
function retainedAssetFailure(raw: unknown): void {
  if (!isObject(raw) || raw.ok !== false || typeof raw.error !== 'string') return;
  if (raw.error === 'assets_required') throw new RetainedVoiceAssetsRequired();
  if (raw.error === 'asset_reservation_failed') throw new Error('Apple no pudo reservar el idioma de este audio. Revisa el espacio disponible e inténtalo de nuevo.');
  if (['assets_downloading', 'unsupported_configuration', 'asset_status_unknown'].includes(raw.error)) {
    throw new Error(voiceAvailabilityNote({ available: false, status: raw.error, microphonePermission: 'undetermined', assetsInstalled: false, recording: false, readyToTranscribe: false, busy: false }) ?? 'No pude preparar la voz.');
  }
}

export function parseRetainedVoiceRecord(input: unknown): RetainedVoiceRecord {
  const value: unknown = structuredClone(input);
  if (!isObject(value) || Object.keys(value).some(key => !['id', 'owner', 'destination', 'locale', 'kind', 'createdAt', 'state', 'byteCount', 'sha256'].includes(key))
    || !uuid(value.id) || !uuid(value.owner) || value.id.toLowerCase() === value.owner.toLowerCase()
    || !destinationOK(value.destination) || !localeOK(value.locale) || (value.kind !== 'speech' && value.kind !== 'dictation')
    || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 1) throw recordError();
  // Swift's journal compares the original serialized record exactly. Keep
  // the native spelling when returning it for stop/attach/discard; UUID
  // validation below compares identity without depending on letter case.
  const base = { id: value.id, owner: value.owner, destination: value.destination,
    locale: value.locale, kind: value.kind as 'speech' | 'dictation', createdAt: value.createdAt as number };
  if (value.state === 'capturing' && value.byteCount == null && value.sha256 == null) return { ...base, state: 'capturing' };
  if (value.state === 'ready' && Number.isSafeInteger(value.byteCount) && (value.byteCount as number) > 0
    && (value.byteCount as number) <= MAX_BYTES && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)) {
    return { ...base, state: 'ready', byteCount: value.byteCount as number, sha256: value.sha256 };
  }
  throw recordError();
}

function sameRecord(a: RetainedVoiceRecord, b: RetainedVoiceRecord): boolean {
  return a.id.toLowerCase() === b.id.toLowerCase() && a.owner.toLowerCase() === b.owner.toLowerCase() && a.destination === b.destination && a.locale === b.locale
    && a.kind === b.kind && a.createdAt === b.createdAt && a.state === b.state
    && (a.state === 'capturing' || (b.state === 'ready' && a.byteCount === b.byteCount && a.sha256 === b.sha256));
}
function reply(value: unknown): Record<string, unknown> {
  if (!isObject(value) || value.ok !== true) throw recordError();
  return value;
}
function native(command: string, args?: Record<string, unknown>): Promise<unknown> {
  if (!isTauri()) return Promise.reject(new Error('El audio guardado requiere Capri instalada en el iPhone.'));
  return invoke(`plugin:perception|${command}`, args).catch(() => { throw recordError(); });
}

/** Explicit discard is separate from a receipt-backed release. */
export function createRetainedVoiceBridge(call: typeof native = native, deadlines: { start?: number; cancel?: number } = {}) {
  async function inspectState(): Promise<RetainedVoiceInspection> {
    const value = reply(await call('inspect_retained_voice'));
    if (value.retainedAudio != null && value.discardPending != null) throw recordError();
    if (value.discardPending != null) return { state: 'discard-pending', record: parseRetainedVoiceRecord(value.discardPending) };
    if (value.retainedAudio != null) return { state: 'retained', record: parseRetainedVoiceRecord(value.retainedAudio) };
    return { state: 'none' };
  }
  return {
    inspectState,
    async inspect(): Promise<RetainedVoiceRecord | undefined> {
      const state = await inspectState();
      if (state.state === 'discard-pending') throw new Error('Un audio espera confirmación de eliminación. Vuelve a intentarlo.');
      return state.state === 'none' ? undefined : state.record;
    },
    async start(owner: string, destination: string): Promise<{ session: VoiceSession; record: RetainedVoiceRecord }> {
      if (!uuid(owner) || !destinationOK(destination)) throw recordError();
      const normalizedOwner = owner.toLowerCase();
      const cancel = async () => { reply(await call('cancel_voice', { ownerId: normalizedOwner })); };
      const raw = await voiceStartWithDeadline(call('start_voice', { ownerId: normalizedOwner, retainDestination: destination }), cancel, deadlines.start, deadlines.cancel);
      try {
        const session = parseVoiceSession(raw), value = reply(raw), record = parseRetainedVoiceRecord(value.retainedAudio);
        if (record.state !== 'capturing' || record.id.toLowerCase() !== session.sessionId.toLowerCase() || record.owner.toLowerCase() !== normalizedOwner || record.destination !== destination) throw recordError();
        return { session, record };
      } catch (error) {
        // A malformed reply does not prove that capture didn't start. Fence
        // this owner; native cancellation preserves the opt-in journal.
        await voiceCancelWithDeadline(cancel, deadlines.cancel);
        throw error;
      }
    },
    async attach(input: unknown): Promise<RetainedVoiceRecord> {
      const record = parseRetainedVoiceRecord(input);
      if (record.state !== 'ready') throw recordError();
      const raw = await call('attach_retained_voice', { record }); retainedAssetFailure(raw);
      const value = reply(raw);
      const actual = parseRetainedVoiceRecord(value.retainedAudio);
      if (!sameRecord(record, actual) || typeof value.sessionId !== 'string' || value.sessionId.toLowerCase() !== record.id.toLowerCase()
        || typeof value.ownerId !== 'string' || value.ownerId.toLowerCase() !== record.owner.toLowerCase()) throw recordError();
      return actual;
    },
    /** Explicit user retry only. A fresh preparation owner never replaces the
     * recording's owner or destination. Native validates the exact journal. */
    async prepare(input: unknown, owner: string): Promise<void> {
      const expected = parseRetainedVoiceRecord(input);
      if (expected.state !== 'ready' || !uuid(owner) || owner.toLowerCase() === expected.owner.toLowerCase()) throw recordError();
      const raw = await call('prepare_retained_voice', { record: expected, ownerId: owner });
      if (!isObject(raw) || raw.ok !== true) {
        retainedAssetFailure(raw);
        throw new Error('No se completó la preparación de voz. El audio se conserva; revisa la conexión y el espacio.');
      }
      const state = parseVoiceAvailability(raw);
      if (!state.available || state.locale?.toLowerCase() !== expected.locale.toLowerCase()) throw new Error(voiceAvailabilityNote(state) ?? 'Apple aún no terminó de preparar este idioma. El audio se conserva.');
      const current = await inspectState();
      if (current.state !== 'retained' || !sameRecord(current.record, expected)) throw recordError();
    },
    async discard(input: unknown): Promise<void> {
      const expected = parseRetainedVoiceRecord(input);
      // Stop the exact owner and drain any reader or writer first. Neither a
      // lost cancellation nor an altered journal can authorize deletion.
      await voiceCancelWithDeadline(async () => { reply(await call('cancel_voice', { ownerId: expected.owner })); }, deadlines.cancel);
      const inspected = await inspectState();
      if (inspected.state !== 'none' && !sameRecord(inspected.record, expected)) throw recordError();
      // Native rechecks even absence under its lock; a completed deletion may
      // have lost the reply, so absence alone is not treated as success here.
      reply(await call('discard_retained_voice', { record: inspected.state === 'none' ? expected : inspected.record }));
    },
    /** User-initiated export of the interrupted bytes. The native picker owns
     * the destination; this never exposes a sandbox path or claims valid audio. */
    async exportIncomplete(input: unknown): Promise<'exported' | 'cancelled'> {
      const expected = parseRetainedVoiceRecord(input);
      if (expected.state !== 'capturing') throw recordError();
      const value = reply(await call('export_incomplete_voice', { record: expected }));
      if (value.exported === true && value.cancelled === false) return 'exported';
      if (value.exported === false && value.cancelled === true) return 'cancelled';
      throw new Error('El selector no confirmó la exportación del audio incompleto.');
    },
    async stop(input: unknown): Promise<RetainedVoiceResult> {
      const expected = parseRetainedVoiceRecord(input);
      const raw = await call('stop_voice', { sessionId: expected.id, ownerId: expected.owner, retainDestination: expected.destination });
      // parseVoiceTranscript preserves the original session-bound retry signal.
      const transcript = parseVoiceTranscript(raw, expected.id), value = reply(raw);
      const record = parseRetainedVoiceRecord(value.retainedAudio);
      if (record.state !== 'ready' || record.id.toLowerCase() !== expected.id.toLowerCase() || record.owner.toLowerCase() !== expected.owner.toLowerCase()
        || record.destination !== expected.destination || record.locale !== expected.locale || record.kind !== expected.kind || record.createdAt !== expected.createdAt
        || transcript.locale.toLowerCase() !== record.locale.toLowerCase()
        || (expected.state === 'ready' && !sameRecord(record, expected))) throw recordError();
      return { record, transcript };
    },
  };
}
