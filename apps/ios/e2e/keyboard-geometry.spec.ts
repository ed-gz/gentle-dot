import { expect, test } from './fixtures.ts';

for (const hasHistory of [false, true]) test(`a long ${hasHistory ? 'existing' : 'new'} conversation stays usable when the keyboard opens and closes`, async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.locator('#history-loading')).toBeHidden();
  if (hasHistory) {
    await page.evaluate(async () => {
      const { saveConversation, loadConversationBase } = await import('/src/conversation.ts' as string);
      let saved = false;
      for (let i = 0; i < 30 && !saved; i++) {
        const current = await loadConversationBase();
        try {
          await saveConversation({ revision: (current?.revision ?? 0) + 1, draft: '', entries: [{ id: 'history', role: 'assistant', engine: 'iphone', state: 'complete', text: 'Una respuesta anterior.', at: 1000 }] });
          saved = true;
        } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
      }
      if (!saved) throw new Error('No se pudo preparar la historia de prueba.');
      window.addEventListener('pagehide', event => event.stopImmediatePropagation(), true);
    });
    await page.reload(); await expect(page.locator('#cards')).toContainText('Una respuesta anterior.');
  }
  await page.locator('#prompt').fill('Una instrucción larga para revisar.\n'.repeat(30));
  await page.locator('#prompt').focus();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperties(viewport, { height: { configurable: true, value: 300 }, pageTop: { configurable: true, value: 0 }, scale: { configurable: true, value: 1 } });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'true');
  const layout = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const input = rect('#prompt'), composer = rect('#composer'), reading = rect('#conversation-scroll'), send = rect('#send');
    return { composerBottom: composer.bottom, readingHeight: reading.height, inputHeight: input.height, sendBottom: send.bottom };
  });
  expect(layout.composerBottom).toBeLessThanOrEqual(301);
  expect(layout.sendBottom).toBeLessThanOrEqual(301);
  expect(layout.readingHeight).toBeGreaterThanOrEqual(56);
  expect(layout.inputHeight).toBeLessThanOrEqual(110);
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, 'pageTop', { configurable: true, value: 36 });
    viewport.dispatchEvent(new Event('scroll'));
  });
  expect(await page.locator('#composer').evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(337);
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, 'pageTop', { configurable: true, value: 0 });
    viewport.dispatchEvent(new Event('scroll'));
  });
  for (const button of await page.locator('.navigation button').all()) {
    const bounds = await button.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(300);
  }
  await expect(page.locator('#prompt')).toHaveAccessibleName('Mensaje para Capri');
  await expect(page.locator('#rig-handle')).toHaveAttribute('aria-label', /Saludar a Capri/);
  await page.screenshot({ path: testInfo.outputPath(`keyboard-${hasHistory ? 'history' : 'empty'}.png`) });
  await page.locator('#prompt').blur();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperties(viewport, { height: { configurable: true, value: window.innerHeight }, pageTop: { configurable: true, value: 0 } });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'false');
  await expect(page.locator('#prompt')).toHaveValue('Una instrucción larga para revisar.\n'.repeat(30));
  const restored = await page.locator('#composer').boundingBox();
  expect(restored!.y + restored!.height).toBeLessThanOrEqual(845);
  if (!hasHistory) expect((await page.locator('.companion-presence').boundingBox())!.height).toBeGreaterThan(200);
});

test('large text stays editable when a simulated keyboard reduces the visual viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/'); await expect(page.locator('#history-loading')).toBeHidden();
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.locator('#prompt').fill('Un mensaje largo.\n'.repeat(20)); await page.locator('#prompt').focus();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperties(viewport, { height: { configurable: true, value: 360 }, pageTop: { configurable: true, value: 0 }, scale: { configurable: true, value: 1 } });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-large-text', 'true');
  const geometry = await page.evaluate(() => {
    const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')!, style = getComputedStyle(prompt);
    const send = document.querySelector<HTMLElement>('#send')!.getBoundingClientRect();
    return { sendBottom: send.bottom, promptBottom: prompt.getBoundingClientRect().bottom,
      innerHeight: prompt.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      lineHeight: parseFloat(style.lineHeight), overflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(geometry.overflow).toBe(false);
  expect(geometry.sendBottom).toBeLessThanOrEqual(361);
  expect(geometry.promptBottom).toBeLessThanOrEqual(361);
  expect(geometry.innerHeight).toBeGreaterThanOrEqual(geometry.lineHeight - 1);
});

test('the animated companion remains reachable without covering the composer while the keyboard is open', async ({ page }) => {
  test.slow();
  await page.goto('/');
  await expect(page.locator('#history-loading')).toBeHidden();
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 420;
    const context = canvas.getContext('2d')!; context.fillStyle = '#ff408e'; context.fillRect(20, 10, 200, 400);
    return canvas.toDataURL().split(',')[1]!;
  });
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#art').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready', 'true', { timeout: 20000 });
  await page.locator('[data-panel="chat"]').click();
  await page.locator('#prompt').focus();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperties(viewport, { height: { configurable: true, value: 300 }, pageTop: { configurable: true, value: 0 }, scale: { configurable: true, value: 1 } });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('#rig-handle')).toBeVisible();
  await expect(page.locator('#rig-handle')).toHaveAccessibleName(/Saludar a Capri/);
  await expect.poll(() => page.locator('#send').evaluate(element => {
    const box = element.getBoundingClientRect(); return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('#send') === element;
  })).toBe(true);
  await expect(page.locator('#send')).toBeVisible();
});
