import { expect, test } from './fixtures.ts';

test('a draft after archive quota survives reload and never overwrites a pending reservation', async ({ page }) => {
  await page.goto('/');
  const name = `draft-rescue-${crypto.randomUUID()}`, owner = crypto.randomUUID();
  const initial = await page.evaluate(async ({ name, owner }) => {
    const { createConversationDraftRescue } = await import('/src/conversation-draft-rescue.ts');
    const store = createConversationDraftRescue({ databaseName: name });
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onupgradeneeded = () => open.result.createObjectStore('conversation'); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readwrite');
        tx.objectStore('conversation').put({ id: 'pending-reservation', snapshot: 'earlier' }, 'conversation-journal:v1');
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); };
    });
    const base = { schema: 'capri-draft-rescue/v1', owner, sequence: 1, baseRevision: 12, draft: 'Primera versión', attachedWork: 'work_a' };
    const first = await store.save(base), duplicate = await store.save(base);
    const next = { ...base, sequence: 2, draft: 'Escrito después de la cuota', attachedWork: 'work_b' };
    const later = await store.save(next), stale = await store.save(base);
    const conflict = await Promise.allSettled([store.save({ ...next, draft: 'Misma revisión, texto distinto' })]);
    const pending = await new Promise<any>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readonly'), get = tx.objectStore('conversation').get('conversation-journal:v1');
        get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onabort = () => reject(tx.error); };
    });
    return { first, duplicate, later, stale, conflict: conflict[0].status, pending };
  }, { name, owner });
  expect(initial).toEqual({ first: 'saved', duplicate: 'unchanged', later: 'saved', stale: 'superseded', conflict: 'rejected', pending: { id: 'pending-reservation', snapshot: 'earlier' } });
  await page.reload();
  const records = await page.evaluate(async name => (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue({ databaseName: name }).list(), name);
  expect(records).toEqual([{ schema: 'capri-draft-rescue/v1', owner, sequence: 2, baseRevision: 12, draft: 'Escrito después de la cuota', attachedWork: 'work_b' }]);
});

test('retiring a rescue requires its exact revision, current draft and attachment', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const name = `draft-retire-${crypto.randomUUID()}`, owner = crypto.randomUUID();
    const store = (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue({ databaseName: name });
    const first = { schema: 'capri-draft-rescue/v1', owner, sequence: 1, baseRevision: 4, draft: 'texto protegido', attachedWork: 'work_a' } as const;
    const putCurrent = (value: unknown) => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readwrite'); tx.objectStore('conversation').put(value, 'current'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); };
    });
    await store.save(first);
    await putCurrent({ entries: [], revision: 4, draft: first.draft, attachedWork: first.attachedWork });
    const sameBase = await store.retireIfCurrent(first);
    await putCurrent({ entries: [], revision: 5, draft: first.draft, attachedWork: 'work_b' });
    const wrongFile = await store.retireIfCurrent(first);
    const next = { ...first, sequence: 2, draft: 'texto posterior' };
    await store.save(next);
    await putCurrent({ entries: [], revision: 5, draft: first.draft, attachedWork: first.attachedWork });
    const stale = await store.retireIfCurrent(first);
    const protectedList = await store.list();
    await putCurrent({ entries: [], revision: 6, draft: next.draft, attachedWork: next.attachedWork });
    const removed = await store.retireIfCurrent(next);
    return { sameBase, wrongFile, stale, protectedList, removed, after: await store.list() };
  });
  expect(result).toMatchObject({ sameBase: false, wrongFile: false, stale: false, removed: true, after: [] });
  expect(result.protectedList).toHaveLength(1);
  expect(result.protectedList[0]).toMatchObject({ sequence: 2, draft: 'texto posterior' });
});

test('different windows retain independent drafts and racing cleanup cannot delete a newer edit', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const name = `draft-race-${crypto.randomUUID()}`, owner = crypto.randomUUID(), otherOwner = crypto.randomUUID();
    const store = (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue({ databaseName: name });
    const base = { schema: 'capri-draft-rescue/v1', owner, sequence: 1, baseRevision: 0, draft: 'primera' } as const;
    await store.save(base); await store.save({ ...base, owner: otherOwner, draft: 'otra ventana' });
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readwrite'); tx.objectStore('conversation').put({ entries: [], revision: 1, draft: 'primera' }, 'current'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); };
    });
    await Promise.all([store.retireIfCurrent(base), store.save({ ...base, sequence: 2, draft: 'edición nueva' })]);
    return { owner, otherOwner, records: await store.list() };
  });
  expect(result.records).toHaveLength(2);
  expect(result.records.find(record => record.owner === result.owner)).toMatchObject({ sequence: 2, draft: 'edición nueva' });
  expect(result.records.find(record => record.owner === result.otherOwner)).toMatchObject({ draft: 'otra ventana' });
});

