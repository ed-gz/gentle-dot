import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ChatEntry } from './conversation.ts';

export type InferenceRecord = { id: string; revision: string; startedAt: number; status: 'pending' | 'answer' | 'interrupted' | 'cancelled'; text: string };
export type InferenceSnapshot = { items: InferenceRecord[]; activeId?: string };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export async function withInferenceDeadline<T>(operation: Promise<T>, timeoutMs = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('El puente nativo no respondió a tiempo. Conservé lo que ya estaba guardado.')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
export function parseInferenceSnapshot(value: unknown): InferenceSnapshot {
  if (!object(value) || value.ok !== true || !Array.isArray(value.items) || value.items.length > 100
    || (value.activeId != null && !uuid(value.activeId))) throw new Error('No pude recuperar las respuestas nativas. Se conservan sin borrar.');
  const items = value.items.map((item): InferenceRecord => {
    if (!object(item) || !uuid(item.id) || !uuid(item.revision) || typeof item.startedAt !== 'number' || !Number.isFinite(item.startedAt)
      || item.startedAt < 0 || item.startedAt > 8_640_000_000_000_000 || !['pending', 'answer', 'interrupted', 'cancelled'].includes(String(item.status))
      || typeof item.text !== 'string' || Array.from(item.text).length > 2400 || (item.status === 'answer' && !item.text.trim())
      || (item.status === 'pending' && item.id !== value.activeId)) throw new Error('El registro nativo no es válido. Se conservó el original.');
    return { id: item.id, revision: item.revision, startedAt: item.startedAt, status: item.status as InferenceRecord['status'], text: item.text };
  });
  if (new Set(items.map(item => item.id)).size !== items.length || (value.activeId && !items.some(item => item.id === value.activeId))) throw new Error('La identidad del registro nativo no coincide.');
  return { items, ...(value.activeId ? { activeId: value.activeId as string } : {}) };
}
export async function listInferenceResults(): Promise<InferenceSnapshot> {
  if (!isTauri()) return { items: [] };
  return parseInferenceSnapshot(await withInferenceDeadline(invoke('plugin:local-intelligence|results_list')));
}
export async function acknowledgeInference(record: InferenceRecord): Promise<void> {
  const result: unknown = await withInferenceDeadline(invoke('plugin:local-intelligence|results_acknowledge', { turnId: record.id, revision: record.revision }));
  if (!object(result) || result.ok !== true) throw new Error('La copia nativa sigue pendiente de confirmación. No se borró.');
}

/** Only recovered conversation content crosses this boundary. No execution,
 * continuation, model calls, tool arguments or approval callbacks are available. */
export async function recoverInferenceResults(options: {
  list(): Promise<InferenceSnapshot>;
  find(id: string): Promise<ChatEntry | undefined>;
  apply(entry: ChatEntry): void;
  commit(): Promise<boolean>;
  acknowledge(record: InferenceRecord): Promise<void>;
  onSettled?(record: InferenceRecord, cancelled: boolean): void;
}): Promise<{ activeId?: string; recovered: number }> {
  const snapshot = await options.list();
  const completed = snapshot.items.filter(item => item.id !== snapshot.activeId);
  const cancelled = new Set<string>();
  for (const record of completed) {
    const prior = await options.find(record.id);
    if (!prior || prior.engine !== 'iphone' || prior.role === 'user') throw new Error('No encontré el turno original de una respuesta nativa. Conservé la copia para recuperarla.');
    if (prior.localCancelled) { cancelled.add(record.id); continue; }
    if (prior.state === 'complete' && record.status !== 'cancelled') {
      if (record.status !== 'answer' || prior.role !== 'assistant' || prior.text !== record.text) throw new Error('El resultado nativo difiere de la conversación guardada. Conservé ambas copias.');
      continue;
    }
    const answered = record.status === 'answer';
    options.apply({ ...prior, role: answered ? 'assistant' : 'notice', state: answered ? 'complete' : 'interrupted',
      text: (!answered && record.status !== 'cancelled' && prior.state === 'interrupted' && prior.text) || record.text || 'La respuesta local quedó interrumpida. Revisa el progreso antes de continuar; no repetí ninguna operación.',
      ...(record.status === 'cancelled' ? { localCancelled: true } : {}) });
  }
  if (completed.length) {
    if (!await options.commit()) throw new Error('La conversación no confirmó el guardado. Las respuestas siguen en el almacenamiento nativo.');
    for (const record of completed) {
      await options.acknowledge(record);
      try { options.onSettled?.(record, cancelled.has(record.id) || record.status === 'cancelled'); }
      catch { /* Presentation must not undo a confirmed conversation and ACK. */ }
    }
  }
  return { activeId: snapshot.activeId, recovered: completed.length };
}
