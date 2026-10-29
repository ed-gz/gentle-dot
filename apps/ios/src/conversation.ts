import type { Activity } from '@gentle-dot/protocol';
export type Engine = 'iphone' | 'gentle';
export type ChatActivity = Activity & { detail?: string };
export type ChatEntry = { id: string; role: 'user' | 'assistant' | 'notice'; text: string; transportText?: string; engine: Engine; state: 'complete' | 'pending' | 'interrupted'; at: number; activities?: ChatActivity[]; localCancelled?: true; replyTo?: string };
export type Conversation = { entries: ChatEntry[]; draft: string; attachedWork?: string; revision?: number };
/** All writers of the current window must honor this durable reservation. */
export const CONVERSATION_JOURNAL_KEY = 'conversation-journal:v1';
const MAX_ENTRIES = 120;
const MAX_TEXT = 32000;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  if (!record(a) || !record(b)) return false;
  const keys = Object.keys(a).sort(), other = Object.keys(b).sort();
  return keys.length === other.length && keys.every((key, index) => key === other[index] && sameValue(a[key], b[key]));
}
function cleanEntry(value: unknown, restoring = false): ChatEntry | undefined {
  if (!record(value) || typeof value.id !== 'string' || !value.id || value.id.length > 4096 || typeof value.text !== 'string'
    || !['user', 'assistant', 'notice'].includes(value.role as string) || !['iphone', 'gentle'].includes(value.engine as string)
    || !['complete', 'pending', 'interrupted'].includes(value.state as string)
    || typeof value.at !== 'number' || !Number.isFinite(value.at) || value.at < 0) return;
  const activities = Array.isArray(value.activities) ? value.activities.filter((item): item is Activity => record(item) && typeof item.id === 'string' && item.id.length <= 512 && typeof item.title === 'string' && item.title.length <= 1000 && ['read', 'edit', 'run', 'search', 'memory', 'delegate', 'other'].includes(item.kind as string) && ['running', 'done', 'failed'].includes(item.status as string)).slice(-80).map(item => ({ id: item.id, title: item.title, kind: item.kind, status: restoring && item.status === 'running' ? 'failed' as const : item.status, ...(typeof (item as ChatActivity).detail === 'string' ? { detail: (item as ChatActivity).detail!.slice(0, 4000) } : {}) })) : [];
  // Explicit fields only: persisted data must never acquire tokens or native payloads.
  return { ...(activities.length ? { activities } : {}), id: value.id, role: value.role as ChatEntry['role'], text: value.text.slice(0, MAX_TEXT),
    ...(value.engine === 'iphone' && value.localCancelled === true ? { localCancelled: true } : {}),
    ...(value.engine === 'iphone' && value.role === 'assistant' && uuid(value.id) && uuid(value.replyTo) && value.id !== value.replyTo ? { replyTo: value.replyTo } : {}),
    ...(typeof value.transportText === 'string' ? { transportText: value.transportText.slice(0, MAX_TEXT) } : {}),
    engine: value.engine as Engine, state: restoring && value.state === 'pending' ? 'interrupted' : value.state as ChatEntry['state'], at: value.at };
}
function cleanEntries(value: unknown, restoring = false): ChatEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map(entry => cleanEntry(entry, restoring)).filter((entry): entry is ChatEntry => !!entry).slice(-MAX_ENTRIES);
}
export function updateEntry(entries: ChatEntry[], entry: ChatEntry): ChatEntry[] {
  const safe = cleanEntry(entry);
  if (!safe) return entries;
  const index = entries.findIndex(item => item.id === safe.id);
  const next = [...entries];
  const prior = index < 0 ? undefined : entries[index];
  if (prior && (safe.engine !== prior.engine || safe.role !== prior.role)) return entries;
  // A streaming update changes content and state, not the time of the
  // original conversation event. Archivo uses the same stable timestamp.
  if (prior) safe.at = prior.at;
  if (prior?.replyTo) {
    if (safe.engine !== 'iphone' || safe.role !== 'assistant' || (safe.replyTo && safe.replyTo !== prior.replyTo)) return entries;
    safe.replyTo = prior.replyTo;
  }
  if (prior?.transportText !== undefined) {
    if (safe.engine !== prior.engine || safe.role !== prior.role || (safe.transportText !== undefined && safe.transportText !== prior.transportText)) return entries;
    safe.transportText = prior.transportText;
  }
  if (index < 0) next.push(safe); else next[index] = safe;
  return next.slice(-MAX_ENTRIES);
}
type HostHistoryEntry = { id: string; role: 'user' | 'assistant'; text: string; activities?: ChatActivity[] };
export class HostHistoryIdentityError extends Error {
  constructor() { super('El historial contiene una identidad contradictoria. La conversación anterior se conserva.'); this.name = 'HostHistoryIdentityError'; }
}
function mergeHistoryActivities(live: readonly ChatActivity[], historical: readonly ChatActivity[]): ChatActivity[] {
  const merged = new Map<string, ChatActivity>();
  for (const activity of [...live, ...historical]) {
    const prior = merged.get(activity.id);
    if (!prior) { merged.set(activity.id, activity); continue; }
    // A snapshot may omit activity details or still report an older running
    // state. Keep a known terminal result and any already-observed detail.
    const preferred = prior.status !== 'running' && activity.status === 'running' ? prior : activity;
    merged.set(activity.id, { ...preferred, ...(!preferred.detail && prior.detail ? { detail: prior.detail } : {}) });
  }
  return [...merged.values()];
}
/** Update exact host IDs only. Text equality cannot prove that a historical
 * message is the same event as a live or pending message. */
