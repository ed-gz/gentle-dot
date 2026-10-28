import { expect, test } from '@playwright/test';

async function nativeFixture(page: import('@playwright/test').Page, delayed = false) {
  await page.addInitScript(({ delayed }) => {
    const state = globalThis as any;
    state.isTauri = true;
    state.nativePrompts = [];
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('respond')) {
        state.nativePrompts.push(args.prompt);
        if (delayed) return await new Promise(resolve => { state.finishNative = resolve; });
        return { ok: true, text: 'Respuesta local de prueba <b>literal</b>.' };
      }
      return { ok: true };
    } };
  }, { delayed });
}

test('browser never claims native inference; draft survives reload without sending', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#engine-status')).toContainText('esta vista no ejecuta');
  await expect(page.locator('#send')).toBeDisabled();
  await page.locator('#prompt').fill('Conservar este borrador offline');
  await expect.poll(async () => page.evaluate(async () => (await (await import('/src/conversation.ts' as string)).loadConversation()).draft)).toBe('Conservar este borrador offline');
  await page.reload();
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#prompt')).toHaveValue('Conservar este borrador offline');
  await expect(page.locator('.chat-card')).toHaveCount(0);
});

test('native bridge fixture maintains one local timeline and bounds follow-up context', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await page.locator('[data-panel="chat"]').click();
  await page.locator('#prompt').fill('Mi proyecto se llama Capri.');
  await page.locator('#send').click();
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText('Respuesta local de prueba');
  await expect(page.locator('.chat-text b')).toHaveCount(0);
  await page.locator('#prompt').fill('¿Cómo se llama mi proyecto?');
  await page.locator('#send').click();
  await expect(page.locator('.chat-card[data-role="assistant"]')).toHaveCount(2);
  const prompts = await page.evaluate(() => (globalThis as any).nativePrompts);
  expect(prompts[1]).toContain('Mi proyecto se llama Capri.');
  expect(Array.from(prompts[1]).length).toBeLessThanOrEqual(4000);
  await expect.poll(async () => page.evaluate(async () => (await (await import('/src/conversation.ts' as string)).loadConversation()).entries.length)).toBe(4);
  await page.reload();
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('.chat-card')).toHaveCount(4);
});

test('cancel suppresses late native completion and never reports success', async ({ page }) => {
  await nativeFixture(page, true);
  await page.goto('/');
  await page.locator('[data-panel="chat"]').click();
  await page.locator('#prompt').fill('Genera una respuesta');
  await page.locator('#send').click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishNative)).toBe('function');
  await page.locator('#stop').click();
  await page.evaluate(() => (globalThis as any).finishNative({ ok: true, text: 'LATE RESULT' }));
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText('Respuesta interrumpida.');
  await expect(page.locator('#cards')).not.toContainText('LATE RESULT');
  await expect(page.locator('#send')).toBeEnabled();
});

