import type { Page } from '@playwright/test';

/** Shared retained-voice native stub, extracted verbatim from `shell.spec.ts`
 * so a new spec does not add a third copy. The existing copies stay untouched. */
export async function nativeFixture(page: Page, delayed = false, decisions: object[] = []) {
  await page.addInitScript(({ delayed, decisions }) => {
    const state = globalThis as any;
    state.isTauri = true;
    state.nativePrompts = [];
    state.nativeCalls = [];
    state.nativeDecisions = decisions;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('results_list')) return { ok: true, items: [] };
      state.nativeCalls.push(command);
      if (command.endsWith('secret_get')) {
        const request = args.request;
        const value = sessionStorage.getItem(`fixture-keychain:${request.scope}:${request.account}`);
        return value === null ? { ok: true } : { ok: true, value };
      }
      if (command.endsWith('secret_set')) {
        const request = args.request;
        const key = `fixture-keychain:${request.scope}:${request.account}`; if (request.compare === true && sessionStorage.getItem(key) !== (request.expected ?? null)) return { ok: true, persisted: false }; sessionStorage.setItem(key, request.value); return { ok: true, persisted: true };
      }
      if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('agent_step')) {
        state.nativePrompts.push(args.prompt);
        if (delayed) return await new Promise(resolve => { state.finishNative = resolve; });
        return { ok: true, decision: state.nativeDecisions.shift() ?? { kind: 'answer', text: 'Respuesta local de prueba <b>literal</b>.', toolName: '', argumentsJSON: '{}' } };
      }
      return { ok: true };
    } };
    // Adapt legacy per-test voice replies to the retained native protocol.
    // Cancellation keeps the journal; only an exact release/discard clears it.
    let record: any = null, receipt: any = null, captureEpoch = 0;
    state.wrapRetainedVoice = (invoke: (command: string, args: any) => Promise<any>) => async (command: string, args: any = {}) => {
      if (command.endsWith('inspect_retained_voice')) return { ok: true, retainedAudio: record };
      if (command.endsWith('list_voice_receipts')) return { ok: true, receipts: receipt ? [receipt] : [] };
      if (command.endsWith('get_voice_receipt')) return { ok: true, receipt: receipt?.receipt.audio.id.toLowerCase() === args.sessionId.toLowerCase() ? receipt : null };
      if (command.endsWith('release_retained_voice')) {
        if (!receipt || JSON.stringify(args.receipt) !== JSON.stringify(receipt.receipt)) throw new Error('Unmatched receipt');
        receipt.releaseState = 'released'; record = null; return { ok: true, releaseState: 'released' };
      }
      if (command.endsWith('discard_retained_voice')) {
        if (JSON.stringify(args.record) !== JSON.stringify(record)) throw new Error('Unmatched audio');
        record = null; return { ok: true };
      }
      if (command.endsWith('attach_retained_voice')) {
        if (JSON.stringify(args.record) !== JSON.stringify(record) || record?.state !== 'ready') throw new Error('Unmatched audio');
        return { ok: true, sessionId: record.id, ownerId: record.owner, retainedAudio: record };
      }
      const startedAt = captureEpoch;
      const result = await invoke(command, args);
      if (command.endsWith('cancel_voice') && result?.ok) captureEpoch++;
      if (command.endsWith('start_voice') && result?.ok && result.sessionId) {
        const started = { id: result.sessionId, owner: args.ownerId, destination: args.retainDestination, locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'capturing' };
        if (startedAt === captureEpoch) record = started;
        return { ...result, retainedAudio: started };
      }
      if (command.endsWith('stop_voice') && result?.ok && record && result.sessionId === record.id) {
        record = { ...record, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) };
        const { sessionId, text, segments, durationSeconds, locale, source } = result;
        receipt = { receipt: { schema: 'capri-native-voice-receipt/v1', audio: record, transcript: { sessionId, text, segments, durationSeconds, locale, source } }, releaseState: 'retained' };
        return { ...result, retainedAudio: record };
      }
      return result;
    };
  }, { delayed, decisions });
}
