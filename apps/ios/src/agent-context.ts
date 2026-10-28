import type { ChatEntry } from './conversation.ts';

const count = (text: string) => Array.from(text).length;
function excerpt(text: string, limit: number): string {
  const points = Array.from(text);
  if (points.length <= limit) return text;
  const marker = ' […] ';
  const head = Math.ceil((limit - marker.length) * 0.65);
  return points.slice(0, Math.max(0, head)).join('') + marker + points.slice(-Math.max(1, limit - marker.length - head)).join('');
}

/** Capture source messages once; serialize within the actual prompt budget on every step. */
export function createAgentContext(entries: readonly ChatEntry[], options: { attachedWork?: string } = {}): (budget: number) => string {
  const eligible = entries.filter(entry => entry.text.trim() || entry.activities?.length);
  const snapshot = eligible.slice(-8).map(entry => ({
    id: entry.id, role: entry.role, engine: entry.engine, state: entry.state, at: entry.at,
    text: entry.text, partial: false,
    activities: (entry.activities ?? []).slice(-2).map(activity => ({ id: activity.id, status: activity.status,
      title: activity.title, ...(activity.detail ? { result: activity.detail } : {}), partial: false })),
  }));
  return budget => {
    if (!Number.isFinite(budget) || budget < 2) return '';
    budget = Math.floor(budget);
    const turns = structuredClone(snapshot);
    // Cap individual fields before budgeting; original messages stay in the archive.
    for (const turn of turns) {
      if (count(turn.text) > 2400) { turn.text = excerpt(turn.text, 2400); turn.partial = true; }
      for (const activity of turn.activities) {
        if (count(activity.title) > 120) { activity.title = excerpt(activity.title, 120); activity.partial = true; }
        if (activity.result && count(activity.result) > 1000) { activity.result = excerpt(activity.result, 1000); activity.partial = true; }
      }
    }
    const encode = () => JSON.stringify({
      ...(options.attachedWork ? { attachedWork: options.attachedWork } : {}),
      omittedMessages: eligible.length - turns.length,
      memory: 'Contexto reciente, no memoria completa. Para recuperar mensajes exactos usa recall_history o search_memory. Un estado interrumpido o un recibo incierto no confirma ejecución.',
      turns,
    });
    let encoded = encode();
    while (count(encoded) > budget && turns.length) {
      // Share space between recent messages instead of letting one long answer erase the user's request.
      const fields = turns.flatMap(turn => [
        { text: turn.text, minimum: 120, set(value: string) { turn.text = value; turn.partial = true; } },
        ...turn.activities.filter(activity => activity.result).map(activity => ({ text: activity.result!, minimum: 120,
          set(value: string) { activity.result = value; activity.partial = true; } })),
      ]).filter(field => count(field.text) > field.minimum).sort((a, b) => count(b.text) - count(a.text));
      if (fields.length) {
        const field = fields[0]!;
        field.set(excerpt(field.text, Math.max(field.minimum, count(field.text) - Math.max(64, count(encoded) - budget))));
      } else turns.shift();
      encoded = encode();
    }
    if (count(encoded) <= budget) return encoded;
    const minimal = JSON.stringify({ ...(options.attachedWork ? { attachedWork: options.attachedWork } : {}),
      partial: true, memory: 'Consulta recall_history o search_memory; no supongas recuerdos ausentes.' });
    return count(minimal) <= budget ? minimal : '{}';
  };
}
