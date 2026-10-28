import type { Activity } from '@gentle-dot/protocol';
export type Engine = 'iphone' | 'gentle';
export type ChatActivity = Activity & { detail?: string };
export type ChatEntry = { id: string; role: 'user' | 'assistant' | 'notice'; text: string; transportText?: string; engine: Engine; state: 'complete' | 'pending' | 'interrupted'; at: number; activities?: ChatActivity[] };
export type Conversation = { entries: ChatEntry[]; draft: string; attachedWork?: string; revision?: number };
const MAX_ENTRIES = 120;
const MAX_TEXT = 32000;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function cleanEntry(value: unknown, restoring = false): ChatEntry | undefined {
  if (!record(value) || typeof value.id !== 'string' || !value.id || value.id.length > 4096 || typeof value.text !== 'string'
    || !['user', 'assistant', 'notice'].includes(value.role as string) || !['iphone', 'gentle'].includes(value.engine as string)
    || !['complete', 'pending', 'interrupted'].includes(value.state as string)
    || typeof value.at !== 'number' || !Number.isFinite(value.at) || value.at < 0) return;
  const activities = Array.isArray(value.activities) ? value.activities.filter((item): item is Activity => record(item) && typeof item.id === 'string' && item.id.length <= 512 && typeof item.title === 'string' && item.title.length <= 1000 && ['read', 'edit', 'run', 'search', 'memory', 'delegate', 'other'].includes(item.kind as string) && ['running', 'done', 'failed'].includes(item.status as string)).slice(-80).map(item => ({ id: item.id, title: item.title, kind: item.kind, status: restoring && item.status === 'running' ? 'failed' as const : item.status, ...(typeof (item as ChatActivity).detail === 'string' ? { detail: (item as ChatActivity).detail!.slice(0, 4000) } : {}) })) : [];
  // Explicit fields only: persisted data must never acquire tokens or native payloads.
  return { ...(activities.length ? { activities } : {}), id: value.id, role: value.role as ChatEntry['role'], text: value.text.slice(0, MAX_TEXT),
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
  if (index < 0) next.push(safe); else next[index] = safe;
  return next.slice(-MAX_ENTRIES);
}
type HostHistoryEntry = { id: string; role: 'user' | 'assistant'; text: string; activities?: ChatActivity[] };
/** Reconcile the host's durable snapshot IDs with its separate live-event IDs. */
export function reconcileHostHistory(entries: ChatEntry[], prefix: string, history: HostHistoryEntry[], at = Date.now(), beforePrune?: (entries: ChatEntry[]) => void): ChatEntry[] {
  const remote = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
    entry.engine === 'gentle' && entry.id.startsWith(prefix) && entry.role !== 'notice');
  const used = new Set<string>();
  const replacements = new Map<number, ChatEntry>();
  const removed = new Set<number>();
  const resolved: { entry: ChatEntry; index?: number }[] = [];
  let userAnchor: number | undefined;
  let lastMatch = -1;
  for (const item of history) {
    const id = prefix + item.id;
    let matches: typeof remote = [];
    // Pi combines consecutive assistant messages into one history turn. Only
    // coalesce text inside an identified user turn, never across another request.
    if (item.role === 'assistant' && userAnchor !== undefined) {
      const start = remote.findIndex(candidate => candidate.index === userAnchor);
      const turn: typeof remote = [];
      for (const candidate of remote.slice(start + 1)) {
        if (candidate.entry.role === 'user') break;
        if (!used.has(candidate.entry.id)) turn.push(candidate);
      }
      const combined = turn.map(({ entry }) => entry.text).filter(Boolean).join('\n\n');
      if (turn.length && (combined === item.text || (combined && item.text.startsWith(combined)
        && turn.at(-1)!.entry.state !== 'complete'))) matches = turn;
    }
    if (!matches.length) {
      const direct = remote.find(({ entry }) => !used.has(entry.id) && entry.id === id && entry.role === item.role);
      const sameText = remote.find(({ entry, index }) => index > lastMatch && !used.has(entry.id)
        && entry.role === item.role && (entry.transportText ?? entry.text) === item.text);
      const match = direct ?? sameText;
      if (match) matches = [match];
    }
    const prior = matches[0];
    const entry: ChatEntry = {
      id, role: item.role, activities: item.activities ?? matches.flatMap(match => match.entry.activities ?? []), text: prior?.entry.transportText ? prior.entry.text : item.text,
      ...(prior?.entry.transportText ? { transportText: prior.entry.transportText } : {}),
      engine: 'gentle',
      // History contains text, not the terminal outcome. Keep a known interrupted
      // assistant interrupted; seeing the user input in history confirms receipt.
      state: item.role === 'assistant' && matches.some(({ entry }) => entry.state !== 'complete') ? 'interrupted' : 'complete',
      at: prior?.entry.at ?? at,
    };
    for (const match of matches) { used.add(match.entry.id); removed.add(match.index); }
    if (prior) {
      replacements.set(prior.index, entry); removed.delete(prior.index);
      lastMatch = Math.max(lastMatch, matches.at(-1)!.index);
    }
    if (item.role === 'user') userAnchor = prior?.index;
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
    ...before.get(index) ?? [], ...(removed.has(index) ? [] : [replacements.get(index) ?? entry]),
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
async function access<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
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
          const request = operation(transaction.objectStore('conversation'));
          transaction.oncomplete = () => finish(undefined, request.result);
          transaction.onabort = () => finish(transaction?.error ?? new Error('No se guardó la conversación.'));
          transaction.onerror = () => finish(transaction?.error ?? new Error('No se guardó la conversación.'));
        } catch (error) { finish(error); }
      };
    } catch (error) { finish(error); }
  });
}
export async function loadConversation(): Promise<Conversation> {
  const saved: unknown = await access('readonly', store => store.get('current'));
  if (!record(saved)) return { entries: [], draft: '' };
  return {
    entries: cleanEntries(saved.entries, true),
    ...(Number.isSafeInteger(saved.revision) && Number(saved.revision) >= 0 ? { revision: Number(saved.revision) } : {}),
    ...(typeof saved.attachedWork === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(saved.attachedWork) ? { attachedWork: saved.attachedWork } : {}),
    draft: typeof saved.draft === 'string' ? saved.draft.slice(0, 8000) : '',
  };
}
export async function saveConversation(value: Conversation): Promise<void> {
  await access('readwrite', store => store.put({
    ...(typeof value.attachedWork === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.attachedWork) ? { attachedWork: value.attachedWork } : {}),
    ...(Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 ? { revision: Number(value.revision) } : {}),
    entries: cleanEntries(value.entries), draft: typeof value.draft === 'string' ? value.draft.slice(0, 8000) : '',
  }, 'current'));
}
