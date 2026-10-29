import { invoke, isTauri } from '@tauri-apps/api/core';
import { parseVoiceTranscript, type VoiceTranscript } from './perception.ts';
import { parseRetainedVoiceRecord, type RetainedVoiceRecord } from './retained-voice.ts';

export type NativeVoiceReceipt = {
  schema: 'capri-native-voice-receipt/v1';
  audio: Extract<RetainedVoiceRecord, { state: 'ready' }>;
  transcript: VoiceTranscript;
};
export type NativeVoiceReceiptEnvelope = { receipt: NativeVoiceReceipt; releaseState: 'retained' | 'releasing' | 'released' };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const invalid = () => new Error('No pude verificar el dictado guardado. Revisa su estado antes de continuar.');

/** Never normalize the original serialized UUIDs: native journal equality is exact. */
export function parseNativeVoiceReceipt(input: unknown): NativeVoiceReceipt {
  const value: unknown = structuredClone(input);
  if (!object(value) || !keys(value, ['schema', 'audio', 'transcript']) || value.schema !== 'capri-native-voice-receipt/v1' || !object(value.transcript)
    || !keys(value.transcript, ['sessionId', 'text', 'segments', 'durationSeconds', 'locale', 'source'])
    || !Array.isArray(value.transcript.segments)
    || value.transcript.segments.some(segment => !object(segment) || !keys(segment, ['text', 'startSeconds', 'endSeconds']))) throw invalid();
  const audio = parseRetainedVoiceRecord(value.audio);
  if (audio.state !== 'ready') throw invalid();
  const transcript = parseVoiceTranscript({ ...value.transcript, ok: true }, audio.id);
  if (transcript.locale.toLowerCase() !== audio.locale.toLowerCase()) throw invalid();
  return { schema: value.schema, audio, transcript };
}
function envelope(value: unknown): NativeVoiceReceiptEnvelope {
  if (!object(value) || !keys(value, ['receipt', 'releaseState']) || !['retained', 'releasing', 'released'].includes(String(value.releaseState))) throw invalid();
  return { receipt: parseNativeVoiceReceipt(value.receipt), releaseState: value.releaseState as NativeVoiceReceiptEnvelope['releaseState'] };
}
function successful(value: unknown): Record<string, unknown> {
  if (!object(value) || value.ok !== true) throw invalid();
  return value;
}
async function native(command: string, args?: Record<string, unknown>): Promise<unknown> {
  if (!isTauri()) throw new Error('Los dictados guardados requieren Capri instalada en el iPhone.');
  try { return await invoke(`plugin:perception|${command}`, args); } catch { throw invalid(); }
}

/** Commands never infer release from a callback or delete a receipt themselves. */
export function createNativeVoiceReceipts(call: typeof native = native) {
  return {
    async list(): Promise<NativeVoiceReceiptEnvelope[]> {
      const value = successful(await call('list_voice_receipts'));
      if (!Array.isArray(value.receipts) || value.receipts.length > 100) throw invalid();
      const result = value.receipts.map(envelope), ids = new Set<string>();
      for (const item of result) {
        const id = item.receipt.audio.id.toLowerCase();
        if (ids.has(id)) throw invalid(); ids.add(id);
      }
      return result;
    },
    async get(sessionId: string): Promise<NativeVoiceReceiptEnvelope | undefined> {
      if (!uuid(sessionId)) throw invalid();
      const value = successful(await call('get_voice_receipt', { sessionId }));
      if (value.receipt == null) return undefined;
      const result = envelope(value.receipt);
      if (result.receipt.audio.id.toLowerCase() !== sessionId.toLowerCase()) throw invalid();
      return result;
    },
    async release(input: unknown): Promise<void> {
      const receipt = parseNativeVoiceReceipt(input);
      const value = successful(await call('release_retained_voice', { receipt }));
      if (value.releaseState !== 'released') throw invalid();
    },
    async discard(input: unknown): Promise<void> {
      const receipt = parseNativeVoiceReceipt(input);
      successful(await call('discard_voice_receipt', { receipt }));
    },
  };
}
