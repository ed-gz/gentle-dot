import { expect, test, type Page } from './fixtures.ts';

async function fixture(page: Page) {
  await page.addInitScript(() => {
    const state = globalThis as any;
    state.isTauri = true; state.calls = []; state.documentItems = [];
    state.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command.endsWith('results_list')) return { ok: true, items: [] };
      const name = command.split('|').at(-1); state.calls.push(name);
      if (name === 'check_availability') return { available: true, status: 'available', supportsSpanish: true };
      if (name === 'agent_step') return new Promise(resolve => { state.completeStep = resolve; });
      if (name === 'documents_pick') {
        const bytes = new TextEncoder().encode('Contenido importado');
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
        const item = { schemaVersion: 1, id: 'd5a6e456-7a93-4bcc-b006-4493c78b5b66', title: 'Reunión.txt', notes: '', createdAt: 1000,
          files: [{ id: 'c623087b-1af4-4b20-a20a-31d33e419171', name: 'Reunión.txt', mime: 'text/plain', size: bytes.length, sha256: hash }] };
        state.documentItems = [item]; return { ok: true, cancelled: false, items: [item] };
      }
      if (name === 'documents_list') {
        if (state.holdDocumentsList) { state.holdDocumentsList = false; return new Promise(resolve => { state.releaseDocumentScan = () => resolve({ ok: true, items: [] }); }); }
        return { ok: true, items: state.documentItems };
      }
      if (name === 'documents_read') return { ok: true, data: btoa('Contenido importado') };
      if (name === 'documents_ack') { state.documentItems = []; return { ok: true, persisted: true }; }
      if (name === 'share_list') return { ok: true, items: [] };
      return { ok: true };
    } };
  });
}
test('native attachment action saves verified files before acknowledgement and survives reload', async ({ page }) => {
  await fixture(page); await page.goto('/');
  await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#send').click(); // An empty composer must not start inference.
  expect(await page.evaluate(() => (globalThis as any).calls.includes('agent_step'))).toBe(false);
  await page.getByRole('button', { name: 'Adjuntar archivos', exact: true }).click();
  await expect(page.locator('#attachment-context')).toContainText('Reunión.txt');
  const saved = await page.evaluate(async () => {
    const path = '/src/work-inbox.ts', inbox = await import(path);
    const work = (await inbox.listWork())[0];
    return { work, calls: (globalThis as any).calls, text: await (await inbox.readWorkFile(work.id, work.files[0].id)).text() };
  });
  expect(saved.calls).toContain('documents_pick'); expect(saved.calls).toContain('documents_ack');
  expect(saved.work.files).toHaveLength(1); expect(saved.text).toBe('Contenido importado');
  expect(saved.work.title).toBe('Reunión.txt');
  await page.reload();
  await expect(page.locator('#attachment-context')).toContainText('Material local adjunto');
  expect(await page.evaluate(async () => { const path = '/src/work-inbox.ts'; return (await (await import(path)).listWork()).length; })).toBe(1);
});
test('background visibility no longer aborts an in-flight native answer; explicit Stop still exists', async ({ page }) => {
  await fixture(page); await page.goto('/');
  await page.locator('#prompt').fill('Conserva esta respuesta al cambiar de app'); await page.locator('#send').click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).completeStep)).toBe('function');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  expect(await page.evaluate(() => (globalThis as any).calls.filter((call: string) => call === 'cancel').length)).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
    (globalThis as any).completeStep({ ok: true, decision: { kind: 'answer', text: 'Respuesta conservada al volver.', toolName: '', argumentsJSON: '{}' } });
  });
  await expect(page.locator('#cards')).toContainText('Respuesta conservada al volver.');
  await expect(page.locator('#stop')).toBeHidden();
});
test('a native selection waits for an older foreground scan and then imports the newly published file', async ({ page }) => {
  await fixture(page); await page.goto('/');
  await expect(page.locator('#history-loading')).toBeHidden();
  await page.evaluate(() => {
    (globalThis as any).holdDocumentsList = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).releaseDocumentScan)).toBe('function');
  await page.locator('#attach').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).documentItems.length)).toBe(1);
  await page.evaluate(() => (globalThis as any).releaseDocumentScan());
  await expect(page.locator('#attachment-context')).toContainText('Reunión.txt');
  await expect.poll(() => page.evaluate(() => (globalThis as any).documentItems.length)).toBe(0);
});
test('camera selection enters the same local attachment flow without sending', async ({ page }) => {
  await fixture(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Tomar foto' })).toBeVisible();
  await expect(page.locator('#chat-camera')).toHaveAttribute('capture', 'environment');
  const [picker] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Tomar foto' }).click()]);
  await picker.setFiles({ name: 'captura.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
  await expect(page.locator('#attachment-context')).toContainText('captura.jpg');
  expect(await page.evaluate(() => (globalThis as any).calls.includes('agent_step'))).toBe(false);
  expect(await page.evaluate(async () => { const inbox = await import('/src/work-inbox.ts' as string); const work = (await inbox.listWork())[0]; return [work.files[0].name, (await inbox.readWorkFile(work.id, work.files[0].id)).size]; })).toEqual(['captura.jpg', 4]);
});
test('composer controls remain fully reachable on small and landscape viewports with large text', async ({ page }) => {
  await page.goto('/');
  for (const size of [{ width: 375, height: 812 }, { width: 667, height: 375 }]) {
    await page.setViewportSize(size);
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await page.locator('#prompt').fill('Una instrucción para Capri');
    const row: import('@playwright/test').Rect[] = [];
    for (const id of ['attach', 'camera', 'dictate', 'prompt', 'send']) {
      const bounds = await page.locator('#' + id).boundingBox();
      expect(bounds).not.toBeNull(); expect(bounds!.width).toBeGreaterThanOrEqual(44); expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height);
      expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width);
      row.push(bounds!);
    }
    for (let i = 1; i < row.length; i++) { expect(row[i]!.x).toBeGreaterThanOrEqual(row[i - 1]!.x + row[i - 1]!.width - 1); expect(Math.abs((row[i]!.y + row[i]!.height) - (row[0]!.y + row[0]!.height))).toBeLessThanOrEqual(2); }
    expect(await page.locator('#send svg').count()).toBe(1);
  }
});
test('shell follows visual viewport resize and pan, and releases the pin for pinch zoom', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const v = window.visualViewport!;
    Object.defineProperties(v, { height: { configurable: true, value: 470 }, pageTop: { configurable: true, value: 36 }, scale: { configurable: true, value: 1 } });
    v.dispatchEvent(new Event('resize')); v.dispatchEvent(new Event('scroll'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'true');
  expect(await page.locator('main').evaluate(el => ({ top: Math.round(el.getBoundingClientRect().top), height: Math.round(el.getBoundingClientRect().height) }))).toEqual({ top: 36, height: 470 });
  await page.evaluate(() => { Object.defineProperty(window.visualViewport!, 'scale', { configurable: true, value: 1.5 }); window.visualViewport!.dispatchEvent(new Event('resize')); });
  expect(await page.locator('html').evaluate(el => [el.style.getPropertyValue('--app-height'), el.style.getPropertyValue('--app-offset-top')])).toEqual(['', '']);
});
