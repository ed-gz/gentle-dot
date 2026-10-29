import { expect, test, openRecoveryHarness } from './fixtures.ts';

test('meeting drafts remain reviewable with source evidence across versions and reload', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const initial = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts'); const sync = await import('/src/work-sync.ts');
    let item = await inbox.createWork({ title: 'Reunión segura', kind: 'meeting', instruction: 'Preparar minuta', files: [new File(['Ana revisa el viernes.'], 'fuente.txt', { type: 'text/plain' })] });
    item = await inbox.transitionWork(item.id, item.revision, 'prepared'); item = await inbox.transitionWork(item.id, item.revision, 'approved');
    const transfer = await sync.prepareWorkTransfer(item, 'wss://host/ws'); item = await inbox.beginWorkTransfer(item.id, item.revision, transfer);
    item = await inbox.settleWorkTransfer(item.id, transfer.transferId, { transferId: transfer.transferId, workId: item.id, revision: transfer.manifest.revision, manifestHash: transfer.manifestHash, committedAt: 123 });
    const result = { schema: 1, manifestHash: transfer.manifestHash, createdAt: 200, model: 'fixture', minutes: { title: 'Borrador inicial', summary: 'Resumen <img src=x>', items: [{ kind: 'task', certainty: 'confirmed', text: 'Revisar bitácora', owner: 'Ana', due: 'viernes', evidenceIds: ['e1'] }] }, evidence: [{ id: 'e1', fileId: item.files[0].id, text: 'Ana revisa el viernes.', source: 'imported-text', startMs: 1000, endMs: 2000 }], transcriptComparison: 'Sólo texto importado.', requiresReview: true };
    item = await inbox.saveWorkResult(item.id, transfer.transferId, result);
    return { id: item.id, transferId: transfer.transferId, result, hasHistory: 'resultHistory' in item };
  });
  expect(initial.hasHistory).toBe(false); // Existing stored work requires no migration.
  await page.reload(); await openRecoveryHarness(page);
  const article = page.locator('.work-item').filter({ hasText: 'Reunión segura' });
  await article.getByText('Minuta · pendiente de revisión', { exact: true }).click();
  await article.getByText(/Borrador 1 ·/).click();
  await expect(article).toContainText('Resumen <img src=x>');
  await expect(article.locator('img')).toHaveCount(0);
  await article.getByText('Ver evidencia', { exact: true }).click();
  await expect(article).toContainText('fuente.txt · 00:01–00:02 (tiempos declarados)');
  await expect(article).toContainText('Ana revisa el viernes.');
  await page.evaluate(async ({ id, transferId, result }) => {
    const inbox = await import('/src/work-inbox.ts');
    await inbox.saveWorkResult(id, transferId, { ...result, createdAt: 300, minutes: { ...result.minutes, title: 'Borrador revisado', summary: 'Segundo resumen' } });
  }, initial);
  await page.reload(); await openRecoveryHarness(page);
  await article.getByText('Minutas (2) · pendientes de revisión', { exact: true }).click();
  await article.getByText(/Borrador 1 ·/).click(); await article.getByText(/Borrador 2 ·/).click();
  await expect(article).toContainText('Borrador inicial'); await expect(article).toContainText('Borrador revisado');
  await expect(article).toContainText('Segundo resumen');
  if (process.env.CAPRI_MEETING_QA) { await article.getByText('Segundo resumen').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${process.env.CAPRI_MEETING_QA}/portrait.png` }); }
  await page.setViewportSize({ width: 812, height: 375 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(article.getByText('Minutas (2) · pendientes de revisión', { exact: true })).toBeVisible();
  if (process.env.CAPRI_MEETING_QA) await page.screenshot({ path: `${process.env.CAPRI_MEETING_QA}/landscape.png`, fullPage: true });
});

test('repeated retrieval is idempotent and a full draft history never discards earlier minutes', async ({ page }) => {
  await page.goto('/');
  const outcome = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts'); const sync = await import('/src/work-sync.ts');
    let item = await inbox.createWork({ title: 'Reunión', kind: 'meeting', instruction: 'Minuta', files: [new File(['texto'], 'fuente.txt', { type: 'text/plain' })] });
    item = await inbox.transitionWork(item.id, item.revision, 'prepared'); item = await inbox.transitionWork(item.id, item.revision, 'approved');
    const transfer = await sync.prepareWorkTransfer(item, 'wss://host/ws'); item = await inbox.beginWorkTransfer(item.id, item.revision, transfer);
    item = await inbox.settleWorkTransfer(item.id, transfer.transferId, { transferId: transfer.transferId, workId: item.id, revision: transfer.manifest.revision, manifestHash: transfer.manifestHash, committedAt: 1 });
    const result = { schema: 1, manifestHash: transfer.manifestHash, createdAt: 1, model: 'fixture', minutes: { title: 'Borrador', summary: 'Original', items: [] }, evidence: [], transcriptComparison: '', requiresReview: true };
    item = await inbox.saveWorkResult(item.id, transfer.transferId, result); const firstRevision = item.revision;
    item = await inbox.saveWorkResult(item.id, transfer.transferId, result); const duplicateRevision = item.revision;
    for (let i = 1; i <= inbox.WORK_LIMITS.resultHistory; i++) item = await inbox.saveWorkResult(item.id, transfer.transferId, { ...result, createdAt: i + 1, minutes: { ...result.minutes, summary: `Versión ${i}` } });
    const before = item.revision;
    let rejected = false;
    try { await inbox.saveWorkResult(item.id, transfer.transferId, { ...result, createdAt: 100, minutes: { ...result.minutes, summary: 'No debe reemplazar' } }); } catch { rejected = true; }
    const saved = await inbox.readWork(item.id);
    return { firstRevision, duplicateRevision, before, after: saved.revision, history: saved.resultHistory?.length, first: saved.resultHistory?.[0].minutes.summary, last: saved.result?.minutes.summary, rejected };
  });
  expect(outcome).toMatchObject({ rejected: true, history: 20, first: 'Original', last: 'Versión 20' });
  expect(outcome.duplicateRevision).toBe(outcome.firstRevision);
  expect(outcome.after).toBe(outcome.before);
});
