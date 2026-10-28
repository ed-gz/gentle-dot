import { expect, test } from '@playwright/test';

test('local work and attached bytes survive reload; using instructions does not send', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-panel="inbox"]').click();
  await page.getByText('Crear un trabajo manualmente', { exact: true }).click();
  const title = '<img src=x onerror=alert(1)> reunión';
  const instruction = 'Preparar acuerdos <script>alert(1)</script>';
  await page.locator('#work-title').fill(title);
  await page.locator('#work-instruction').fill(instruction);
  await page.locator('#work-kind').selectOption('meeting');
  await page.locator('#work-files').setInputFiles({ name: 'meeting.txt', mimeType: 'text/plain', buffer: Buffer.from('Acuerdo: revisar el viernes.\n') });
  await page.locator('#work-form').getByRole('button', { name: 'Guardar en este iPhone' }).click();
  const article = page.locator('#work-list .work-item');
  await expect(article).toHaveCount(1);
  await expect(article.getByRole('heading')).toHaveText(title);
  await expect(article.locator('img, script')).toHaveCount(0);
  await expect(article).toContainText('Solo en este iPhone');

  const stored = await page.evaluate(async () => {
    const path = '/src/work-inbox.ts';
    const inbox = await import(path);
    const [work] = await inbox.listWork();
    const blob = await inbox.readWorkFile(work.id, work.files[0].id);
    return { workId: work.id, fileId: work.files[0].id, content: await blob.text(), type: blob.type, status: work.status, revision: work.revision };
  });
  expect(stored).toMatchObject({ content: 'Acuerdo: revisar el viernes.\n', type: 'text/plain', status: 'local', revision: 1 });
  await page.reload();
  await page.locator('[data-panel="inbox"]').click();
  await expect(article.getByRole('heading')).toHaveText(title);
  await article.locator('summary').filter({ hasText: 'Archivos (1)' }).click();
  const downloading = page.waitForEvent('download');
  await article.getByRole('button', { name: 'Descargar meeting.txt' }).click();
  expect((await downloading).suggestedFilename()).toBe('meeting.txt');

  await article.getByRole('button', { name: 'Usar instrucciones', exact: true }).click();
  await expect(page.locator('#panel-chat')).toBeVisible();
  await expect(page.locator('#prompt')).toHaveValue(instruction);
  expect(await page.evaluate(async () => {
    const path = '/src/work-inbox.ts';
    const inbox = await import(path);
    const [work] = await inbox.listWork();
    return { status: work.status, revision: work.revision };
  })).toEqual({ status: 'local', revision: 1 });

  await page.locator('[data-panel="inbox"]').click();
  await article.getByRole('button', { name: 'Eliminar', exact: true }).click();
  await expect(article).toHaveCount(1);
  await expect(article.getByText(`Eliminar “${title}” de este iPhone`, { exact: false })).toBeVisible();
  await article.getByRole('button', { name: 'Conservar trabajo' }).click();
  await expect(article).toHaveCount(1);
  await article.getByRole('button', { name: 'Eliminar', exact: true }).click();
  await article.getByRole('button', { name: `Confirmar eliminación de ${title}`, exact: true }).click();
  await expect(article).toHaveCount(0);
  expect(await page.evaluate(async ({ workId, fileId }) => {
    const path = '/src/work-inbox.ts';
    const inbox = await import(path);
    return { count: (await inbox.listWork()).length, missing: (await inbox.readWorkFile(workId, fileId)) === undefined };
  }, stored)).toEqual({ count: 0, missing: true });
});

