import { expect, test } from './fixtures.ts';

test('auto sends to the ready laptop even when iPhone inference is ready', async ({ page }) => {
  const submissions: string[] = [];
  await page.addInitScript(() => {
    const state = globalThis as any;
    state.isTauri = true;
    state.localSteps = 0;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('secret_get')) {
        const request = args.request;
        const value = sessionStorage.getItem(`fixture-keychain:${request.scope}:${request.account}`);
        return value === null ? { ok: true } : { ok: true, value };
      }
      if (command.endsWith('secret_set')) {
        const request = args.request;
        const key = `fixture-keychain:${request.scope}:${request.account}`;
        if (request.compare === true && sessionStorage.getItem(key) !== (request.expected ?? null)) return { ok: true, persisted: false };
        sessionStorage.setItem(key, request.value);
        return { ok: true, persisted: true };
      }
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('agent_step')) {
        state.localSteps++;
        return { ok: true, decision: { kind: 'answer', text: 'Respuesta local', toolName: '', argumentsJSON: '{}' } };
      }
      if (command.endsWith('share_list') || command.endsWith('documents_list') || command.endsWith('results_list')) return { ok: true, items: [] };
      return { ok: true };
    } };
  });
  await page.routeWebSocket('wss://routing.example/ws', ws => {
    let seq = 0;
    const send = (data: object) => ws.send(JSON.stringify({ seq: seq++, ...data }));
    ws.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello') send({ type: 'ready', agentState: 'idle', conversationId: 'main' });
      if (message.type === 'get_history') send({ type: 'history', conversationId: 'main', messages: [] });
      if (message.type === 'send') {
        submissions.push(message.text);
        send({ type: 'user_message', messageId: 'host-echo', text: message.text });
        send({ type: 'message_done', messageId: 'host-answer', text: 'Respuesta desde la laptop' });
      }
    });
  });
  await page.goto('/');
  await expect(page.locator('#engine-summary')).toHaveText('Auto · iPhone');
  await page.locator('[data-panel="settings"]').click();
  if (!await page.locator('#url').isVisible()) await page.getByText('Conexión manual', { exact: true }).click();
  await page.locator('#url').fill('wss://routing.example/ws');
  await page.locator('#token').fill('fixture-only');
  await page.locator('#connection button[type="submit"]').click();
  await expect(page.locator('#status')).toContainText('Vinculado a Gentle Dot');
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#engine-summary')).toHaveText('Auto · laptop');
  await page.locator('#prompt').fill('Controla mi laptop');
  await page.locator('#send').click();
  await expect.poll(() => submissions).toEqual(['Controla mi laptop']);
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText('Respuesta desde la laptop');
  expect(await page.evaluate(() => (globalThis as any).localSteps)).toBe(0);
});
