import { createConversationJournal, JournalReservationRejected, type ConversationJournal } from './conversation-journal.ts';
import { loadConversationBase, type ChatEntry, type Conversation } from './conversation.ts';
import { localIdentifier } from './local-identifiers.ts';
import type { PersistenceStatus } from './conversation-persistence.ts';

type Journal = Pick<ReturnType<typeof createConversationJournal>, 'pending' | 'begin' | 'resume'>;
type JournalOperation = { id: string; baseRevision: number; base?: Conversation; nextRevision: number; snapshot: Conversation; pending: ChatEntry[] };
type Capture = { snapshot: Conversation; pending: [string, ChatEntry][] };
const describe = (error: unknown) => error instanceof Error ? error.message : 'No se confirmó la reserva de conversación.';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => same(item, b[index]));
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a).sort(), other = Object.keys(b).sort();
  return keys.length === other.length && keys.every((key, index) => key === other[index] && same(a[key], b[key]));
}

/** Recover only the durable reservation. A committed snapshot is historical
 * evidence, not proof that another writer has not since changed `current`.
 * A blocked recovery returns the complete reserved copy for visible rescue;
 * neither result authorizes an ACK or deletion of native work. */
export async function recoverConversationReservation(journal: Journal = createConversationJournal()): Promise<
  | { state: 'none' }
  | { state: 'committed'; journal: ConversationJournal }
  | { state: 'blocked'; journal: ConversationJournal; error: string }
> {
  const pending = await journal.pending();
  if (!pending) return { state: 'none' };
  try { await journal.resume(pending.id); return { state: 'committed', journal: pending }; }
  catch (error) { return { state: 'blocked', journal: pending, error: describe(error) }; }
}

/** Drop-in-shaped experimental writer. It is NOT enabled in the app yet.
 * The caller must bind the exact unprojected base before restoring or editing,
 * keep each UI capture descended from that base, recover old reservations
 * before accepting input, and make every archive writer cooperate. It never
 * acknowledges inference, deletes native work, or changes the visible UI. */
export function createJournalConversationPersistence(options: {
  journal?: Journal;
  readBase?: () => Promise<Conversation | undefined>;
  identifier?: () => string;
  onStatus?: (status: PersistenceStatus) => void;
} = {}) {
  const journal = options.journal ?? createConversationJournal();
  const readBase = options.readBase ?? loadConversationBase;
  const identifier = options.identifier ?? localIdentifier;
  const pending = new Map<string, ChatEntry>(), seen = new WeakSet<ChatEntry>();
  let base: Conversation | undefined, bound = false, archiveFloor = 0, owned: JournalOperation | undefined;
  let ownedRejected = false;
  let chain = Promise.resolve(), issue: string | undefined;
  const status = (): PersistenceStatus => ({ pending: pending.size, ...(issue ? { conversationError: issue } : {}), blocked: !!issue });
  const notify = () => options.onStatus?.(status());
  function enqueue(entries: readonly ChatEntry[], force = false, onlyMissing = false) {
    for (const entry of entries) {
      if (!force && seen.has(entry)) continue;
      const key = JSON.stringify([entry.engine, entry.id]);
      if (onlyMissing && pending.has(key)) continue;
      seen.add(entry); pending.set(key, structuredClone(entry));
    }
  }
  async function finish(operation: JournalOperation, captured: [string, ChatEntry][]) {
    await journal.resume(operation.id);
    const actual = await readBase();
    if (!same(actual, operation.snapshot)) throw new Error('La conversación cambió después del guardado. Conserva las copias para revisión.');
    base = structuredClone(operation.snapshot); archiveFloor = operation.nextRevision;
    for (const [key, entry] of captured) if (pending.get(key) === entry) pending.delete(key);
    owned = undefined; ownedRejected = false;
  }
  function persist(value: Conversation): Promise<void> {
    if (!bound) return Promise.reject(new Error('Recupera y vincula la base antes de guardar.'));
    enqueue(value.entries);
    const capture: Capture = { snapshot: structuredClone(value), pending: [...pending.entries()] };
    chain = chain.then(async () => {
      try {
        if (owned) {
          const reserved = await journal.pending();
          // If a proven pre-reservation rejection was followed by an
          // unreadable journal, retry the absence check when storage returns.
          // Never apply this inference to an uncertain begin/callback failure.
          if (ownedRejected && (!reserved || reserved.id !== owned.id)) { owned = undefined; ownedRejected = false; }
          if (owned) {
            if (reserved && reserved.id !== owned.id) throw new Error('Otra reserva está pendiente. Conserva el borrador antes de continuar.');
            // A missing callback is not permission to create a second operation.
            // resume checks the existing journal or its exact commit marker.
            await finish(owned, []);
          }
        }
        const reserved = await journal.pending();
        if (reserved) throw new Error('Hay una reserva anterior. Recupérala antes de guardar otra.');
        const baseRevision = base?.revision ?? 0;
        const nextRevision = Math.max(baseRevision, archiveFloor) + 1;
        if (!Number.isSafeInteger(nextRevision)) throw new Error('La revisión de conversación alcanzó su límite.');
        const snapshot = { ...capture.snapshot, revision: nextRevision };
        // The real composer explicitly passes `attachedWork: undefined`.
        // Remove that optional absence only; unknown fields remain for the
        // journal to reject rather than being silently discarded.
        if (snapshot.attachedWork === undefined) delete snapshot.attachedWork;
        const operation: JournalOperation = { id: identifier(), baseRevision, ...(base ? { base: structuredClone(base) } : {}), nextRevision,
          snapshot, pending: capture.pending.map(([, entry]) => structuredClone(entry)) };
        // Save this identity before begin so a lost response can only retry
        // the same reservation, never create a competing copy.
        owned = operation;
        ownedRejected = false;
        try { await journal.begin(operation); }
        catch (error) {
          if (error instanceof JournalReservationRejected) {
            // This rejection was raised before writing a new reservation. A
            // retry may use a new operation only after proving our own ID is
            // absent; unreadable state or our existing journal stays fenced.
            ownedRejected = true;
            const existing = await journal.pending();
            if (!existing || existing.id !== operation.id) { owned = undefined; ownedRejected = false; }
          }
          throw error;
        }
        await finish(operation, capture.pending);
        issue = undefined;
      } catch (error) { issue = describe(error); }
      notify();
    });
    return chain;
  }
  return {
    /** Bind only once and only after recovering old reservations. The caller
     * supplies the exact base that its visible state descends from. */
    bindBase(value: Conversation | undefined, recoveredArchiveRevision = 0) {
      if (bound || !Number.isSafeInteger(recoveredArchiveRevision) || recoveredArchiveRevision < 0) throw new Error('La base de conversación no es válida.');
      base = value === undefined ? undefined : structuredClone(value);
      archiveFloor = Math.max(archiveFloor, recoveredArchiveRevision); bound = true;
    },
    setRevision(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Revisión de conversación inválida.'); archiveFloor = Math.max(archiveFloor, value); },
    enqueue, seed: (entries: readonly ChatEntry[]) => enqueue(entries, false, true), persist, status,
    pending: () => structuredClone([...pending.values()]), settled: () => chain,
  };
}
