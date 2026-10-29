import { expect, test, type Page, type WebSocketRoute } from './fixtures.ts';

async function fixture(page: Page, modern: boolean) {
  let emit!: (message: object) => void;
  let socket!: WebSocketRoute;
  const sent: any[] = [];
  await page.routeWebSocket('wss://accept.fixture.example/ws', ws => {
    socket = ws; let seq = 0;
    emit = message => ws.send(JSON.stringify({ seq: ++seq, ...message }));
    ws.onMessage(raw => {
      const message = JSON.parse(String(raw)); sent.push(message);
      if (message.type === 'hello') emit({ type: 'ready', agentState: 'idle', conversationId: 'c1', features: { conversations: false, ...(modern ? { sendAccepted: 1 } : {}) } });
      if (message.type === 'get_history') emit({ type: 'history', conversationId: 'c1', messages: [] });
    });
  });
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, wrapper: any) => {
      const request = wrapper?.request;
      if (command.endsWith('secret_get')) {
        const value = sessionStorage.getItem(`fixture-keychain:${request.scope}:${request.account}`);
        return value === null ? { ok: true } : { ok: true, value };
      }
      if (command.endsWith('secret_set')) {
        sessionStorage.setItem(`fixture-keychain:${request.scope}:${request.account}`, request.value); return { ok: true };
      }
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('agent_step')) return { ok: true, decision: { kind: 'answer', text: 'Respuesta local.', toolName: '', argumentsJSON: '{}' } };
      if (command.endsWith('results_list') || command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      return { ok: true };
    } };
  });
  await page.goto('/');
  await page.locator('[data-panel="settings"]').click();
  await page.getByText('Conexión manual', { exact: true }).click();
  await page.locator('#url').fill('wss://accept.fixture.example/ws'); await page.locator('#token').fill('fixture-only');
  await page.locator('#connection button[type="submit"]').click();
  await expect(page.locator('#status')).toContainText('Acceso guardado en Keychain');
  await page.locator('[data-panel="chat"]').click(); await page.locator('.engine-details summary').click();
  await page.locator('#engine').selectOption('gentle');
  return { sent, emit: (message: object) => emit(message), drop: () => socket.close({ code: 1001, reason: 'fixture' }) };
}

test('acceptance matches the request, never an identical foreign echo or a stale acknowledgement', async ({ page }) => {
  const host = await fixture(page, true);
  await page.locator('#prompt').fill('La misma instrucción'); await page.locator('#send').click();
  await expect.poll(() => host.sent.filter(message => message.type === 'send').length).toBe(1);
  const sent = host.sent.find(message => message.type === 'send');
  expect(sent.receipt).toBe('accepted-v1');
  host.emit({ type: 'user_message', messageId: 'foreign', text: sent.text });
  host.emit({ type: 'request_accepted', requestId: 'another-request' });
  const cards = page.locator('.chat-card[data-role="user"]');
  await expect(cards).toHaveCount(2);
  await expect(cards.first().locator('small')).toContainText('Esperando confirmación');
  host.emit({ type: 'request_accepted', requestId: sent.requestId });
  await expect(cards.first().locator('small')).toHaveText('');
  await expect(page.locator('#chat-notice')).toContainText('no confirma que esté guardada');
  await expect(cards).toHaveCount(2);
  expect(host.sent.filter(message => message.type === 'send')).toHaveLength(1);
});

test('an echo after acceptance redacts local context without merging either record', async ({ page }) => {
  const host = await fixture(page, true);
  await page.locator('#engine').selectOption('iphone');
  await page.locator('#prompt').fill('Dato local previo'); await page.locator('#send').click();
  await expect(page.getByText('Respuesta local.', { exact: true })).toBeVisible();
  await page.locator('#engine').selectOption('gentle');
  await page.locator('#prompt').fill('Solicitud actual'); await page.locator('#send').click();
  await expect.poll(() => host.sent.filter(message => message.type === 'send').length).toBe(1);
  const sent = host.sent.find(message => message.type === 'send');
  expect(sent.text).toContain('Contexto reciente de Capri');
  host.emit({ type: 'request_accepted', requestId: sent.requestId });
  await expect(page.locator('#chat-notice')).toContainText('no confirma que esté guardada');
  host.emit({ type: 'user_message', messageId: 'later-echo', text: sent.text });
  await expect(page.locator('.chat-card[data-role="user"] .chat-text')).toHaveText(['Dato local previo', 'Solicitud actual', 'Solicitud actual']);
  await expect(page.locator('#cards')).not.toContainText('Contexto reciente de Capri');
});

