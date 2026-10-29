import { expect, test } from './fixtures.ts';

for (const disconnect of [false, true]) {
  test('late Keychain restoration cannot replace a newer connection' + (disconnect ? ' or undo disconnect' : ''), async ({ page }) => {
    const hellos: { endpoint: string; token: string }[] = [];
    let oldHostConnections = 0;
    await page.routeWebSocket('wss://old.fixture.example/ws', ws => {
      oldHostConnections++;
      let seq = 0;
      ws.onMessage(raw => { const message = JSON.parse(String(raw)); if (message.type === 'hello') { hellos.push({ endpoint: 'A', token: message.token }); ws.send(JSON.stringify({ seq: seq++, type: 'ready', agentState: 'idle', conversationId: 'A' })); } });
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
      state.isTauri = true; state.selectionMarker = undefined;
      state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('results_list')) return { ok: true, items: [] };
        if (command.endsWith('check_availability')) return { available: false, status: 'model_not_ready', supportsSpanish: false };
        if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
        if (command.endsWith('secret_get') && args.request.scope === 'daemon-manual' && args.request.account === 'https://old.fixture.example') {
          return await new Promise(resolve => { state.releaseOldKeychain = () => resolve({ ok: true, value: 'fixture-token-A' }); });
        }
        if (command.endsWith('secret_get') && args.request.account === 'capri.selected-connection.v1') return { ok: true, value: state.selectionMarker };
        if (command.endsWith('secret_set') && args.request.account === 'capri.selected-connection.v1') { if (args.request.compare !== true) return {ok:false}; if ((state.selectionMarker ?? null) !== (args.request.expected ?? null)) return {ok:true,persisted:false}; state.selectionMarker = args.request.value; return { ok: true, persisted:true }; }
        return { ok: true };
      } };
    });
    await page.reload();
    await expect.poll(() => page.evaluate(() => typeof (globalThis as any).releaseOldKeychain)).toBe('function');
    await page.locator('[data-panel="settings"]').click();
    await page.getByText('Conexión manual', { exact: true }).click();
    await expect(page.locator('#connection button[type="submit"]')).toBeDisabled();
    if (disconnect) {
      await expect(page.locator('#status')).toContainText('No pude verificar', { timeout: 12000 });
      await page.locator('#disconnect').click();
      await expect(page.locator('#status')).toHaveText('Sin conexión');
    } else {
      await page.evaluate(() => (globalThis as any).releaseOldKeychain());
      await expect(page.locator('#status')).toContainText('Vinculado a Gentle Dot');
    }
    await page.locator('#url').fill('wss://new.fixture.example/ws');
    await page.locator('#token').fill('fixture-token-B');
    await page.locator('#connection button[type="submit"]').click();
    await expect(page.locator('#status')).toContainText('Vinculado a Gentle Dot');
    if (disconnect) {
      await page.locator('#disconnect').click();
      await expect(page.locator('#status')).toHaveText('Sin conexión');
    }
    await page.evaluate(async () => {
      (globalThis as any).releaseOldKeychain();
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    expect(hellos).toEqual(disconnect ? [{ endpoint: 'B', token: 'fixture-token-B' }] : [{ endpoint: 'A', token: 'fixture-token-A' }, { endpoint: 'B', token: 'fixture-token-B' }]);
    expect(oldHostConnections).toBe(disconnect ? 0 : 1);
    if (disconnect) await expect(page.locator('#status')).toHaveText('Sin conexión');
    else await expect(page.locator('#status')).toContainText('Vinculado a Gentle Dot');
    await expect(page.locator('#url')).toHaveValue('wss://new.fixture.example/ws');
  });
}