test('a matching draft inside a corrupt conversation never retires the rescue across reload', async ({ page }) => {
  await page.goto('/');
  const name = `draft-corrupt-${crypto.randomUUID()}`, owner = crypto.randomUUID();
  const result = await page.evaluate(async ({ name, owner }) => {
    const store = (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue({ databaseName: name });
    const backup = { schema: 'capri-draft-rescue/v1', owner, sequence: 1, baseRevision: 1, draft: 'texto recuperable' };
    await store.save(backup);
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 1); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('conversation', 'readwrite');
        tx.objectStore('conversation').put({ revision: 2, draft: backup.draft, entries: [{ id: 'broken' }] }, 'current');
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); };
    });
    return { removed: await store.retireIfCurrent(backup), records: await store.list() };
  }, { name, owner });
  expect(result.removed).toBe(false);
  expect(result.records).toHaveLength(1);
  await page.reload();
  const records = await page.evaluate(async name => (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue({ databaseName: name }).list(), name);
  expect(records[0]).toMatchObject({ owner, draft: 'texto recuperable' });
});

test('a saved draft is displayed safely and only appended on an explicit action', async ({ page }) => {
  await page.goto('/');
  const name = `draft-view-${crypto.randomUUID()}`, owner = crypto.randomUUID();
  await page.evaluate(async ({ name, owner }) => {
    const { createConversationDraftRescue } = await import('/src/conversation-draft-rescue.ts');
    const { mountConversationDraftRecovery } = await import('/src/conversation-draft-recovery-view.ts');
    const store = createConversationDraftRescue({ databaseName: name });
    await store.save({ schema: 'capri-draft-rescue/v1', owner, sequence: 1, baseRevision: 1, draft: '<b>Texto pendiente</b>', attachedWork: 'work_a' });
    const root = document.createElement('section'); root.id = 'draft-recovery-fixture'; document.body.append(root);
    (globalThis as any).draftRecovery = mountConversationDraftRecovery(root, { store,
      append: (record: any) => { (globalThis as any).fixtureDraft += `\n${record.draft}`; }, confirmDiscard: () => false });
    (globalThis as any).fixtureDraft = 'Texto nuevo';
    await (globalThis as any).draftRecovery.refresh();
  }, { name, owner });
  const root = page.locator('#draft-recovery-fixture');
  await expect(root.getByText('Borrador para recuperar')).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).fixtureDraft)).toBe('Texto nuevo');
  await root.locator('summary').click();
  await expect(root.locator('b')).toHaveCount(0);
  await root.getByRole('button', { name: 'Añadir al mensaje' }).click();
  await expect(root.getByRole('status')).toContainText('Añadido al mensaje');
  expect(await page.evaluate(() => (globalThis as any).fixtureDraft)).toBe('Texto nuevo\n<b>Texto pendiente</b>');
  await expect(root.getByRole('button', { name: 'Añadir al mensaje' })).toBeDisabled();
  await root.getByRole('button', { name: 'Descartar copia' }).click();
  await expect(root.getByText('Borrador para recuperar')).toBeVisible();
});

test('a changed backup cannot be appended or discarded from a stale recovery card', async ({ page }) => {
  await page.goto('/');
  const name = `draft-view-race-${crypto.randomUUID()}`, owner = crypto.randomUUID();
  await page.evaluate(async ({ name, owner }) => {
    const { createConversationDraftRescue } = await import('/src/conversation-draft-rescue.ts');
    const { mountConversationDraftRecovery } = await import('/src/conversation-draft-recovery-view.ts');
    const store = createConversationDraftRescue({ databaseName: name });
    await store.save({ schema: 'capri-draft-rescue/v1', owner, sequence: 1, baseRevision: 1, draft: 'Viejo' });
    const root = document.createElement('section'); root.id = 'draft-recovery-fixture'; document.body.append(root);
    (globalThis as any).draftRecovery = mountConversationDraftRecovery(root, { store,
      append: () => { (globalThis as any).applied = true; }, confirmDiscard: () => true });
    await (globalThis as any).draftRecovery.refresh();
    await store.save({ schema: 'capri-draft-rescue/v1', owner, sequence: 2, baseRevision: 1, draft: 'Nuevo' });
  }, { name, owner });
  const root = page.locator('#draft-recovery-fixture');
  await root.locator('summary').click();
  await root.getByRole('button', { name: 'Añadir al mensaje' }).click();
  await expect(root.getByRole('status')).toContainText('cambió');
  expect(await page.evaluate(() => (globalThis as any).applied)).toBeUndefined();
  await root.getByRole('button', { name: 'Descartar copia' }).click();
  await expect(root.getByRole('status')).toContainText('cambió');
  const records = await page.evaluate(async name => (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue({ databaseName: name }).list(), name);
  expect(records[0]).toMatchObject({ sequence: 2, draft: 'Nuevo' });
});
