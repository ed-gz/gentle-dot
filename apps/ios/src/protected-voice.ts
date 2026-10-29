import { cancelVoice, voiceCancelWithDeadline } from './perception.ts';
import { createRetainedVoiceBridge, type RetainedVoiceRecord } from './retained-voice.ts';
import { createNativeVoiceReceipts, type NativeVoiceReceipt, type NativeVoiceReceiptEnvelope } from './native-voice-receipts.ts';

type Bridge = Pick<ReturnType<typeof createRetainedVoiceBridge>, 'inspect' | 'start' | 'attach' | 'stop'>;
type Receipts = Pick<ReturnType<typeof createNativeVoiceReceipts>, 'get' | 'release'>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const issue = () => new Error('No pude verificar el dictado guardado. Revisa su estado antes de continuar.');
function belongs(receipt: NativeVoiceReceipt, record: RetainedVoiceRecord) {
  const audio = receipt.audio;
  return audio.id.toLowerCase() === record.id.toLowerCase() && audio.owner.toLowerCase() === record.owner.toLowerCase()
    && audio.destination === record.destination && audio.locale === record.locale && audio.kind === record.kind && audio.createdAt === record.createdAt
    && (record.state !== 'ready' || (audio.byteCount === record.byteCount && audio.sha256 === record.sha256));
}

/** This coordinator never infers native success or applies a transcript. The
 * caller must keep the returned receipt available until its draft is durable. */
export function createProtectedVoice(options: {
  bridge?: Bridge; receipts?: Receipts; cancel?: (owner: string) => Promise<void>; isDelivered?: (receipt: NativeVoiceReceipt) => Promise<boolean>;
} = {}) {
  const bridge = options.bridge ?? createRetainedVoiceBridge(), receipts = options.receipts ?? createNativeVoiceReceipts();
  const cancel = options.cancel ?? (owner => voiceCancelWithDeadline(() => cancelVoice(owner)));
  async function exact(record: RetainedVoiceRecord): Promise<NativeVoiceReceiptEnvelope | undefined> {
    const saved = await receipts.get(record.id);
    if (saved && !belongs(saved.receipt, record)) throw issue();
    return saved;
  }
  async function finish(record: RetainedVoiceRecord): Promise<NativeVoiceReceiptEnvelope> {
    // A lost callback may already have produced an immutable receipt. Reuse
    // it rather than transcribing the same audio and generating new text.
    const prior = await exact(record);
    if (prior) return prior;
    const result = await bridge.stop(record);
    const saved = await exact(result.record);
    if (!saved || !same(saved.receipt.audio, result.record) || !same(saved.receipt.transcript, result.transcript)) throw issue();
    return saved;
  }
  async function release(receipt: NativeVoiceReceipt, automatic: boolean): Promise<void> {
    const checkDelivery = async () => {
      if (automatic && (!options.isDelivered || !await options.isDelivered(receipt))) throw new Error('La entrega del dictado aún no se confirmó.');
    };
    await checkDelivery();
    const saved = await receipts.get(receipt.audio.id);
    if (!saved || !same(saved.receipt, receipt)) throw issue();
    // Even a previously released receipt must recheck the native journal.
    if (saved.releaseState === 'released') { await checkDelivery(); await receipts.release(receipt); return; }
    await cancel(receipt.audio.owner);
    const verified = await receipts.get(receipt.audio.id);
    if (!verified || !same(verified.receipt, receipt)) throw issue();
    await checkDelivery();
    await receipts.release(receipt);
  }
  return {
    inspect: () => bridge.inspect(),
    async start(owner: string, destination: string) {
      if (await bridge.inspect()) throw new Error('Hay un audio guardado que necesita revisión antes de grabar otro.');
      return bridge.start(owner, destination);
    },
    finish,
    async recover(record: RetainedVoiceRecord): Promise<NativeVoiceReceiptEnvelope> {
      const prior = await exact(record);
      if (prior) return prior;
      if (record.state !== 'ready') throw new Error('La grabación quedó incompleta. El audio se conserva para revisión.');
      await bridge.attach(record);
      return finish(record);
    },
    /** The native operation validates the exact receipt under its own lock.
     * First close the owner-specific reader lease; a timeout never authorizes
     * release or a claim that the old audio is gone. */
    release: (receipt: NativeVoiceReceipt) => release(receipt, true),
    /** Caller must obtain the person's explicit confirmation for this path. */
    releaseManually: (receipt: NativeVoiceReceipt) => release(receipt, false),
  };
}

/** Cleanup only receipts already delivered by the conversation journal. A
 * missing marker or any unverifiable native state leaves the copy in place. */
export async function cleanupDeliveredVoiceReceipt(receipt: NativeVoiceReceipt, deps: {
  delivered(receipt: NativeVoiceReceipt): Promise<boolean>;
  release(receipt: NativeVoiceReceipt): Promise<void>;
  get(id: string): Promise<NativeVoiceReceiptEnvelope | undefined>;
  discard(receipt: NativeVoiceReceipt): Promise<void>;
}): Promise<void> {
  if (!await deps.delivered(receipt)) return;
  await deps.release(receipt);
  const saved = await deps.get(receipt.audio.id);
  if (!saved) return; // An earlier exact cleanup may have lost its reply.
  if (!same(saved.receipt, receipt) || saved.releaseState !== 'released' || !await deps.delivered(receipt)) throw issue();
  await deps.discard(receipt);
}

/** Do not let a failed cleanup of an older receipt block capture while the
 * native store still has capacity. At the limit, try each eligible receipt;
 * unverified records are left for explicit review. */
export async function prepareNativeVoiceCapacity(deps: {
  list(): Promise<NativeVoiceReceiptEnvelope[]>;
  eligible(receipt: NativeVoiceReceipt): boolean;
  cleanup(receipt: NativeVoiceReceipt): Promise<void>;
}): Promise<void> {
  const current = await deps.list();
  if (current.length < 100) return;
  for (const item of current) {
    if (!deps.eligible(item.receipt)) continue;
    try { await deps.cleanup(item.receipt); } catch { /* Keep uncertain receipts untouched. */ }
  }
  if ((await deps.list()).length >= 100) throw new Error('Hay demasiados dictados pendientes. Revísalos antes de grabar otro.');
}