test('instruction edits and text versions update locally through the UI', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-panel="chat"]').click();
  await page.locator('#prompt').fill('Preparar minuta de operaciones');
  await page.locator('[data-panel="inbox"]').click();
  await page.locator('#save-draft').click();
  await expect(page.locator('#save-draft')).toHaveText('Guardado en Trabajos');
  await expect(page.locator('#prompt')).toHaveValue('Preparar minuta de operaciones');
  await page.locator('[data-panel="inbox"]').click();
  const article = page.locator('#work-list .work-item');
  await expect(article).toHaveCount(1);
  await article.locator('summary').filter({ hasText: 'Editar instrucciones' }).click();
  await article.getByLabel('Instrucciones de este trabajo').fill('Separar acuerdos, responsables y pendientes');
  await article.getByRole('button', { name: 'Guardar instrucciones', exact: true }).click();
  await expect(article.locator('p').filter({ hasText: /^Separar acuerdos, responsables y pendientes$/ })).toBeVisible();
  await article.locator('summary').filter({ hasText: 'Guardar una versión de texto' }).click();
  await article.getByLabel('Borrador, transcripción o resultado').fill('Versión 1: Ana revisa inventario el viernes.');
  await article.getByRole('button', { name: 'Guardar versión', exact: true }).click();
  await expect(article.locator('summary').filter({ hasText: 'Versiones guardadas (1)' })).toBeVisible();
  expect(await page.evaluate(async () => {
    const path = '/src/work-inbox.ts';
    const inbox = await import(path);
    const [work] = await inbox.listWork();
    return { instruction: work.instruction, revision: work.revision, status: work.status, versions: work.versions.map((version: { text: string }) => version.text) };
  })).toEqual({ instruction: 'Separar acuerdos, responsables y pendientes', revision: 3, status: 'local', versions: ['Versión 1: Ana revisa inventario el viernes.'] });
});

test('IndexedDB serializes CAS edits, invalidates approval and preserves unresolved sending on reload', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/work-inbox.ts';
    const inbox = await import(path);
    let work = await inbox.createWork({ title: 'CAS', kind: 'task', instruction: 'Original' });
    work = await inbox.transitionWork(work.id, work.revision, 'prepared');
    work = await inbox.transitionWork(work.id, work.revision, 'approved');
    const edits = await Promise.allSettled([
      inbox.reviseWork(work.id, work.revision, 'Edit A'),
      inbox.reviseWork(work.id, work.revision, 'Edit B'),
    ]);
    const [changed] = await inbox.listWork();
    work = await inbox.transitionWork(changed.id, changed.revision, 'prepared');
    work = await inbox.transitionWork(work.id, work.revision, 'approved');
    const versioned = await inbox.addWorkVersion(work.id, work.revision, 'A reviewed draft');
    work = await inbox.transitionWork(versioned.id, versioned.revision, 'prepared');
    work = await inbox.transitionWork(work.id, work.revision, 'approved');
    work = await inbox.transitionWork(work.id, work.revision, 'sending');
    const removal = await Promise.allSettled([inbox.deleteWork(work.id, work.revision)]);
    return {
      edits: edits.map(edit => edit.status).sort(), editedStatus: changed.status, editedRevision: changed.revision,
      versionedStatus: versioned.status, removedWhileSending: removal[0].status, id: work.id, revision: work.revision,
    };
  });
  expect(result).toMatchObject({ edits: ['fulfilled', 'rejected'], editedStatus: 'local', editedRevision: 4, versionedStatus: 'local', removedWhileSending: 'rejected' });
  await page.reload();
  await page.locator('[data-panel="inbox"]').click();
  await expect(page.locator('#work-list')).toContainText('Envío pendiente de confirmar');
  await expect(page.locator('#work-list').getByRole('button', { name: 'Eliminar', exact: true })).toHaveCount(0);
  const afterReload = await page.evaluate(async () => {
    const path = '/src/work-inbox.ts';
    const inbox = await import(path);
    const [work] = await inbox.listWork();
    return { id: work.id, revision: work.revision, status: work.status };
  });
  expect(afterReload).toEqual({ id: result.id, revision: result.revision, status: 'sending' });
});

test('the item limit is atomic when concurrent creations compete for the last slot', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/work-inbox.ts';
    const inbox = await import(path);
    for (let i = 0; i < 99; i++) await inbox.createWork({ title: `Draft ${i}`, kind: 'task', instruction: 'Local only' });
    const final = await Promise.allSettled([
      inbox.createWork({ title: 'Last A', kind: 'task', instruction: 'Local only' }),
      inbox.createWork({ title: 'Last B', kind: 'task', instruction: 'Local only' }),
    ]);
    return { results: final.map(value => value.status).sort(), count: (await inbox.listWork()).length };
  });
  expect(result).toEqual({ results: ['fulfilled', 'rejected'], count: 100 });
});
