import { invoke, isTauri } from '@tauri-apps/api/core';
import { parseVoiceSession, parseVoiceTranscript, voiceCancelWithDeadline, voiceStartWithDeadline, type VoiceSession, type VoiceTranscript } from './perception.ts';

/** Experimental boundary only: no UI calls it and no receipt authorizes audio deletion. */
export type RetainedVoiceRecord = {
  id: string; owner: string; destination: string; locale: string; kind: 'speech' | 'dictation'; createdAt: number;
} & ({ state: 'capturing' } | { state: 'ready'; byteCount: number; sha256: string });
export type RetainedVoiceResult = { record: Extract<RetainedVoiceRecord, { state: 'ready' }>; transcript: VoiceTranscript };
const MAX_BYTES = 128 * 1024 * 1024;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
const destinationOK = (value: unknown): value is string => value === 'chat' || (typeof value === 'string' && /^session:[a-f0-9]{64}$/.test(value));
const localeOK = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && /^es(?:-[a-z0-9]{1,8})*$/i.test(value);
const recordError = () => new Error('No pude verificar el audio guardado. Se conserva para revisión.');

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

/** Deliberately has no ACK/delete operation. Callers must first implement
 * destination-bound durable storage, recovery and an explicit retention policy. */
export function createRetainedVoiceBridge(call: typeof native = native, deadlines: { start?: number; cancel?: number } = {}) {
  return {
    async inspect(): Promise<RetainedVoiceRecord | undefined> {
      const value = reply(await call('inspect_retained_voice'));
      return value.retainedAudio == null ? undefined : parseRetainedVoiceRecord(value.retainedAudio);
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
      const value = reply(await call('attach_retained_voice', { record }));
      const actual = parseRetainedVoiceRecord(value.retainedAudio);
      if (!sameRecord(record, actual) || typeof value.sessionId !== 'string' || value.sessionId.toLowerCase() !== record.id.toLowerCase()
        || typeof value.ownerId !== 'string' || value.ownerId.toLowerCase() !== record.owner.toLowerCase()) throw recordError();
      return actual;
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
