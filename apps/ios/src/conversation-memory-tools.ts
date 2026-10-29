import type { Tool, ToolContext } from './agent-tools.ts';
import { conversationArchive, memoryTerms, type ArchivePage, type ArchiveQuery, type ArchiveRecord, type createConversationArchive } from './conversation-archive.ts';
type MemoryStore = Pick<ReturnType<typeof createConversationArchive>, 'page' | 'search' | 'load'>;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function args(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Argumentos de memoria inválidos.'); return value;
}
function query(value: Record<string, unknown>): ArchiveQuery {
  const limit = value.limit ?? 3;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 10 || (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 8192)) || (value.scope !== undefined && (typeof value.scope !== 'string' || !value.scope || value.scope.length > 2048)) || (value.engine !== undefined && value.engine !== 'iphone' && value.engine !== 'gentle')) throw new Error('Filtros de memoria inválidos.');
  return { limit: Number(limit), ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}), ...(typeof value.scope === 'string' ? { scope: value.scope } : {}), ...(value.engine === 'iphone' || value.engine === 'gentle' ? { engine: value.engine } : {}) };
}
const source = (record: ArchiveRecord) => ({ key: record.key, entryId: record.id, scope: record.scope, engine: record.engine, role: record.role, state: record.state, timestamp: new Date(record.at).toISOString(), timestampKind: 'conversation-event' as const,
  ...(record.branchUnverified ? { branchUnverified: true, warning: 'La pertenencia a la rama activa no está verificada.' } : {}) });
