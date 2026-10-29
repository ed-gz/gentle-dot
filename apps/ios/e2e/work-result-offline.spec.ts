import { test, expect } from '@playwright/test';

test('an agent can read saved meeting evidence after restart with the laptop disconnected', async ({ page }) => {
  await page.goto('/');
  const id = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts');
    const sync = await import('/src/work-sync.ts');
    let work = await inbox.createWork({ title: 'Reunión guardada', kind: 'meeting', instruction: 'Conservar minuta', files: [new File(['Ana revisa el viernes'], 'fuente.txt', { type: 'text/plain' })] });
    work = await inbox.transitionWork(work.id, work.revision, 'prepared');
    work = await inbox.transitionWork(work.id, work.revision, 'approved');
    const transfer = await sync.prepareWorkTransfer(work, 'wss://host.example/ws');
    work = await inbox.beginWorkTransfer(work.id, work.revision, transfer);
    work = await inbox.settleWorkTransfer(work.id, transfer.transferId, { transferId: transfer.transferId, workId: work.id, revision: transfer.manifest.revision, manifestHash: transfer.manifestHash, committedAt: 10 });
    const evidence = { id: 'ev-1', fileId: work.files[0]!.id, source: 'imported-text' as const, text: 'Ana revisa el viernes', startMs: 1000, endMs: 2000 };
    await inbox.saveWorkResult(work.id, transfer.transferId, { schema: 1, manifestHash: transfer.manifestHash, createdAt: 11, model: 'fixture', minutes: { title: 'Minuta', summary: 'Pendiente de revisión', items: [] }, evidence: [evidence], transcriptComparison: 'Texto importado', requiresReview: true });
    return work.id;
  });
  await page.reload();
  const output = await page.evaluate(async id => {
    const { createWorkTools } = await import('/src/work-tools.ts');
    let networkCalls = 0;
    const tool = createWorkTools({ getHost: () => undefined, getDispatcher: () => { networkCalls++; return undefined; } }).find(tool => tool.definition.name === 'work_result')!;
    const call = async (args: object) => tool.execute(args, { signal: new AbortController().signal }) as Promise<any>;
    const result = await call({ id, section: 'evidence', maxChars: 40 });
    const parts = [result.cachedDraft.content.text]; let next = result.cachedDraft.content.nextOffset;
    while (next !== undefined) {
      const page = await call({ id, mode: 'local', section: 'evidence', offset: next, maxChars: 40 });
      parts.push(page.cachedDraft.content.text); next = page.cachedDraft.content.nextOffset;
    }
    return { draft: result.cachedDraft, evidence: JSON.parse(parts.join('')), networkCalls };
  }, id);
  expect(output.networkCalls).toBe(0);
  expect(output.draft).toMatchObject({ source: 'iphone', savedLocally: true, hostStatus: 'not_verified', requiresReview: true, minuteApprovedLocally: false, untrustedContent: true, provenance: { receipt: { workId: id } } });
  expect(output.evidence).toMatchObject([{ id: 'ev-1', text: 'Ana revisa el viernes', startMs: 1000, endMs: 2000 }]);
});
