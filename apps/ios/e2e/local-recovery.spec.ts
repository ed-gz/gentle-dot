import { expect, test, type Page } from './fixtures.ts';

async function nativeFixture(page: Page, holdFirstReset = false) {
  await page.addInitScript(({ holdFirstReset }) => {
    const state = globalThis as any;
    state.isTauri = true;
    state.nativePrompts = [];
    state.nativeCancels = 0;
    let resetCount = 0;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('results_list')) return { ok: true, items: [] };
      if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('reset') && ++resetCount === 1 && holdFirstReset) {
        return await new Promise(resolve => { state.releaseReset = () => resolve({ ok: true }); });
      }
      if (command.endsWith('cancel')) state.nativeCancels++;
      if (command.endsWith('agent_step')) {
        state.nativePrompts.push(args.prompt);
        return { ok: true, decision: { kind: 'answer', text: 'Respuesta del bridge simulado.', toolName: '', argumentsJSON: '{}' } };
      }
      return { ok: true };
    } };
  }, { holdFirstReset });
}

test('cancel during a pending native reset prevents the later inference', async ({ page }) => {
  await nativeFixture(page, true);
  await page.goto('/');
  await page.locator('[data-panel="chat"]').click();
  await page.locator('#prompt').fill('Cancela esta solicitud antes de inferir.');
  await page.locator('#send').click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).releaseReset)).toBe('function');
  await page.locator('#stop').click();
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText('Respuesta interrumpida.');
  await expect(page.locator('#send')).toBeEnabled();

  const native = await page.evaluate(async () => {
    const state = globalThis as any;
    state.releaseReset();
    // Let the suspended submit handler and its promise continuations finish.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return { prompts: state.nativePrompts, cancels: state.nativeCancels };
  });
  expect(native).toEqual({ prompts: [], cancels: 1 });
  await expect(page.locator('#cards')).not.toContainText('Respuesta del bridge simulado.');

  await page.locator('#prompt').fill('Esta nueva solicitud sí debe responderse.');
  await page.locator('#send').click();
  await expect(page.locator('.chat-card[data-role="assistant"]').last()).toContainText('Respuesta del bridge simulado.');
  expect(await page.evaluate(() => (globalThis as any).nativePrompts.length)).toBe(1);
});

test('failed conversation restoration preserves stored history and retries with the edited draft', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#send')).toBeEnabled();
  const savedText = 'Este historial ya estaba guardado en el iPhone.';
  const oldDraft = 'Borrador anterior guardado';
  await page.evaluate(async ({ savedText, oldDraft }) => {
    const conversation = await import('/src/conversation.ts' as string);
    await conversation.saveConversation({
      entries: [{ id: 'retained-history', role: 'assistant', text: savedText, engine: 'iphone', state: 'complete', at: 1 }],
      draft: oldDraft, revision: 1000,
    });
  }, { savedText, oldDraft });
  await page.addInitScript(() => {
    const originalOpen = IDBFactory.prototype.open;
    let failed = false;
    IDBFactory.prototype.open = function (name: string, version?: number) {
      if (name === 'capri-ios-conversation' && !failed) {
        failed = true;
        throw new DOMException('Temporary conversation read failure fixture', 'UnknownError');
      }
      return Reflect.apply(originalOpen, this, version === undefined ? [name] : [name, version]);
    };
  });
  await page.reload();
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#retry-conversation')).toBeVisible();
  await expect(page.locator('#send')).toBeDisabled();
  await expect(page.locator('#engine-status')).toContainText('Revisa la recuperación de la conversación');

  const editedDraft = 'Conservar también lo que escribí durante la recuperación.';
  await page.clock.install();
  await page.locator('#prompt').fill(editedDraft);
  await page.clock.fastForward(1000); // Run the normal 250 ms draft autosave attempt.
  const beforeRetry = await page.evaluate(async () => (await import('/src/conversation.ts' as string)).loadConversation());
  expect(beforeRetry.entries).toEqual([
    { id: 'retained-history', role: 'assistant', text: savedText, engine: 'iphone', state: 'complete', at: 1 },
  ]);
  expect(beforeRetry.draft).toBe(oldDraft);
  await expect(page.locator('#send')).toBeDisabled();

  await page.locator('#retry-conversation').click();
  await expect(page.locator('#cards')).toContainText(savedText);
  await expect(page.locator('#prompt')).toHaveValue(editedDraft);
  await expect(page.locator('#retry-conversation')).toBeHidden();
  await expect(page.locator('#send')).toBeEnabled();
  await expect.poll(async () => page.evaluate(async () => {
    const stored = await (await import('/src/conversation.ts' as string)).loadConversation();
    return { texts: stored.entries.map((entry: { text: string }) => entry.text), draft: stored.draft };
  })).toEqual({ texts: [savedText], draft: editedDraft });
  expect(await page.evaluate(() => (globalThis as any).nativePrompts)).toEqual([]);
});

