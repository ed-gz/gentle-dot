import { expect, test } from './fixtures.ts';

test('a draft backup after restart requires an explicit append and preserves the new draft', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#history-loading')).toBeHidden();
  await page.locator('#prompt').fill('Texto actual');
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/conversation.ts')).loadConversation()).draft)).toBe('Texto actual');
  await page.evaluate(async () => {
    const base = await (await import('/src/conversation.ts')).loadConversationBase();
    await (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue().save({ schema: 'capri-draft-rescue/v1', owner: crypto.randomUUID(), sequence: 1, baseRevision: base?.revision ?? 0, draft: 'Dictado pendiente' });
  });
  await page.reload();
  const recovery = page.getByText('Borrador para recuperar');
  await expect(recovery).toBeVisible();
  await expect(page.locator('#prompt')).toHaveValue('Texto actual');
  await recovery.click();
  await page.getByRole('button', { name: 'Añadir al mensaje' }).click();
  await expect(page.locator('#prompt')).toHaveValue('Texto actual\nDictado pendiente');
  await expect(page.locator('.chat-card[data-role="user"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/conversation.ts')).loadConversation()).draft)).toBe('Texto actual\nDictado pendiente');
});

test('a recovered attachment is reviewable only after its reference is durable', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#history-loading')).toBeHidden();
  const workId = await page.evaluate(async () => {
    const work = await (await import('/src/work-inbox.ts')).createWork({ title: 'Prueba', kind: 'task', instruction: '', files: [new File(['datos'], 'prueba.txt', { type: 'text/plain' })] });
    const base = await (await import('/src/conversation.ts')).loadConversationBase();
    await (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue().save({ schema: 'capri-draft-rescue/v1', owner: crypto.randomUUID(), sequence: 1, baseRevision: base?.revision ?? 0, draft: 'Revisa mi evidencia', attachedWork: work.id });
    return work.id;
  });
  await page.reload(); await expect(page.getByText('Borrador para recuperar')).toBeVisible();
  await page.getByText('Borrador para recuperar').click();
  await page.getByRole('button', { name: 'Añadir al mensaje' }).click();
  await expect.poll(async () => page.evaluate(async () => (await (await import('/src/conversation.ts')).loadConversationBase())?.attachedWork)).toBe(workId);
  await expect(page.locator('#view-material')).toBeEnabled();
});

test('a blocked save keeps the recovered attachment disabled and its backup intact', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#history-loading')).toBeHidden();
  const workId = await page.evaluate(async () => {
    const work = await (await import('/src/work-inbox.ts')).createWork({ title: 'Prueba', kind: 'task', instruction: '', files: [new File(['datos'], 'prueba.txt', { type: 'text/plain' })] });
    const base = await (await import('/src/conversation.ts')).loadConversationBase();
    await (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue().save({ schema: 'capri-draft-rescue/v1', owner: crypto.randomUUID(), sequence: 1, baseRevision: base?.revision ?? 0, draft: 'Evidencia en espera', attachedWork: work.id });
    return work.id;
  });
  await page.reload(); await expect(page.getByText('Borrador para recuperar')).toBeVisible();
  await page.evaluate(async () => { (await import('/src/conversation-archive.ts')).conversationArchive.upsert = async () => { throw new Error('Cuota simulada'); }; });
  await page.getByText('Borrador para recuperar').click();
  await page.getByRole('button', { name: 'Añadir al mensaje' }).click();
  await expect(page.locator('#chat-notice')).toContainText('No se confirmó el guardado');
  await expect(page.locator('#view-material')).toBeDisabled();
  expect(await page.evaluate(async id => (await (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue().list()).some(record => record.attachedWork === id && record.draft === 'Evidencia en espera'), workId)).toBe(true);
  await page.reload();
  await expect.poll(async () => page.evaluate(async () => (await (await import('/src/conversation.ts')).loadConversationBase())?.attachedWork)).toBe(workId);
  await expect(page.locator('#view-material')).toBeEnabled();
});

test('a transient attachment verification failure can be retried without editing the draft', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#history-loading')).toBeHidden();
  await page.evaluate(async () => {
    const work = await (await import('/src/work-inbox.ts')).createWork({ title: 'Prueba', kind: 'task', instruction: '', files: [new File(['datos'], 'prueba.txt', { type: 'text/plain' })] });
    const base = await (await import('/src/conversation.ts')).loadConversationBase();
    await (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue().save({ schema: 'capri-draft-rescue/v1', owner: crypto.randomUUID(), sequence: 1, baseRevision: base?.revision ?? 0, draft: 'Evidencia', attachedWork: work.id });
  });
  await page.reload(); await expect(page.getByText('Borrador para recuperar')).toBeVisible();
  await page.evaluate(() => {
    const originalGet = IDBObjectStore.prototype.get, guarded = new WeakSet<IDBTransaction>();
    (globalThis as any).rejectAttachmentVerification = true;
    IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange) {
      if (this.transaction.db.name === 'capri-ios-conversation' && this.transaction.mode === 'readonly') {
        if (key === 'conversation-journal:v1') guarded.add(this.transaction);
        if (key === 'current' && guarded.has(this.transaction) && (globalThis as any).rejectAttachmentVerification) throw new DOMException('Verification temporarily unavailable', 'UnknownError');
      }
      return Reflect.apply(originalGet, this, [key]);
    };
  });
  await page.getByText('Borrador para recuperar').click();
  await page.getByRole('button', { name: 'Añadir al mensaje' }).click();
  await expect(page.getByRole('button', { name: 'Reintentar material' })).toBeVisible();
  await expect(page.locator('#view-material')).toBeDisabled();
  await page.evaluate(() => { (globalThis as any).rejectAttachmentVerification = false; });
  await page.getByRole('button', { name: 'Reintentar material' }).click();
  await expect(page.locator('#view-material')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Reintentar material' })).toBeHidden();
  await expect(page.locator('#prompt')).toHaveValue('Evidencia');
});
