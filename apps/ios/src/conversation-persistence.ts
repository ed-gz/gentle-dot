import { conversationArchive } from './conversation-archive.ts';
import { saveConversation, type ChatEntry, type Conversation } from './conversation.ts';

export type PersistenceStatus = { pending: number; archiveError?: string; conversationError?: string; blocked: boolean };
type Dependencies = {
  archive?: Pick<typeof conversationArchive, 'upsert'>;
  save?: typeof saveConversation;
  onStatus?: (status: PersistenceStatus) => void;
};
const describe = (error: unknown) => error instanceof Error ? error.message : 'El almacenamiento no confirmó la escritura.';

/** Capture before the visible window is pruned. Only a confirmed commit can release a snapshot. */
export function createConversationPersistence(deps: Dependencies = {}) {
  const archive = deps.archive ?? conversationArchive, save = deps.save ?? saveConversation;
  const pending = new Map<string, ChatEntry>(); const seen = new WeakSet<ChatEntry>();
  let revision = 0;
  let chain = Promise.resolve(), archiveError: string | undefined, conversationError: string | undefined;
  const status = (): PersistenceStatus => ({ pending: pending.size, archiveError, conversationError, blocked: Boolean(archiveError || conversationError) });
  function enqueue(entries: readonly ChatEntry[], force = false, onlyMissing = false) {
    for (const entry of entries) {
      if (!force && seen.has(entry)) continue;
      if (onlyMissing && pending.has(JSON.stringify([entry.engine, entry.id]))) continue;
      seen.add(entry); pending.set(JSON.stringify([entry.engine, entry.id]), structuredClone(entry));
    }
  }
  function persist(value: Conversation): Promise<void> {
    enqueue(value.entries);
    const snapshot = { ...structuredClone(value), revision: ++revision }, captured = [...pending.entries()];
    chain = chain.then(async () => {
      try {
        for (let offset = 0; offset < Math.max(1, captured.length); offset += 500) {
          const batch = captured.slice(offset, offset + 500);
          await archive.upsert(batch.map(([, entry]) => entry), undefined, offset + 500 >= captured.length ? snapshot.entries : undefined, snapshot.revision);
          for (const [key, entry] of batch) if (pending.get(key) === entry) pending.delete(key);
        }
        if (!pending.size) archiveError = undefined;
      } catch (error) { archiveError = describe(error); }
      // Even a full archive must not prevent recovery of the latest window and draft.
      try { await save(snapshot); conversationError = undefined; }
      catch (error) { conversationError = describe(error); }
      deps.onStatus?.(status());
    });
    return chain;
  }
  return { setRevision(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Revisión de conversación inválida.'); revision = Math.max(revision, value); }, enqueue, seed: (entries: readonly ChatEntry[]) => enqueue(entries, false, true), persist, status, pending: () => structuredClone([...pending.values()]), settled: () => chain };
}