test('linked stream, intermediate completion, error and reconnect remain honest', async ({ page }) => {
  let wireText = '';
  let sentCount = 0;
  let connection = 0;
  await page.routeWebSocket('wss://fixture.example/ws', ws => {
    let seq = 0;
    const send = (data: object) => ws.send(JSON.stringify({ seq: seq++, ...data }));
    connection++;
    ws.onMessage(raw => {
      const data = JSON.parse(String(raw));
      if (data.type === 'hello') send({ type: 'ready', agentState: 'idle', conversationId: 'c1' });
      if (data.type === 'get_history') send({ type: 'history', conversationId: 'c1', messages: wireText ? [
        { id: 'h1', role: 'user', text: wireText, activities: [] },
        { id: 'h2', role: 'assistant', text: 'Primera parte', activities: [] },
      ] : [] });
      if (data.type === 'send') {
        sentCount++; wireText = data.text;
        send({ type: 'user_message', messageId: 'm1', text: data.text });
        send({ type: 'agent_state', state: 'thinking' });
        send({ type: 'message_delta', messageId: 'm2', delta: 'Primera ' });
        send({ type: 'message_done', messageId: 'm2', text: 'Primera parte', intermediate: true });
        send({ type: 'message_done', messageId: 'm3', text: '', error: 'Error de prueba visible' });
        send({ type: 'agent_state', state: 'idle' });
      }
    });
  });
  await nativeFixture(page);
  await page.goto('/');
  await page.locator('[data-panel="chat"]').click();
  await page.locator('#prompt').fill('Contexto desde el iPhone');
  await page.locator('#send').click();
  await expect(page.locator('.chat-card[data-role="assistant"]')).toHaveCount(1);
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#url').fill('wss://fixture.example/ws');
  await page.locator('#token').fill('fixture-only');
  await page.locator('#connection button[type="submit"]').click();
  await expect(page.locator('#status')).toHaveText('Vinculado a Gentle Dot');
  await expect(page.locator('#token')).toHaveValue('');
  await page.locator('[data-panel="chat"]').click();
  await page.locator('#engine').selectOption('gentle');
  await page.locator('#prompt').fill('Continúa desde la laptop');
  await page.locator('#send').click();
  await expect(page.locator('#cards')).toContainText('Error de prueba visible');
  await expect(page.locator('#cards')).not.toContainText('Preparando respuesta');
  expect(wireText).toContain('Contexto desde el iPhone');
  const userCount = await page.locator('.chat-card[data-role="user"]').count();
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#disconnect').click();
  await page.locator('#token').fill('fixture-only');
  await page.locator('#connection button[type="submit"]').click();
  await expect.poll(() => connection).toBe(2);
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('.chat-card[data-role="user"]')).toHaveCount(userCount);
  expect(sentCount).toBe(1);
  const persisted = await page.evaluate(() => JSON.stringify(localStorage));
  expect(persisted).not.toContain('fixture-only');
});

test('character artwork persists; appearance and motion controls fit small and large text', async ({ page }, testInfo) => {
  // Image decoding and the real WebGL rig also run on software renderers in CI.
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 240; c.height = 420;
    const ctx = c.getContext('2d')!; ctx.fillStyle = '#ff408e'; ctx.fillRect(10, 10, 220, 400);
    return c.toDataURL().split(',')[1];
  });
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#art').setInputFiles({ name: 'capri-test.png', mimeType: 'image/png', buffer: Buffer.from(png!, 'base64') });
  await expect(page.locator('#settings-status')).toHaveText('Arte guardado en este dispositivo.');
  await page.locator('#motion').selectOption('reduced');
  await page.reload();
  const restored = await page.evaluate(async () => {
    const blob = await (await import('/src/local-state.ts' as string)).loadArtwork();
    if (!blob) return { missing: true };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image(); img.src = url; await img.decode();
      return { png: btoa(String.fromCharCode(...bytes)), width: img.naturalWidth, height: img.naturalHeight };
    } finally { URL.revokeObjectURL(url); }
  });
  await testInfo.attach('art-restoration.json', { body: JSON.stringify({ restored, errors }), contentType: 'application/json' });
  expect(restored).toEqual({ png, width: 240, height: 420 });
  await expect(page.locator('#motion')).toHaveValue('reduced');
  try {
    await expect(page.locator('#art-placeholder')).toBeHidden();
  } catch (error) {
    console.log('Art restoration failure', await page.evaluate(() => ({
      ready: document.readyState,
      settings: document.getElementById('settings-status')?.textContent,
      art: document.getElementById('art-status')?.textContent,
      conversation: document.getElementById('chat-notice')?.textContent,
      hidden: (document.getElementById('art-placeholder') as HTMLElement)?.hidden,
    })), errors);
    throw error;
  }
  await page.locator('#appear').click();
  await expect(page.locator('#rig-handle')).toBeDisabled();
  await page.locator('#appear').click();
  await expect(page.locator('#rig-handle')).toBeEnabled();
  for (const size of [{ width: 375, height: 812 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('body *')].filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1) && !node.closest('#stage');
    }).map(node => node.id || node.className || node.tagName))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const button of await page.locator('.navigation button, .character-actions button').all()) {
      const bounds = await button.boundingBox(); expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: testInfo.outputPath(`layout-${size.width}-200-percent.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});
