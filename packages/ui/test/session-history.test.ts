import { describe, expect, it } from 'vitest';
import { reconcileRecentConversation } from '../src/session-history.ts';
import type { AgentConversation } from '../src/orchestration.ts';

function page(ids: string[], before = 'older'): AgentConversation {
  return { sessionId: 'session-1', status: 'idle', question: null,
    history: { supported: true, hasEarlier: true, before },
    messages: ids.map(id => ({ id, role: 'assistant', content: [{ type: 'text', text: id }] })) };
}
const ids = (result: AgentConversation) => result.messages.map(message => message.id);

describe('session history refresh', () => {
  it('retains a paged prefix while refreshing the overlapping latest page', () => {
    const result = reconcileRecentConversation(page(['old', 'a', 'b'], 'old-cursor'), page(['a', 'b', 'c'], 'recent-cursor'));
    expect(ids(result)).toEqual(['old', 'a', 'b', 'c']);
    expect(result.history?.before).toBe('old-cursor');
  });
  it('does not keep discarded messages after the host changes branch', () => {
    const result = reconcileRecentConversation(page(['old', 'a', 'discarded']), page(['a', 'new']));
    expect(ids(result)).toEqual(['old', 'a', 'new']);
    expect(result.history?.before).toBe('older');
  });
  it('replaces a disconnected window, allowing earlier pages to be loaded from the host', () => {
    const next = page(['new-1', 'new-2'], 'new-cursor');
    expect(reconcileRecentConversation(page(['old-1', 'old-2']), next)).toEqual(next);
  });
  it('does not join reordered, empty or different-session snapshots', () => {
    const current = page(['a', 'b', 'c']);
    for (const next of [page(['b', 'a']), page([]), { ...page(['b']), sessionId: 'other' }]) {
      expect(reconcileRecentConversation(current, next)).toEqual(next);
    }
  });
});
