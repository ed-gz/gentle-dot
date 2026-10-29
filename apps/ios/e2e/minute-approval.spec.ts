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
  const beforeApproval = await page.evaluate(async id => {
    const inbox = await import('/src/work-inbox.ts'), proposals = await import('/src/minute-proposals.ts');
    const work = await inbox.readWork(id);
    return (await Promise.allSettled([proposals.createMinuteProposal({ workId: id, revision: work.revision, connectionId: '11111111-1111-4111-8111-111111111111', tool: 'mcp_0123456789abcdef01234567', description: 'Seguir', arguments: {} })]))[0].status;
  }, initial.id);
  expect(beforeApproval).toBe('rejected');
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
  const proposed = await page.evaluate(async id => {
    const inbox = await import('/src/work-inbox.ts'), tools = await import('/src/work-tools.ts');
    const work = await inbox.readWork(id);
    const tool = tools.createWorkTools({ getHost: () => undefined, getDispatcher: () => undefined }).find(t => t.definition.name === 'work_propose_action')!;
    return tool.execute(tool.validate({ workId: id, revision: work.revision, connectionId: '11111111-1111-4111-8111-111111111111', tool: 'mcp_0123456789abcdef01234567', description: 'Preparar seguimiento', arguments: { mensaje: 'Revisar acuerdo' } }), { signal: new AbortController().signal });
  }, initial.id);
  expect(proposed).toMatchObject({ current: true, executed: false, actionApproved: false, description: 'Preparar seguimiento' });
  await page.reload(); await openRecoveryHarness(page);
  await article.getByText('Acciones propuestas (1)').click();
  await expect(article.getByText('Preparar seguimiento')).toBeVisible();
  await expect(article.getByText('acción sin aprobar', { exact: false })).toBeVisible();
  await article.getByText('Ver contenido propuesto').click(); await expect(article.locator('pre').filter({ hasText: 'Revisar acuerdo' })).toBeVisible();
  const checks = await page.evaluate(async ({ id, transferId, result }) => {
    const inbox = await import('/src/work-inbox.ts'); let work = await inbox.readWork(id);
    const approved = inbox.validMinuteApproval(work);
    const corruption = inbox.validMinuteApproval({ ...work, result: { ...work.result, minutes: { ...work.result.minutes, summary: 'contenido cambiado' } } });
    const correction = await inbox.createWorkFromResult(id, work.revision);
    const proposals = await import('/src/minute-proposals.ts');
    const race = await Promise.allSettled([
      proposals.createMinuteProposal({ workId: id, revision: work.revision, connectionId: '11111111-1111-4111-8111-111111111111', tool: 'mcp_0123456789abcdef01234567', description: 'Carrera', arguments: { text: 'test' } }),
      inbox.saveWorkResult(id, transferId, { ...result, createdAt: 201, minutes: { ...result.minutes, summary: 'Nuevo borrador' } }),
    ]);
    work = await inbox.readWork(id);
    const raced = await proposals.listMinuteProposals(id);
    const allStale = raced.every(proposal => !proposal.current && !proposal.executed && !proposal.actionApproved);
    if (race[0].status === 'fulfilled') await proposals.deleteMinuteProposal(race[0].value.id, id);
    return { approved, corruption, invalidated: !inbox.validMinuteApproval(work), allStale, resultSaved: race[1].status, correctionId: correction.id, correctionUnapproved: !inbox.validMinuteApproval(correction) };
  }, initial);
  expect(checks).toMatchObject({ approved: true, corruption: false, invalidated: true, allStale: true, resultSaved: 'fulfilled', correctionUnapproved: true });
  await openRecoveryHarness(page);
  const proposalsAfterChange = await page.evaluate(async id => (await import('/src/minute-proposals.ts')).listMinuteProposals(id), initial.id);
  expect(proposalsAfterChange).toMatchObject([{ current: false, actionApproved: false, executed: false }]);
  const source = page.locator(`[data-work-id="${initial.id}"]`);
  await source.getByText('Acciones propuestas (1)').click();
  await expect(source.getByText('Vigencia sin confirmar', { exact: false })).toBeVisible();
  page.once('dialog', dialog => dialog.dismiss()); await source.getByRole('button', { name: 'Eliminar propuesta' }).click();
  await expect(source.getByText('Preparar seguimiento')).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await source.getByRole('button', { name: 'Eliminar propuesta' }).click();
  await expect(source.getByText('Acciones propuestas (1)')).toHaveCount(0);
  expect(await page.evaluate(async id => (await import('/src/minute-proposals.ts')).listMinuteProposals(id), initial.id)).toEqual([]);
  article = page.locator(`[data-work-id="${checks.correctionId}"]`);
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
  const removed = await page.evaluate(async id => {
    const inbox = await import('/src/work-inbox.ts'), proposals = await import('/src/minute-proposals.ts');
    let work = await inbox.readWork(id); work = await inbox.approveMinute(id, work.revision, 'version', work.versions.at(-1)!.id);
    await proposals.createMinuteProposal({ workId: id, revision: work.revision, connectionId: '11111111-1111-4111-8111-111111111111', tool: 'mcp_0123456789abcdef01234567', description: 'Seguir', arguments: {} });
    work = await inbox.readWork(id); await inbox.deleteWork(id, work.revision);
    const outcome = await Promise.allSettled([inbox.readWork(id), proposals.listMinuteProposals(id)]);
    return outcome.map(value => value.status);
  }, checks.correctionId);
  expect(removed).toEqual(['rejected', 'rejected']);
});
