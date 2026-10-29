import { expect, test } from './fixtures.ts';

test('a page that exceeds 64 MiB leaves its reservation intact and recoverable', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createConversationJournal } = await import('/src/conversation-journal.ts');
    const stored = new Map<string, string>();
    const archive = {
      async upsert(entries: readonly { id: string; text: string }[]) { for (const entry of entries) stored.set(entry.id, entry.text); return {} as never; },
      async verifyExactBatch(entries: readonly { id: string; text: string }[]) { return entries.every(entry => stored.get(entry.id) === entry.text); },
    };
    const journal = createConversationJournal({ databaseName: `capri-limit-${crypto.randomUUID()}`, archive });
    const id = crypto.randomUUID(), prefix = 'host:wss://quota.example/ws|chat|';
    const snapshot = { entries: [], draft: 'conservar', revision: 1 }, expected = { id, baseRevision: 0, snapshot, revision: 1 };
    const make = (label: string, count: number) => Array.from({ length: count }, (_, i) => ({
      id: `${prefix}${label}${i}`, engine: 'gentle' as const, role: 'assistant' as const, state: 'complete' as const, text: 'a'.repeat(32_000), at: i + 1,
    }));
    const initial = make('saved-', 2_000), pageEntries = make('page-', 100);
    const bytes = (pending: typeof initial) => new TextEncoder().encode(JSON.stringify({ schema: 'capri-conversation-journal/v1', id, baseRevision: 0, revision: 1, snapshot, pending })).byteLength;
    const initialBytes = bytes(initial), attemptedBytes = bytes([...initial, ...pageEntries]);
    const digest = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map(b => b.toString(16).padStart(2, '0')).join('');
    await journal.begin({ id, baseRevision: 0, snapshot, pending: initial });
    const before = await journal.pending(), beforeHash = await digest(before); let error = '';
    try { await journal.appendOwnedPage(expected, pageEntries, prefix, () => true); } catch (problem) { error = problem instanceof Error ? problem.message : 'unknown'; }
    const after = await journal.pending(), unchanged = !!after && await digest(after) === beforeHash;
    const omitted = !!after && after.pending.length === initial.length && !after.pending.some(entry => entry.id.startsWith(`${prefix}page-`));
    const commit = await journal.resume(id), noPage = [...stored.keys()].every(key => !key.startsWith(`${prefix}page-`));
    return { initialBytes, attemptedBytes, error, unchanged, omitted, revision: commit.revision, replayed: stored.size, noPage, pending: await journal.pending() };
  });
  expect(result.initialBytes).toBeLessThan(64 * 1024 * 1024);
  expect(result.attemptedBytes).toBeGreaterThan(64 * 1024 * 1024);
  expect(result.error).toMatch(/reserva supera el límite/i);
  expect(result.unchanged).toBe(true);
  expect(result.omitted).toBe(true);
  expect(result.revision).toBe(1);
  expect(result.replayed).toBe(2_000);
  expect(result.noPage).toBe(true);
  expect(result.pending).toBeUndefined();
});
