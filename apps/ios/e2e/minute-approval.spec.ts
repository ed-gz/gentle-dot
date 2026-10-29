import { expect, test, openRecoveryHarness } from './fixtures.ts';

test('human approves exact minute locally; newer drafts and corrections require a fresh review', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  const initial = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts'); const sync = await import('/src/work-sync.ts');
    let work = await inbox.createWork({ title: 'Reunión', kind: 'meeting', instruction: 'Revisar acuerdos', files: [new File(['acuerdo'], 'transcript.txt', { type: 'text/plain' })] });
    work = await inbox.transitionWork(work.id, work.revision, 'prepared'); work = await inbox.transitionWork(work.id, work.revision, 'approved');
    const transfer = await sync.prepareWorkTransfer(work, 'wss://host/ws'); work = await inbox.beginWorkTransfer(work.id, work.revision, transfer);
    work = await inbox.settleWorkTransfer(work.id, transfer.transferId, { transferId: transfer.transferId, workId: work.id, revision: transfer.manifest.revision, manifestHash: transfer.manifestHash, committedAt: 1 });
    const result = { schema: 1, manifestHash: transfer.manifestHash, createdAt: 200, model: 'fixture', minutes: { title: 'Reunión', summary: 'Versión que se revisa', items: [] }, evidence: [], transcriptComparison: '', requiresReview: true };
    work = await inbox.saveWorkResult(work.id, transfer.transferId, result);
    return { id: work.id, transferId: transfer.transferId, result };
  });
  await openRecoveryHarness(page);
  let article = page.locator(`[data-work-id="${initial.id}"]`);
  await article.getByText('Minuta · pendiente de revisión').click();
  await article.getByText('Borrador 1', { exact: false }).click();
  await expect(article.getByText('Versión que se revisa')).toBeVisible();
  const approve = article.getByRole('button', { name: 'Aprobar esta minuta' });
  await approve.focus(); await expect(approve).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.locator('#work-status')).toContainText('Ninguna acción externa fue autorizada');
  await page.reload(); await openRecoveryHarness(page);
  await expect(article.getByText('Minuta · aprobada en este iPhone')).toBeVisible();
  const checks = await page.evaluate(async ({ id, transferId, result }) => {
    const inbox = await import('/src/work-inbox.ts'); let work = await inbox.readWork(id);
    const approved = inbox.validMinuteApproval(work);
    const corruption = inbox.validMinuteApproval({ ...work, result: { ...work.result, minutes: { ...work.result.minutes, summary: 'contenido cambiado' } } });
    const correction = await inbox.createWorkFromResult(id, work.revision);
    work = await inbox.saveWorkResult(id, transferId, { ...result, createdAt: 201, minutes: { ...result.minutes, summary: 'Nuevo borrador' } });
    return { approved, corruption, invalidated: !inbox.validMinuteApproval(work), correctionId: correction.id, correctionUnapproved: !inbox.validMinuteApproval(correction) };
  }, initial);
  expect(checks).toMatchObject({ approved: true, corruption: false, invalidated: true, correctionUnapproved: true });
  await openRecoveryHarness(page); article = page.locator(`[data-work-id="${checks.correctionId}"]`);
  await article.getByText('Versiones guardadas (1)').click(); await article.getByText('Versión 1 ·', { exact: false }).click();
  await article.getByRole('button', { name: 'Aprobar esta versión' }).click();
  await expect(page.locator('#work-status')).toContainText('Ninguna acción externa fue autorizada');
  const edits = await page.evaluate(async id => {
    const inbox = await import('/src/work-inbox.ts'); const work = await inbox.readWork(id);
    const approved = inbox.validMinuteApproval(work);
    const tampered = structuredClone(work); tampered.versions.at(-1).text = 'Otro texto';
    const corruption = inbox.validMinuteApproval(tampered);
    const outcomes = await Promise.allSettled([inbox.addWorkVersion(id, work.revision, 'Nueva corrección'), inbox.approveMinute(id, work.revision, 'version', work.versions.at(-1).id)]);
    const latest = await inbox.readWork(id);
    return { approved, corruption, outcomes: outcomes.map(x => x.status), latestValid: inbox.validMinuteApproval(latest), versions: latest.versions.length };
  }, checks.correctionId);
  expect(edits).toEqual({ approved: true, corruption: false, outcomes: ['fulfilled', 'rejected'], latestValid: false, versions: 2 });
  await page.reload(); await openRecoveryHarness(page);
  article = page.locator(`[data-work-id="${checks.correctionId}"]`);
  await article.getByText('Versiones guardadas (2)').click(); await article.getByText('Versión 2 ·', { exact: false }).click();
  await expect(article.getByRole('button', { name: 'Aprobar esta versión' })).toBeVisible();
});
