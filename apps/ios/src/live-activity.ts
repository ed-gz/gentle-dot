import { invoke, isTauri } from '@tauri-apps/api/core';

export type ActivityOrigin = 'iphone' | 'laptop';
export type ActivityPhase = 'thinking' | 'working' | 'attention' | 'waiting';
export type ActivityEnd = 'finished' | 'interrupted' | 'dismissed';
export type ActivityUpdate = { turnId: string; origin: ActivityOrigin; phase: ActivityPhase | ActivityEnd; sequence: number; id?: string };
export type ActivityItem = { id: string; turnId: string; origin: ActivityOrigin; phase: ActivityPhase | ActivityEnd; sequence: number; observedAt: number; stale: boolean };
type Invoke = (command: string, request: Record<string, unknown>) => Promise<unknown>;
const uuid = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(s);
const identifier = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const origins = new Set(['iphone', 'laptop']), active = new Set(['thinking', 'working', 'attention', 'waiting']), ended = new Set(['finished', 'interrupted', 'dismissed']);
const native: Invoke = (command, request) => invoke(`plugin:device-bridge|live_activity_${command}`, { request });
function validRequest(value: ActivityUpdate, end: boolean, hasID: boolean): boolean {
  return object(value) && uuid(value.turnId) && origins.has(value.origin) && (end ? ended : active).has(value.phase)
    && Number.isSafeInteger(value.sequence) && value.sequence >= 0 && value.sequence <= 1_000_000_000
    && (hasID ? identifier(value.id) : value.id === undefined);
}
function result(value: unknown): Record<string, unknown> {
  if (!object(value) || typeof value.ok !== 'boolean') throw new Error('La actividad devolvió un estado inválido.');
  if (!value.ok) throw new Error(typeof value.message === 'string' && value.message.length <= 300 ? value.message : 'No se confirmó la actividad.');
  return value;
}
function parseItems(value: unknown): ActivityItem[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('El inventario de actividades no es válido.');
  const entries = value.map((raw): ActivityItem => {
    if (!object(raw) || !identifier(raw.id) || !uuid(raw.turnId) || typeof raw.origin !== 'string' || !origins.has(raw.origin)
      || typeof raw.phase !== 'string' || (!active.has(raw.phase) && !ended.has(raw.phase))
      || !Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 0 || Number(raw.sequence) > 1_000_000_000
      || typeof raw.observedAt !== 'number' || !Number.isFinite(raw.observedAt) || raw.observedAt < 0 || raw.observedAt > 8_640_000_000_000_000
      || typeof raw.stale !== 'boolean') throw new Error('La actividad contiene un estado inválido.');
    return { id: raw.id, turnId: raw.turnId, origin: raw.origin as ActivityOrigin, phase: raw.phase as ActivityItem['phase'], sequence: Number(raw.sequence), observedAt: raw.observedAt, stale: raw.stale };
  });
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('La actividad tiene identificadores duplicados.');
  return entries;
}
async function deadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('La actividad no respondió a tiempo. Consulta su estado antes de volver a intentar.')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

/** No automatic start or replay. Each caller first inspects the system's real
 * activities; a lost native result invalidates that inspection until rechecked. */
export function createLiveActivityBridge(options: { call?: Invoke; installed?: boolean; timeoutMs?: number } = {}) {
  const call = options.call ?? native, installed = options.installed ?? isTauri(), timeoutMs = options.timeoutMs ?? 8000;
  let inspected = false, inFlight = false;
  async function send(command: string, request: Record<string, unknown>, mutate: boolean): Promise<Record<string, unknown>> {
    if (!installed) throw new Error('Las Actividades en vivo requieren la app instalada en el iPhone.');
    if (inFlight) throw new Error('Espera a que termine la consulta o actualización de la actividad.');
    if (mutate && !inspected) throw new Error('Consulta la actividad antes de iniciarla o actualizarla.');
    inFlight = true;
    try {
      let value: unknown;
      try { value = await deadline(call(command, request), timeoutMs); }
      catch (error) { if (mutate) inspected = false; throw error; }
      try { return result(value); }
      catch (error) { if (mutate) inspected = false; throw error; }
    } finally { inFlight = false; }
  }
  return {
    async availability(): Promise<boolean> {
      const value = await send('available', {}, false);
      if (typeof value.enabled !== 'boolean') throw new Error('La disponibilidad de la actividad no es válida.');
      return value.enabled;
    },
    async list(): Promise<ActivityItem[]> {
      inspected = false;
      const value = await send('list', {}, false), items = parseItems(value.items);
      inspected = true; return items;
    },
    async start(update: ActivityUpdate): Promise<ActivityItem> {
      if (!validRequest(update, false, false)) throw new Error('El turno o estado de la actividad no es válido.');
      const { turnId, origin, phase, sequence } = update;
      const value = await send('start', { turnId, origin, phase, sequence }, true);
      try {
        const items = parseItems(value.items);
        if (items.length !== 1 || value.id !== items[0]!.id || items[0]!.turnId !== turnId || items[0]!.origin !== origin) throw new Error('La actividad iniciada no coincide con el turno.');
        return items[0]!;
      } catch (error) { inspected = false; throw error; }
    },
    async update(update: ActivityUpdate, ending = false): Promise<void> {
      if (!validRequest(update, ending, true)) throw new Error('El turno o estado de la actividad no es válido.');
      const { turnId, origin, phase, sequence, id } = update;
      const value = await send(ending ? 'end' : 'update', { turnId, origin, phase, sequence, id }, true);
      if (value.id !== id) { inspected = false; throw new Error('La actualización no coincide con la actividad solicitada.'); }
    },
  };
}