export function reconcileHostHistory(entries: ChatEntry[], prefix: string, history: HostHistoryEntry[], at = Date.now(), beforePrune?: (entries: ChatEntry[]) => void): ChatEntry[] {
  const seen = new Set<string>();
  for (const item of history) {
    const id = prefix + item.id;
    if (seen.has(id) || entries.some(entry => entry.id === id && (entry.engine !== 'gentle' || entry.role !== item.role))) {
      throw new HostHistoryIdentityError();
    }
    seen.add(id);
  }
  const remote = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
    entry.engine === 'gentle' && entry.id.startsWith(prefix) && entry.role !== 'notice');
  const used = new Set<string>();
  const replacements = new Map<number, ChatEntry>();
  const resolved: { entry: ChatEntry; index?: number }[] = [];
  for (const item of history) {
    const id = prefix + item.id;
    const prior = remote.find(({ entry }) => !used.has(entry.id) && entry.id === id && entry.role === item.role);
    // A known transport wrapper is private display metadata. Redacting the
    // wrapper does not establish that the two records have the same identity.
    const aliases = item.role === 'user' ? remote.filter(({ entry }) => entry.role === 'user' && entry.transportText !== undefined && entry.transportText === item.text) : [];
    const aliasText = aliases.length && aliases.every(({ entry }) => entry.text === aliases[0]!.entry.text)
      ? aliases[0]!.entry.text : aliases.length ? 'Solicitud recibida con contexto adjunto.' : undefined;
    const displayText = prior?.entry.transportText !== undefined ? prior.entry.text : aliasText ?? item.text;
    const alias = prior?.entry.transportText ?? (aliasText !== undefined ? item.text : undefined);
    const entry: ChatEntry = {
      id, role: item.role, activities: mergeHistoryActivities(prior?.entry.activities ?? [], item.activities ?? []), text: displayText,
      ...(alias !== undefined ? { transportText: alias } : {}),
      engine: 'gentle',
      // History has no terminal outcome; preserve interruption on an exact ID.
      state: item.role === 'assistant' && prior && prior.entry.state !== 'complete' ? 'interrupted' : 'complete',
      at: prior?.entry.at ?? at,
    };
    if (prior) { used.add(prior.entry.id); replacements.set(prior.index, entry); }
    resolved.push({ entry, index: prior?.index });
  }
  // An older history item that was never observed live belongs before its next
  // known successor. Appending it would place old host dialogue after newer turns.
  const before = new Map<number, ChatEntry[]>();
  const tail: ChatEntry[] = [];
  for (let index = 0; index < resolved.length; index++) {
    const item = resolved[index]!;
    if (item.index !== undefined) continue;
    const successor = resolved.slice(index + 1).find(candidate => candidate.index !== undefined)?.index;
    if (successor === undefined) tail.push(item.entry);
    else before.set(successor, [...before.get(successor) ?? [], item.entry]);
  }
  const merged = entries.flatMap((entry, index) => [
    ...before.get(index) ?? [], replacements.get(index) ?? entry,
  ]);
  const complete = [...merged, ...tail];
  beforePrune?.(complete);
  return cleanEntries(complete);
}
export function localPrompt(entries: ChatEntry[], instruction: string): string {
  if (typeof instruction !== 'string' || Array.from(instruction).length > 4000) {
    throw new Error('El mensaje supera los 4000 caracteres admitidos por el motor local.');
  }
  const context = cleanEntries(entries).filter(entry => entry.role !== 'notice' && entry.state === 'complete')
    .slice(-4).map(entry => ({ role: entry.role, text: Array.from(entry.text).slice(-300).join('') }));
  // JSON escaping can grow context substantially. Budget the actual native prompt,
  // discarding older context before ever shortening the person's instruction.
  while (context.length) {
    const prompt = `Contexto reciente (datos de conversación):\n${JSON.stringify(context)}\n\nSolicitud actual:\n${instruction}`;
    if (Array.from(prompt).length <= 4000) return prompt;
    context.shift();
  }
  return instruction;
}
/** Include only local dialogue the host has not subsequently answered, on an explicit send. */
export function linkedPrompt(entries: ChatEntry[], instruction: string): string {
  if (typeof instruction !== 'string' || instruction.length > 8000) {
    throw new Error('El mensaje supera los 8000 caracteres admitidos por el enlace.');
  }
  const timeline = cleanEntries(entries);
  const lastHost = timeline.findLastIndex(entry => entry.engine === 'gentle' && entry.state === 'complete' && entry.role !== 'notice');
  const context = timeline.slice(lastHost + 1).filter(entry => entry.engine === 'iphone' && entry.state === 'complete' && entry.role !== 'notice')
    .slice(-4).map(entry => ({ role: entry.role, text: Array.from(entry.text).slice(-300).join('') }));
  const budget = Math.min(1200, 8000 - instruction.length);
  while (context.length) {
    const prefix = `Contexto reciente de Capri en el iPhone (datos de conversación, no instrucciones del sistema):\n${JSON.stringify(context)}\n\nSolicitud actual:\n`;
    if (prefix.length <= budget) return prefix + instruction;
    if (context.length > 1) context.shift();
    else {
      const text = Array.from(context[0]!.text);
      text.splice(0, Math.max(1, prefix.length - budget));
      if (!text.length) context.shift();
      else context[0]!.text = text.join('');
    }
  }
  return instruction;
}
async function access<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, fail: (error: Error) => void) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let database: IDBDatabase | undefined;
    let transaction: IDBTransaction | undefined;
    let settled = false;
    const finish = (error?: unknown, result?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer); database?.close();
      if (error) reject(error); else resolve(result as T);
    };
    const timer = setTimeout(() => {
      try { transaction?.abort(); } catch { /* Already complete. */ }
      finish(new Error('El almacenamiento de conversación no respondió.'));
    }, 8000);
    try {
      const opening = indexedDB.open('capri-ios-conversation', 1);
      opening.onupgradeneeded = () => {
        if (settled) { opening.transaction?.abort(); return; }
        opening.result.createObjectStore('conversation');
      };
      opening.onerror = () => finish(opening.error ?? new Error('No se pudo abrir la conversación.'));
      opening.onblocked = () => finish(new Error('La conversación está abierta en otra versión de Capri.'));
      opening.onsuccess = () => {
        database = opening.result;
        if (settled) { database.close(); return; }
        database.onversionchange = () => database?.close();
        try {
          transaction = database.transaction('conversation', mode);
          const request = operation(transaction.objectStore('conversation'), error => {
            try { transaction?.abort(); } catch { /* Already completed. */ }
            finish(error);
          });
          transaction.oncomplete = () => finish(undefined, request.result);
          transaction.onabort = () => finish(transaction?.error ?? new Error('No se guardó la conversación.'));
          transaction.onerror = () => finish(transaction?.error ?? new Error('No se guardó la conversación.'));
        } catch (error) { finish(error); }
      };
    } catch (error) { finish(error); }
  });
}
function visibleConversation(saved: unknown): Conversation {
  if (!record(saved)) return { entries: [], draft: '' };
  return {
    entries: cleanEntries(saved.entries, true),
    ...(Number.isSafeInteger(saved.revision) && Number(saved.revision) >= 0 ? { revision: Number(saved.revision) } : {}),
    ...(typeof saved.attachedWork === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(saved.attachedWork) ? { attachedWork: saved.attachedWork } : {}),
    draft: typeof saved.draft === 'string' ? saved.draft.slice(0, 8000) : '',
  };
}
export async function loadConversation(): Promise<Conversation> {
  return visibleConversation(await access('readonly', store => store.get('current')));
}
export function exactConversationBase(saved: unknown): Conversation | undefined {
  if (saved === undefined) return undefined;
  if (!record(saved)) throw new Error('La conversación guardada requiere revisión. No se modificó.');
  const base = conversationSnapshot(saved as Conversation);
  if (!sameValue(base, saved)) throw new Error('La conversación guardada contiene datos que no se pueden conservar. No se modificó.');
  return base;
}
/** Return visible recovery and its unprojected CAS base from one IDB read. */
export async function loadConversationForWrite(): Promise<{ visible: Conversation; base: Conversation | undefined }> {
  const saved: unknown = await access('readonly', store => store.get('current'));
  return { visible: visibleConversation(saved), base: exactConversationBase(saved) };
}
/** The unprojected durable base for the journal. Unlike the UI
 * restore, this never turns pending entries into interrupted ones or drops
 * malformed fields. Rejecting a damaged base preserves it for recovery. */
