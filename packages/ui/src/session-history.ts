import type { AgentConversation } from './orchestration.ts';

/** Preserve only a verified prefix when the host refreshes its latest page.
 * A branch change may retain the same pane/session ID while removing messages.
 * Pages with no shared anchor must be fetched again, never silently joined. */
export function sameSessionInstance(current: AgentConversation | undefined, next: AgentConversation | undefined): boolean {
  return !!current && !!next && current.sessionId === next.sessionId && typeof current.instanceId === 'string' &&
    current.instanceId.length > 0 && current.instanceId.length <= 256 && current.instanceId === next.instanceId;
}

export function reconcileRecentConversation(current: AgentConversation | undefined, next: AgentConversation, requireInstance = false): AgentConversation {
  if (requireInstance && !sameSessionInstance(current, next)) return next;
  if (!current || current.sessionId !== next.sessionId || !next.history?.supported || !next.messages.length) return next;
  const positions = new Map(current.messages.map((message, index) => [message.id, index]));
  const matching = next.messages.flatMap(message => {
    const index = positions.get(message.id);
    return index === undefined ? [] : [index];
  });
  if (!matching.length || matching.some((index, i) => i > 0 && index <= matching[i - 1]!)) return next;
  const prefix = current.messages.slice(0, matching[0]!);
  return {
    ...next,
    messages: [...prefix, ...next.messages],
    history: prefix.length && current.history?.supported ? current.history : next.history,
  };
}
