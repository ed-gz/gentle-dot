import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { historyFromMessages, type HistoryPage } from './conversations.ts';
import { sessionIndex, sessionRecords, readTurnMessages } from './session-index.ts';
import type { HistoryMessage } from '@gentle-dot/protocol';

/** Private metadata only: never cache message text or binary attachments. */
type Entry = { id: string; parent: string | null; start: number; end: number; fingerprint: string; role?: string; message: boolean };
type Projection = { identity: string; size: number; mtimeMs: number; offset: number; sessionId?: string; header?: { start: number; end: number; fingerprint: string }; headerSeen: boolean; latest?: string; entries: Map<string, Entry>; missing: boolean; invalid: boolean; legacy: boolean; hasFork: boolean; children: Map<string | null, number> };
type Turn = { id: string; messages: Entry[]; legacyIndex?: number };
const BRANCH_PAGE = /^s(\d+)-(x[a-f0-9]{64}|\d+)$/;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const cache = new Map<string, Projection>();

/** Metadata scan for an explicit Pi tree. Incomplete or ambiguous trees fail closed. */
function scan(file: string): Projection {
  const empty = (): Projection => ({ identity: '', size: 0, mtimeMs: 0, offset: 0, headerSeen: false, entries: new Map(), missing: false, invalid: false, legacy: false, hasFork: false, children: new Map() });
  if (!existsSync(file)) { const result = empty(); result.legacy = true; return result; }
  const stat = statSync(file), identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  let result = cache.get(file);
  if (!result || result.identity !== identity || stat.size < result.size || (stat.size === result.size && stat.mtimeMs !== result.mtimeMs)) {
    result = empty(); result.identity = identity;
  }
  if (stat.size > result.size && result.latest) {
    const last = result.entries.get(result.latest);
    const record = last && [...sessionRecords(file, last.start, last.end, undefined, undefined, true)][0];
    const header = result.header && [...sessionRecords(file, result.header.start, result.header.end, undefined, undefined, true)][0];
    if (!last || record?.fingerprint !== last.fingerprint || (result.header && header?.fingerprint !== result.header.fingerprint)) { cache.delete(file); return scan(file); }
  }
  const state = result;
  try {
    if (stat.size > state.offset) for (const { start, end, entry, fingerprint } of sessionRecords(file, state.offset, stat.size, offset => { state.offset = offset; }, () => { state.invalid = true; }, true)) {
      state.offset = end;
      if (entry.type === 'session') {
        if (state.headerSeen) throw new Error('El archivo contiene más de una identidad de sesión.');
        if (!fingerprint) throw new Error('No se pudo verificar la identidad de sesión.');
        state.headerSeen = true; state.header = { start, end, fingerprint }; if (validId(entry.id)) state.sessionId = entry.id;
        continue;
      }
      if (!validId(entry.id) && entry.parentId === undefined) { state.missing = true; continue; }
      if (!validId(entry.id) || (entry.parentId !== null && !validId(entry.parentId))) throw new Error('El árbol de sesión tiene una identidad o un padre inválidos. Se conserva el historial anterior.');
      if (state.entries.has(entry.id) || state.entries.size >= 200_000) throw new Error('La identidad del árbol de sesión es ambigua. Se conserva el historial anterior.');
      const message = entry.type === 'message' && !!entry.message && typeof entry.message === 'object' && !Array.isArray(entry.message);
      const role = message ? (entry.message as Record<string, unknown>).role : undefined;
      if (entry.type === 'message' && (!message || typeof role !== 'string')) throw new Error('El árbol de sesión contiene un mensaje inválido. Se conserva el historial anterior.');
      const parent = entry.parentId as string | null;
      if (!fingerprint) throw new Error('No se pudo verificar la entrada de sesión.');
      state.entries.set(entry.id, { id: entry.id, parent, start, end, fingerprint, message, ...(typeof role === 'string' ? { role } : {}) });
      const childCount = (state.children.get(parent) ?? 0) + 1; state.children.set(parent, childCount); if (childCount > 1) state.hasFork = true;
      state.latest = entry.id;
    }
    if (state.entries.size && state.missing) throw new Error('El árbol de sesión tiene entradas sin identidad. Se conserva el historial anterior.');
    if (state.entries.size && state.invalid) throw new Error('El árbol de sesión contiene registros dañados. Se conserva el historial anterior.');
    if (state.entries.size && !state.sessionId) throw new Error('El archivo no tiene una identidad de sesión verificable.');
    state.legacy = !state.entries.size && state.missing; state.size = stat.size; state.mtimeMs = stat.mtimeMs;
    cache.delete(file); cache.set(file, state); if (cache.size > 8) cache.delete(cache.keys().next().value!);
    return state;
  } catch (error) { cache.delete(file); throw error; }
}
function turns(file: string, projection: Projection, leaf: string | null): Turn[] {
  if (leaf === null) return [];
  if (!validId(leaf)) throw new Error('No se pudo verificar la rama activa de Pi.');
  const branch: Entry[] = [], visited = new Set<string>(); let current: string | null = leaf;
  while (current !== null) {
    if (visited.has(current) || !projection.entries.has(current)) throw new Error('La rama de sesión está incompleta o es ambigua. Se conserva el historial anterior.');
    visited.add(current); const entry: Entry = projection.entries.get(current)!;
    const record = [...sessionRecords(file, entry.start, entry.end, undefined, undefined, true)][0];
    if (record?.fingerprint !== entry.fingerprint || record.entry.id !== entry.id) throw new Error('La sesión cambió durante la lectura. Se conserva el historial anterior.');
    branch.push(entry); current = entry.parent;
  }
  branch.reverse();
  const groups: Entry[][] = []; let role: string | undefined;
  for (const entry of branch) {
    if (!entry.message) continue;
    if (entry.role === 'user') { groups.push([entry]); role = 'user'; }
    else if (entry.role === 'assistant') { if (role !== 'assistant') { groups.push([]); role = 'assistant'; } groups.at(-1)!.push(entry); }
    else if (role === 'assistant') groups.at(-1)!.push(entry);
  }
  return groups.map(messages => ({ id: `x${createHash('sha256').update(JSON.stringify(messages.map(value => [value.id, value.fingerprint]))).digest('hex')}`, messages }));
}
function readTurn(file: string, turn: Turn): HistoryMessage | undefined {
  const messages: unknown[] = turn.legacyIndex === undefined ? [] : readTurnMessages(file, turn.legacyIndex, turn.legacyIndex + 1);
  for (const reference of turn.messages) {
    const record = [...sessionRecords(file, reference.start, reference.end, undefined, undefined, true)][0];
    const entry = record?.entry;
    if (!entry || record.fingerprint !== reference.fingerprint || entry.id !== reference.id || entry.type !== 'message' || !entry.message) throw new Error('La sesión cambió durante la lectura. Se conserva el historial anterior.');
    messages.push(entry.message);
  }
  const result = historyFromMessages(messages);
  if (result.length !== 1) throw new Error('No se pudo verificar el turno de sesión. Se conserva el historial anterior.');
  return result[0];
}