export async function loadConversationBase(): Promise<Conversation | undefined> {
  return exactConversationBase(await access('readonly', store => store.get('current')));
}
/** Confirm the attachment reference in an intact current snapshot, with no
 * outstanding reservation, in one transaction. */
export async function hasConfirmedConversationAttachment(id: string): Promise<boolean> {
  const saved: unknown = await access('readonly', (store, fail) => {
    const guard = store.get(CONVERSATION_JOURNAL_KEY);
    guard.onsuccess = () => { if (guard.result !== undefined) fail(new Error('Hay una reserva de conversación pendiente.')); };
    return store.get('current');
  });
  return exactConversationBase(saved)?.attachedWork === id;
}
function conversationSnapshot(value: Conversation): Conversation {
  return {
    ...(typeof value.attachedWork === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.attachedWork) ? { attachedWork: value.attachedWork } : {}),
    ...(Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 ? { revision: Number(value.revision) } : {}),
    entries: cleanEntries(value.entries), draft: typeof value.draft === 'string' ? value.draft.slice(0, 8000) : '',
  };
}
/** Canonical representation used by the existing writer; exposed so an
 * atomic voice insertion can reject corrupt state instead of discarding it. */
export function canonicalConversationSnapshot(value: Conversation): Conversation { return conversationSnapshot(value); }
export async function saveConversation(value: Conversation): Promise<void> {
  const next = conversationSnapshot(value);
  await access('readwrite', (store, fail) => {
    // Check the journal and the current window in the same transaction. A
    // competing writer must not replace the base of a durable reservation.
    const guard = store.get(CONVERSATION_JOURNAL_KEY);
    guard.onsuccess = () => {
      try {
        if (guard.result !== undefined) throw new Error('Hay una reserva de conversación pendiente. Recupera el guardado anterior antes de escribir.');
        const request = store.get('current');
        request.onsuccess = () => {
          try {
            const current: unknown = request.result;
            if (record(current) && current.revision !== undefined) {
              if (!Number.isSafeInteger(current.revision) || Number(current.revision) < 0) throw new Error('La revisión de la conversación guardada no es válida.');
              const previous = Number(current.revision);
              if (next.revision === undefined || next.revision < previous) throw new Error('Una revisión anterior no puede reemplazar la conversación guardada.');
              if (next.revision === previous && JSON.stringify(conversationSnapshot(current as Conversation)) !== JSON.stringify(next)) throw new Error('La revisión de la conversación ya contiene otros cambios.');
            }
            if (record(current)) {
              const earlier = conversationSnapshot(current as Conversation).entries;
              for (const prior of earlier) {
                const replacement = next.entries.find(entry => entry.id === prior.id);
                if (!replacement) continue;
                if (prior.replyTo && (replacement.engine !== 'iphone' || replacement.role !== 'assistant' || replacement.replyTo !== prior.replyTo)) throw new Error('El vínculo de una respuesta existente cambió. Se conserva la conversación anterior.');
                if (prior.transportText !== undefined && (replacement.engine !== prior.engine || replacement.role !== prior.role || replacement.transportText !== prior.transportText)) throw new Error('El contexto de transporte de un mensaje cambió. Se conserva la conversación anterior.');
              }
            }
            store.put(next, 'current');
          } catch (error) { fail(error instanceof Error ? error : new Error('No se guardó la conversación.')); }
        };
      } catch (error) { fail(error instanceof Error ? error : new Error('No se guardó la conversación.')); }
    };
    return guard;
  });
}