function excerpt(record: ArchiveRecord, offset = 0, length = 650) {
  const end = Math.min(record.text.length, offset + length);
  return { source: source(record), text: record.text.slice(offset, end), offset, end, totalCharacters: record.text.length, partial: offset > 0 || end < record.text.length, ...(end < record.text.length ? { nextOffset: end } : {}) };
}
function result(page: ArchivePage, terms?: string[]) {
  return {
    hasMore: page.hasMore, ...(page.cursor ? { cursor: page.cursor } : {}), scanned: page.scanned,
    warning: page.hasMore ? 'Esta página no cubre todo el archivo. Usa el cursor antes de afirmar que no existe otra coincidencia.' : undefined,
    records: page.entries.map(record => {
      const first = terms?.length ? record.text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es').indexOf(terms[0]!) : 0;
      return excerpt(record, Math.max(0, first - 150));
    }),
    evidenceOnly: true,
  };
}
function recallArguments(value: unknown) {
  const input = args(value, ['entryKey','activityIndex','offset','cursor','limit','scope','engine']);
  if (input.entryKey !== undefined) {
    if (typeof input.entryKey !== 'string' || !input.entryKey || input.entryKey.length > 8192 || ['cursor','limit','scope','engine'].some(key => input[key] !== undefined)) throw new Error('Usa la referencia del mensaje sin filtros de página.');
    const offset = input.offset ?? 0; if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 32000) throw new Error('Desplazamiento de texto inválido.');
    if (input.activityIndex !== undefined && (!Number.isInteger(input.activityIndex) || Number(input.activityIndex) < 0 || Number(input.activityIndex) > 79)) throw new Error('Índice de actividad inválido.');
    return { entryKey: input.entryKey, offset: Number(offset), ...(input.activityIndex === undefined ? {} : { activityIndex: Number(input.activityIndex) }) };
  }
  if (input.offset !== undefined || input.activityIndex !== undefined) throw new Error('El desplazamiento requiere una referencia de mensaje.');
  return query(input);
}
function searchArguments(value: unknown) {
  const input = args(value, ['query','cursor','limit','scope','engine']);
  if (typeof input.query !== 'string') throw new Error('Escribe qué texto quieres buscar en la conversación.');
  memoryTerms(input.query); return { query: input.query, ...query(input) };
}
/** Retrieval over stored messages, never fabricated personal facts or a hidden summary. */
export function createMemoryTools(store: MemoryStore = conversationArchive): Tool[] {
  const properties = { cursor: { type: 'string', description: 'Cursor devuelto por la misma consulta; omitir para la primera página.' }, limit: { type: 'integer', minimum: 1, maximum: 10 }, scope: { type: 'string', description: 'Origen exacto devuelto por una coincidencia; omitir para todos.' }, engine: { type: 'string', enum: ['iphone','gentle'] } };
  return [
    {
      definition: { name: 'recall_history', description: 'Recupera conversación offline con fuente, fecha y estado. Pagina hacia mensajes anteriores, o lee más texto de un entryKey concreto. Registros con el mismo texto pueden ser copias o eventos distintos; no se deduce su identidad. Un mensaje interrumpido o una afirmación del usuario no demuestra una acción ejecutada.', parameters: { type: 'object', additionalProperties: false, properties: { ...properties, entryKey: { type: 'string', description: 'source.key de un mensaje encontrado, para leer su contenido exacto.' }, offset: { type: 'integer', minimum: 0, maximum: 32000 }, activityIndex: { type: 'integer', minimum: 0, maximum: 79, description: 'Con entryKey, lee un resultado de herramienta conservado. offset pagina su texto exacto.' } } } },
      validate: recallArguments,
      async execute(value, context: ToolContext) {
        context.signal.throwIfAborted(); const input = recallArguments(value);
        if ('entryKey' in input) {
          const record = await store.load(input.entryKey);
          context.signal.throwIfAborted();
          if (!record) return { found: false, entryKey: input.entryKey, evidenceOnly: true };
          if (input.activityIndex !== undefined) {
            const activity = record.activities?.[input.activityIndex]; if (!activity) return { found: false, source: source(record), activityIndex: input.activityIndex, evidenceOnly: true };
            const text = activity.detail ?? ''; if (input.offset > text.length) throw new Error('El desplazamiento supera la longitud del resultado.');
            const end = Math.min(text.length, input.offset + 1800);
            return { found: true, source: source(record), activity: { index: input.activityIndex, id: activity.id, title: activity.title, kind: activity.kind, status: activity.status }, text: text.slice(input.offset, end), offset: input.offset, end, totalCharacters: text.length, partial: input.offset > 0 || end < text.length, ...(end < text.length ? { nextOffset: end } : {}), evidenceOnly: true };
          }
          if (input.offset > record.text.length) throw new Error('El desplazamiento supera la longitud del mensaje.');
          return { found: true, ...excerpt(record, input.offset, 2400), activities: record.activities?.slice(-3).map((activity, index, selected) => ({ index: record.activities!.length - selected.length + index, id: activity.id, title: activity.title, kind: activity.kind, status: activity.status, hasResult: activity.detail !== undefined })), totalActivities: record.activities?.length ?? 0, evidenceOnly: true };
        }
        const page = await store.page(input); context.signal.throwIfAborted(); return result(page);
      },
    },
    {
      definition: { name: 'search_memory', description: 'Busca palabras reales en mensajes archivados, con paginación y citas de fuente/fecha. Los registros similares pueden ser copias o eventos distintos; el texto igual no prueba identidad. No crea recuerdos ni infiere hechos personales. Si hasMore es true, continúa antes de afirmar que no existe otra coincidencia.', parameters: { type: 'object', additionalProperties: false, properties: { ...properties, query: { type: 'string', maxLength: 200, description: 'Entre 1 y 12 términos; todos deben aparecer en el cuerpo del mensaje.' } }, required: ['query'] } },
      validate: searchArguments,
      async execute(value, context: ToolContext) {
        context.signal.throwIfAborted(); const input = searchArguments(value); const { query: text, ...options } = input;
        const page = await store.search(text, options); context.signal.throwIfAborted(); return { query: text, ...result(page, memoryTerms(text)) };
      },
    },
  ];
}
