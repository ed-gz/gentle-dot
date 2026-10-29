/** A cursor alone cannot identify the conversation or a late request. This state
 * is scoped to the authenticated socket, host, conversation and latest snapshot. */
export type HistoryScope = { epoch: number; host: string; conversationId: string };
export type HistoryRequest = HistoryScope & { before: string; requestId: string };
export function createHistoryPaging() {
  let scope: HistoryScope | undefined, before: string | undefined, more = false, pending: HistoryRequest | undefined;
  const matches = (a: HistoryScope, b: HistoryScope) => a.epoch === b.epoch && a.host === b.host && a.conversationId === b.conversationId;
  return {
    matches(current: HistoryScope, response: { before: string; requestId?: string; conversationId?: string }): boolean {
      return !!scope && !!pending && matches(scope, current) && matches(pending, current)
        && response.requestId === pending.requestId && response.conversationId === pending.conversationId && response.before === pending.before;
    },
    reset(next?: HistoryScope, first?: string, hasEarlier = false) {
      scope = next; before = first; more = hasEarlier && !!first; pending = undefined;
    },
    start(current: HistoryScope, requestId: string): HistoryRequest | undefined {
      if (!scope || !matches(scope, current) || !before || !more || pending || !requestId) return;
      pending = { ...scope, before, requestId }; return pending;
    },
    accept(current: HistoryScope, response: { before: string; requestId?: string; conversationId?: string }, nextBefore: string | undefined, hasEarlier: boolean): boolean {
      if (!scope || !pending || !matches(scope, current) || !matches(pending, current)
          || response.requestId !== pending.requestId || response.conversationId !== pending.conversationId || response.before !== pending.before
          || (hasEarlier && (!nextBefore || nextBefore === pending.before))) return false;
      pending = undefined; before = nextBefore; more = hasEarlier && !!nextBefore; return true;
    },
    fail(current: HistoryScope, requestId: string): boolean {
      if (!pending || !matches(pending, current) || pending.requestId !== requestId) return false;
      pending = undefined; return true;
    },
    available: () => more,
    busy: () => !!pending,
  };
}
