import type { ChatEntry } from './conversation.ts';
import type { CheckpointTurnStore } from './checkpoint-conversation.ts';
import { createIsolatedTurnStore, type IsolatedTurn } from './isolated-turn-store.ts';

/** Experimental bridge for the isolated store only. This does not use the
 * application's current conversation or archive and must not be installed as
 * their persistence adapter until migration and UI coordination are complete. */
export function createIsolatedCheckpointTurns(store: ReturnType<typeof createIsolatedTurnStore>): CheckpointTurnStore {
  function project(entry: IsolatedTurn): ChatEntry {
    return { id: entry.id, role: entry.role, engine: entry.engine, state: entry.state, text: entry.text, at: entry.at,
      ...(entry.replyTo ? { replyTo: entry.replyTo } : {}),
      ...(entry.localCancelled ? { localCancelled: true } : {}) };
  }
  function same(entry: ChatEntry, expected: ChatEntry): boolean {
    // Never silently drop a field from a caller's expected turn before a CAS.
    const keys = Object.keys(expected);
    return keys.every(key => ['id', 'role', 'engine', 'state', 'text', 'at', 'localCancelled', 'replyTo'].includes(key))
      && entry.id === expected.id && entry.role === expected.role && entry.engine === expected.engine
      && entry.state === expected.state && entry.text === expected.text && entry.at === expected.at
      && entry.localCancelled === expected.localCancelled && entry.replyTo === expected.replyTo;
  }
  return {
    async readPair(userId, turnId) {
      const { entries } = await store.read();
      const user = entries.find(item => item.id === userId && item.role === 'user');
      const turn = entries.find(item => item.id === turnId && item.role === 'assistant' && item.replyTo === userId);
      return user && turn ? { user: project(user), turn: project(turn) } : undefined;
    },
    async commitAnswer(expectedUser, expectedTurn, text) {
      const { entries } = await store.read();
      const user = entries.find(item => item.id === expectedUser.id && item.role === 'user');
      const turn = entries.find(item => item.id === expectedTurn.id && item.role === 'assistant' && item.replyTo === expectedUser.id);
      if (!user || !turn || !same(project(user), expectedUser) || !same(project(turn), expectedTurn)) return false;
      // The authoritative store rechecks the exact pair and relation in one
      // transaction, so a concurrent cancellation cannot be overwritten.
      return store.finish(user, turn, { kind: 'answer', text });
    },
  };
}