/** Leaf is obtained from Pi's native RPC, not inferred from physical order. */
export function pageBranchHistory(chain: string[], limit: number, leaf: string | null, before?: string): HistoryPage {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new Error('Límite de historial inválido.');
  const projections = chain.map(scan);
  // Older rotations retain the file, but not its selected leaf. Present their
  // physical history as explicitly unverified, never as an active branch.
  const rows = projections.map((value, index) => value.legacy || index < chain.length - 1
    ? sessionIndex(chain[index]!).turns.map((_, legacyIndex) => ({ id: String(legacyIndex + 1), messages: [], legacyIndex }))
    : turns(chain[index]!, value, index === chain.length - 1 ? leaf : value.latest ?? null));
  let file = chain.length - 1, end = file >= 0 ? rows[file]!.length : 0;
  if (before !== undefined) {
    const match = BRANCH_PAGE.exec(before); if (!match) throw new Error('El cursor ya no corresponde a esta rama.');
    file = Number(match[1]); if (!Number.isSafeInteger(file) || file >= chain.length) throw new Error('El cursor ya no corresponde a esta rama.');
    end = rows[file]!.findIndex(turn => turn.id === match[2]); if (end < 0) throw new Error('El cursor ya no corresponde a esta rama.');
  }
  const messages: HistoryMessage[] = [];
  for (; file >= 0; file--, end = file >= 0 ? rows[file]!.length : 0) {
    const row = rows[file]!; const start = Math.max(0, end - (limit - messages.length));
    const prior = file < chain.length - 1 ? { earlier: true as const, branchUnverified: true as const } : {};
    messages.unshift(...row.slice(start, end).map(turn => ({ ...readTurn(chain[file]!, turn)!, id: `s${file}-${turn.id}`, ...prior })));
    if (messages.length >= limit) return { messages, hasEarlier: start > 0 || rows.slice(0, file).some(value => value.length > 0) };
  }
  return { messages, hasEarlier: false };
}

/** Requesting entries after the latest recorded ID normally returns no content. */
export function lastIndexedPiEntry(file: string): { id?: string; sessionId?: string; exists: boolean; legacy: boolean; hasFork: boolean } {
  const exists = existsSync(file); const result = scan(file); return { ...(result.latest ? { id: result.latest } : {}), ...(result.sessionId ? { sessionId: result.sessionId } : {}), exists, legacy: result.legacy, hasFork: result.hasFork };
}
