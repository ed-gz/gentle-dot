import { expect, test } from '@playwright/test';

for (const disconnect of [false, true]) {
  test('late Keychain restoration cannot replace a newer connection' + (disconnect ? ' or undo disconnect' : ''), async ({ page }) => {
    const hellos: { endpoint: string; token: string }[] = [];
    let oldHostConnections = 0;
    await page.routeWebSocket('wss://old.fixture.example/ws', ws => {
      oldHostConnections++;
      ws.onMessage(raw => { const message = JSON.parse(String(raw)); if (message.type === 'hello') hellos.push({ endpoint: 'A', token: message.token }); });
    });
    await page.routeWebSocket('wss://new.fixture.example/ws', ws => {
      let seq = 0;
      ws.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (message.type === 'hello') {
          hellos.push({ endpoint: 'B', token: message.token });
          ws.send(JSON.stringify({ seq: seq++, type: 'ready', agentState: 'idle', conversationId: 'B' }));
        }
        if (message.type === 'get_history') ws.send(JSON.stringify({ seq: seq++, type: 'history', conversationId: 'B', messages: [] }));
      });
    });
    await page.goto('/');
    await page.evaluate(async () => {
      const { saveSettings } = await import('/src/local-state.ts' as string);
      saveSettings({ url: 'wss://old.fixture.example/ws', motion: 'reduced' });
    });
    await page.addInitScript(() => {
      const state = globalThis as any;
      state.isTauri = true;
      state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
        if (command.endsWith('check_availability')) return { available: false, status: 'model_not_ready', supportsSpanish: false };
        if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
        if (command.endsWith('secret_get') && args.request.scope === 'daemon-manual' && args.request.account === 'https://old.fixture.example') {
          return await new Promise(resolve => { state.releaseOldKeychain = () => resolve({ ok: true, value: 'fixture-token-A' }); });
        }
        return { ok: true };
      } };
    });
    await page.reload();
    await expect.poll(() => page.evaluate(() => typeof (globalThis as any).releaseOldKeychain)).toBe('function');
    await page.locator('[data-panel="settings"]').click();
    await page.getByText('Conexión manual', { exact: true }).click();
    await page.locator('#url').fill('wss://new.fixture.example/ws');
    await page.locator('#token').fill('fixture-token-B');
    await page.locator('#connection button[type="submit"]').click();
    await expect(page.locator('#status')).toHaveText('Vinculado a Gentle Dot');
    if (disconnect) {
      await page.locator('#disconnect').click();
      await expect(page.locator('#status')).toHaveText('Sin conexión');
    }
    await page.evaluate(async () => {
      (globalThis as any).releaseOldKeychain();
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    expect(hellos).toEqual([{ endpoint: 'B', token: 'fixture-token-B' }]);
    expect(oldHostConnections).toBe(0);
    await expect(page.locator('#status')).toHaveText(disconnect ? 'Sin conexión' : 'Vinculado a Gentle Dot');
    await expect(page.locator('#url')).toHaveValue('wss://new.fixture.example/ws');
  });
}
