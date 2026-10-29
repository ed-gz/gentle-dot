import type { AgentTextDraftStore } from '@gentle-dot/ui/src/useAgentTextDraft.ts';
import { parseNativeVoiceReceipt } from './native-voice-receipts.ts';
import { sessionVoiceOrigin } from './voice-origin.ts';
import { createSessionVoiceDrafts } from './session-voice-drafts.ts';

const store = createSessionVoiceDrafts();
const chains = new Map<string, Promise<unknown>>();
const pendingViews = new Map<string, Promise<unknown>>();
function deadline<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No se confirmó el borrador. Conserva una copia para revisión.')), 10_000);
    work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
function serialized<T>(destination: string, action: () => Promise<T>): Promise<T> {
  const prior = chains.get(destination) ?? Promise.resolve();
  const result = prior.catch(() => {}).then(action);
  chains.set(destination, result);
  void result.finally(() => { if (chains.get(destination) === result) chains.delete(destination); }).catch(() => {});
  return result;
}
export function sessionVoiceDraftProvider(url: string, paneId: string, sessionId: string): AgentTextDraftStore {
  const owner = JSON.stringify([url, paneId, sessionId]);
  const destination = sessionVoiceOrigin(owner);
  return {
    read: () => deadline((async () => { await pendingViews.get(owner)?.catch(() => {}); const id = await destination; return serialized(id, () => store.read(id)); })()),
    readCurrent: () => deadline((async () => { const id = await destination; return serialized(id, () => store.read(id)); })()),
    save: (expected, text) => deadline((async () => { const id = await destination; return serialized(id, () => store.save(id, expected, text)); })()),
    deliver: (value, expected) => deadline((async () => { const id = await destination; const receipt = parseNativeVoiceReceipt(value); return serialized(id, () => store.deliver(id, receipt, expected)); })()),
    trackPending: work => { pendingViews.set(owner, work); void work.finally(() => { if (pendingViews.get(owner) === work) pendingViews.delete(owner); }).catch(() => {}); },
  };
}
