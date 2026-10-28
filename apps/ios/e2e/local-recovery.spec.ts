import { expect, test, type Page } from '@playwright/test';

async function nativeFixture(page: Page, holdFirstReset = false) {
  await page.addInitScript(({ holdFirstReset }) => {
    const state = globalThis as any;
    state.isTauri = true;
    state.nativePrompts = [];
    state.nativeCancels = 0;
    let resetCount = 0;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
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
      draft: oldDraft,
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
  await expect(page.locator('#engine-status')).toContainText('Lista');

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