test('a legacy host leaves an indistinguishable echo unconfirmed and never receives the opt-in', async ({ page }) => {
  const host = await fixture(page, false);
  await page.locator('#prompt').fill('Repetido'); await page.locator('#send').click();
  await expect.poll(() => host.sent.filter(message => message.type === 'send').length).toBe(1);
  const sent = host.sent.find(message => message.type === 'send');
  expect(sent.receipt).toBeUndefined();
  host.emit({ type: 'user_message', messageId: 'foreign', text: sent.text });
  const cards = page.locator('.chat-card[data-role="user"]');
  await expect(cards).toHaveCount(2);
  await expect(cards.first().locator('small')).toContainText('sin confirmar');
  await host.drop();
  await expect.poll(() => host.sent.filter(message => message.type === 'hello').length).toBe(2);
  expect(host.sent.filter(message => message.type === 'send')).toHaveLength(1);
});

test('an unrelated host error cannot erase a request before its correlated acceptance', async ({ page }) => {
  const host = await fixture(page, true);
  await page.locator('#prompt').fill('Continuar la tarea'); await page.locator('#send').click();
  await expect.poll(() => host.sent.filter(message => message.type === 'send').length).toBe(1);
  const sent = host.sent.find(message => message.type === 'send');
  const card = page.locator('.chat-card[data-role="user"]').first();
  host.emit({ type: 'error', code: 'history_unavailable', message: 'No se pudo recuperar otra operación.' });
  await expect(card.locator('small')).toContainText('Esperando confirmación');
  host.emit({ type: 'request_accepted', requestId: sent.requestId });
  await expect(card.locator('small')).toHaveText('');
  await expect(page.locator('#chat-notice')).toContainText('no confirma que esté guardada');
  expect(host.sent.filter(message => message.type === 'send')).toHaveLength(1);
});

test('without a correlated acceptance an error times out honestly and does not resend', async ({ page }) => {
  await page.clock.install();
  const host = await fixture(page, true);
  await page.locator('#prompt').fill('Solicitud sin confirmar'); await page.locator('#send').click();
  await expect.poll(() => host.sent.filter(message => message.type === 'send').length).toBe(1);
  const sent = host.sent.find(message => message.type === 'send');
  host.emit({ type: 'error', code: 'command_failed', message: 'No se pudo completar una operación.' });
  const card = page.locator('.chat-card[data-role="user"]').first();
  await expect(card.locator('small')).toContainText('Esperando confirmación');
  await page.clock.fastForward(15_001);
  await expect(card.locator('small')).toContainText('sin confirmar');
  host.emit({ type: 'request_accepted', requestId: sent.requestId });
  await expect(card.locator('small')).toContainText('sin confirmar');
  expect(host.sent.filter(message => message.type === 'send')).toHaveLength(1);
});

test('a prior socket acceptance cannot confirm a later send after reconnect', async ({ page }) => {
  const host = await fixture(page, true);
  await page.locator('#prompt').fill('Primer envío'); await page.locator('#send').click();
  await expect.poll(() => host.sent.filter(message => message.type === 'send').length).toBe(1);
  const first = host.sent.find(message => message.type === 'send');
  await host.drop();
  await expect.poll(() => host.sent.filter(message => message.type === 'hello').length).toBe(2);
  await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#prompt').fill('Segundo envío'); await page.locator('#send').click();
  await expect.poll(() => host.sent.filter(message => message.type === 'send').length).toBe(2);
  const second = host.sent.filter(message => message.type === 'send')[1];
  expect(second.requestId).not.toBe(first.requestId);
  host.emit({ type: 'request_accepted', requestId: first.requestId });
  const cards = page.locator('.chat-card[data-role="user"]');
  await expect(cards.last().locator('small')).toContainText('Esperando confirmación');
  host.emit({ type: 'request_accepted', requestId: second.requestId });
  await expect(cards.last().locator('small')).toHaveText('');
  await expect(cards.first().locator('small')).toContainText('sin confirmar');
  expect(host.sent.filter(message => message.type === 'send')).toHaveLength(2);
});