test('conversation recovery control remains keyboard focusable and activates with Enter', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const originalOpen = IDBFactory.prototype.open; let failed = false;
    IDBFactory.prototype.open = function (name: string, version?: number) {
      if (name === 'capri-ios-conversation' && !failed) { failed = true; throw new DOMException('Fixture', 'UnknownError'); }
      return Reflect.apply(originalOpen, this, version === undefined ? [name] : [name, version]);
    };
  });
  await page.goto('/');
  const retry = page.getByRole('button', { name: 'Reintentar recuperación' });
  await expect(retry).toBeVisible();
  await retry.focus(); await expect(retry).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(retry).toBeHidden();
  await expect(page.locator('#send')).toBeEnabled();
});

test('draft edited before a failed restoration survives closing and reopening', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const originalOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (name: string, version?: number) {
      if (name === 'capri-ios-conversation' && !sessionStorage.getItem('failed-conversation-once')) {
        sessionStorage.setItem('failed-conversation-once', 'yes');
        throw new DOMException('Temporary read failure', 'UnknownError');
      }
      return Reflect.apply(originalOpen, this, version === undefined ? [name] : [name, version]);
    };
  });
  await page.goto('/');
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#retry-conversation')).toBeVisible();
  await page.locator('#prompt').fill('Texto escrito antes de recuperar');
  await expect.poll(async () => page.evaluate(async () => (await (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue().list()).some(record => record.draft === 'Texto escrito antes de recuperar'))).toBe(true);
  await page.reload();
  await page.locator('[data-panel="chat"]').click();
  const card = page.locator('details').filter({ hasText: 'Borrador para recuperar' });
  await expect(card).toBeVisible();
  await card.locator('summary').click();
  await expect(card).toContainText('Texto escrito antes de recuperar');
  await card.getByRole('button', { name: 'Añadir al mensaje' }).click();
  await expect(page.locator('#prompt')).toHaveValue('Texto escrito antes de recuperar');
});

test('failure to back up an early draft stays visible and a later edit can retry', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const originalOpen = IDBFactory.prototype.open; let failedRestore = false;
    IDBFactory.prototype.open = function (name: string, version?: number) {
      if (name === 'capri-ios-conversation' && (!failedRestore || (globalThis as any).rejectEarlyBackup)) {
        failedRestore = true; throw new DOMException('Storage unavailable', 'UnknownError');
      }
      return Reflect.apply(originalOpen, this, version === undefined ? [name] : [name, version]);
    };
  });
  await page.goto('/'); await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#retry-conversation')).toBeVisible();
  await page.evaluate(() => { (globalThis as any).rejectEarlyBackup = true; });
  await page.locator('#prompt').fill('Primera edición');
  await expect(page.getByRole('status').filter({ hasText: 'No pude guardar este borrador' })).toBeVisible();
  await page.evaluate(() => { (globalThis as any).rejectEarlyBackup = false; });
  await page.locator('#prompt').fill('Edición reintentada');
  await expect.poll(async () => page.evaluate(async () => (await (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue().list()).some(record => record.draft === 'Edición reintentada'))).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: 'No pude guardar este borrador' })).toBeHidden();
});
