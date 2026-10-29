import { expect, test } from './fixtures.ts';

test('a lost connection is visible while reading the end of a long session', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as any;
    state.isTauri = true;
    state.offline = false;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('https_request')) {
        if (state.offline) throw new Error('La laptop no responde');
        const body = args.request.body ? JSON.parse(args.request.body) : undefined;
        const reply = body?.action === 'inspect' ? {
          sessionId: body.sessionId, status: 'working',
          messages: Array.from({ length: 30 }, (_, i) => ({ id: `message-${i}`, role: 'assistant', content: [{ type: 'text', text: `Respuesta ${i}` }] })),
          history: { hasEarlier: false },
        } : { available: true, sessions: [{ paneId: 'pane', sessionId: 'session', label: 'Operaciones', provider: 'herdr', state: 'working', connected: true, managed: true, capabilities: { inspect: true, prompt: true } }], approvals: [], policies: [], events: [] };
        return { ok: true, status: 200, headers: {}, body: JSON.stringify(reply) };
      }
      if (command.endsWith('check_availability')) return { available: false, status: 'model_not_ready', supportsSpanish: false };
      if (command.endsWith('results_list') || command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      return { ok: true };
    } };
  });
  await page.goto('/');
  await page.evaluate(async () => {
    document.querySelector<HTMLElement>('#panel-chat')!.hidden = true;
    document.querySelector<HTMLElement>('#panel-agents')!.hidden = false;
    const { mountLaptopView } = await import('/src/laptop-view.tsx' as string);
    mountLaptopView(document.querySelector('#laptop-root')!, () => {}, () => {})
      .update({ connection: { url: 'wss://laptop.example/ws', token: 'fixture' }, active: true });
  });
  await page.getByRole('button', { name: /Operaciones/ }).click();
  await expect(page.getByText('Respuesta 29')).toBeVisible();
  const draft = page.getByRole('textbox', { name: 'Continuar esta sesión' });
  await draft.fill('Conservar borrador');
  await page.locator('.agent-detail-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.evaluate(() => { (globalThis as any).offline = true; });
  const alert = page.locator('.session-connection-notices [role="alert"]');
  await expect(alert).toContainText('El puente nativo no completó la operación.', { timeout: 8000 });
  for (const size of ['100%', '200%']) {
    await page.evaluate(value => { document.documentElement.style.fontSize = value; }, size);
    const notices = await page.locator('.session-connection-notices').boundingBox();
    const history = await page.locator('.agent-detail-scroll').boundingBox();
    const composer = await page.locator('.agent-reply').boundingBox();
    expect(notices && history && composer).toBeTruthy();
    expect(notices!.y).toBeGreaterThanOrEqual(0);
    expect(notices!.y + notices!.height).toBeLessThanOrEqual(history!.y + 1);
    expect(history!.height).toBeGreaterThan(30);
    expect(history!.y + history!.height).toBeLessThanOrEqual(composer!.y + 1);
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '100%';
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 320 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(() => page.locator('.agent-reply').evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(320);
  const keyboardNotices = await page.locator('.session-connection-notices').boundingBox();
  const keyboardHistory = await page.locator('.agent-detail-scroll').boundingBox();
  const keyboardComposer = await page.locator('.agent-reply').boundingBox();
  expect(keyboardNotices!.y + keyboardNotices!.height).toBeLessThanOrEqual(keyboardHistory!.y + 1);
  expect(keyboardHistory!.y + keyboardHistory!.height).toBeLessThanOrEqual(keyboardComposer!.y + 1);
  await page.evaluate(() => {
    delete (window.visualViewport as any).height;
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await page.evaluate(() => { (globalThis as any).offline = false; });
  await expect(alert).toHaveCount(0, { timeout: 8000 });
  await expect(draft).toHaveValue('Conservar borrador');
  await expect(page.getByText('Respuesta 29')).toBeVisible();
});
