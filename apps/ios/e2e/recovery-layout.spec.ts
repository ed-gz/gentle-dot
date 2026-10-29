import { expect, test } from './fixtures.ts';

test('normal chat has no recovery controls and retains a compact composer', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/'); await expect(page.locator('#history-loading')).toBeHidden();
  for (const name of ['Reintentar recuperación', 'Rescatar datos guardados', 'Exportar reserva pendiente', 'Borrador para recuperar', 'Reintentar material', 'Reintentar adjunto'])
    await expect(page.getByText(name, { exact: true })).toBeHidden();
  await expect(page.locator('#storage-warning')).toBeHidden();
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  for (const selector of ['#camera', '#dictate', '#prompt', '#send']) await expect(page.locator(selector)).toBeVisible();
  await expect(page.locator('#prompt')).toHaveAccessibleName('Mensaje para Capri');
});

test('startup recovery warning disappears after a successful retry', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript(() => {
    const original = IDBFactory.prototype.open;
    let failed = false;
    IDBFactory.prototype.open = function (name: string, version?: number) {
      if (name === 'capri-ios-conversation' && !failed) {
        failed = true;
        throw new DOMException('Fallo transitorio de prueba', 'UnknownError');
      }
      return Reflect.apply(original, this, version === undefined ? [name] : [name, version]);
    };
  });
  await page.goto('/');
  await expect(page.locator('#storage-warning')).toBeVisible();
  await expect(page.locator('#storage-warning [role="status"]')).toHaveText('Recuperación pendiente');
  await expect(page.getByRole('button', { name: 'Abrir rescate de guardado' })).toBeVisible();
  await page.getByRole('button', { name: 'Reintentar recuperación' }).click();
  await expect(page.locator('#storage-warning')).toBeHidden();
});

test('storage failure stays visible above the composer and offers recovery at large text size', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/'); await expect(page.locator('#history-loading')).toBeHidden();
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 420;
    const context = canvas.getContext('2d')!; context.fillStyle = '#ff408e'; context.fillRect(20, 10, 200, 400);
    return canvas.toDataURL().split(',')[1]!;
  });
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#art').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready', 'true', { timeout: 20000 });
  await page.locator('[data-panel="chat"]').click();
  await expect.poll(() => page.evaluate(async () => Boolean(await (await import('/src/conversation-journal.ts')).createConversationJournal().pending()))).toBe(false);
  await page.evaluate(async () => {
    const conversation = await import('/src/conversation.ts');
    let saved = false;
    for (let i = 0; i < 30 && !saved; i++) {
      const current = await conversation.loadConversationBase();
      try {
        await conversation.saveConversation({ revision: (current?.revision ?? 0) + 1, draft: '', entries: Array.from({ length: 60 }, (_, index) => ({
          id: `history-${index}`, role: 'assistant', engine: 'iphone', state: 'complete', text: `Respuesta anterior ${index}`, at: index + 1,
        })) }); saved = true;
      } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    if (!saved) throw new Error('No se pudo preparar la historia de prueba.');
    window.addEventListener('pagehide', event => event.stopImmediatePropagation(), true);
  });
  await page.reload(); await expect(page.locator('.chat-card')).toHaveCount(60);
  await page.evaluate(async () => {
    document.documentElement.style.fontSize = '200%';
    const { conversationArchive } = await import('/src/conversation-archive.ts');
    (window as any).originalArchiveUpsert = conversationArchive.upsert;
    conversationArchive.upsert = async () => { throw new Error('Cuota simulada'); };
  });
  await page.locator('#conversation-scroll').evaluate(el => { el.scrollTop = 0; });
  await page.locator('#prompt').fill('Borrador que debe conservarse');
  await expect(page.locator('#rescue-history')).toBeVisible();
  await expect(page.locator('#send')).toBeDisabled();
  const location = await page.evaluate(() => {
    const viewport = document.querySelector('#conversation-scroll')!.getBoundingClientRect();
    const warning = document.querySelector('#chat-notice')!.getBoundingClientRect();
    return { bottom: viewport.bottom, warningTop: warning.top };
  });
  expect(location.warningTop).toBeGreaterThan(location.bottom);
  const warning = page.locator('#storage-warning');
  const rescue = page.getByRole('button', { name: 'Abrir rescate de guardado' });
  await expect(warning).toBeVisible();
  await expect(warning.getByRole('status')).toHaveText('Guardado sin confirmar');
  await expect(rescue).toBeVisible();
  const geometry = await page.evaluate(() => {
    const warning = document.querySelector('#storage-warning')!.getBoundingClientRect();
    const composer = document.querySelector('.composer')!.getBoundingClientRect();
    const button = document.querySelector('#storage-warning button')!.getBoundingClientRect();
    return { warningTop: warning.top, warningBottom: warning.bottom, composerTop: composer.top, composerBottom: composer.bottom, buttonHeight: button.height, width: document.documentElement.scrollWidth, viewport: innerWidth };
  });
  expect(geometry.warningTop).toBeGreaterThanOrEqual(0);
  expect(geometry.warningBottom).toBeLessThanOrEqual(geometry.composerTop + 1);
  expect(geometry.composerBottom).toBeLessThanOrEqual(568);
  expect(geometry.buttonHeight).toBeGreaterThanOrEqual(44);
  expect(geometry.width).toBeLessThanOrEqual(geometry.viewport);
  await page.locator('#prompt').focus();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperties(viewport, { height: { configurable: true, value: 360 }, pageTop: { configurable: true, value: 0 }, scale: { configurable: true, value: 1 } });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'true');
  await expect.poll(() => rescue.evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.bottom <= 361 && document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('button') === element;
  })).toBe(true);
  await expect(page.locator('#rig-handle')).toHaveAccessibleName(/Saludar a Capri/);
  await expect(page.locator('#rig-handle')).toBeVisible();
  await expect(page.locator('#prompt')).toBeVisible();
  await page.locator('#prompt').blur();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, 'height', { configurable: true, value: window.innerHeight });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'false');
  await rescue.click();
  await expect(page.locator('#panel-inbox')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Exportar historial' })).toBeVisible();
  await page.evaluate(async () => {
    const { conversationArchive } = await import('/src/conversation-archive.ts');
    conversationArchive.upsert = (window as any).originalArchiveUpsert;
  });
  await page.getByRole('button', { name: 'Reintentar guardado' }).click();
  await expect(page.getByRole('button', { name: 'Reintentar guardado' })).toBeHidden();
  await page.locator('[data-panel="chat"]').click();
  await expect(warning).toBeHidden();
  await expect(page.locator('#prompt')).toHaveValue('Borrador que debe conservarse');
});
