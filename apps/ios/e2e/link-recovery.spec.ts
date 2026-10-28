import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

const endpoint = 'wss://recovery.fixture.example/ws';
type WireMessage = Record<string, unknown>;

async function fixture(page: Page, onRequest: (message: WireMessage, send: (message: WireMessage) => void, connection: number) => void) {
  let connection = 0;
  let socket: WebSocketRoute;
  let emit: (message: WireMessage) => void;
  const requests: WireMessage[] = [];
  await page.routeWebSocket(endpoint, ws => {
    let seq = 0;
    socket = ws;
    const current = ++connection;
    const send = (message: WireMessage) => ws.send(JSON.stringify({ seq: ++seq, ...message }));
    emit = send;
    ws.onMessage(raw => {
      const message = JSON.parse(String(raw));
      requests.push(message);
      if (message.type === 'hello') send({ type: 'ready', agentState: 'idle', conversationId: 'c1' });
      onRequest(message, send, current);
    });
  });
  await page.addInitScript(() => {
    const state = globalThis as any;
    state.isTauri = true;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command.endsWith('share_list')) return { ok: true, items: [] };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('agent_step')) return { ok: true, decision: { kind: 'answer', text: 'Respuesta del fixture local', toolName: '', argumentsJSON: '{}' } };
      return { ok: true };
    } };
  });
  await page.goto('/');
  return {
    requests,
    connections: () => connection,
    send: (message: WireMessage) => emit(message),
    drop: () => socket.close({ code: 1001, reason: 'Fixture connection lost' }),
  };
}

async function connect(page: Page) {
  await page.locator('[data-panel="settings"]').click();
  await page.getByText('Conexión manual', { exact: true }).click();
  await page.locator('#url').fill(endpoint);
  await page.locator('#token').fill('fixture-only');
  await page.locator('#connection button[type="submit"]').click();
  await expect(page.locator('#status')).toHaveText('Vinculado a Gentle Dot');
  await page.locator('[data-panel="chat"]').click();
  await page.locator('.engine-details summary').click();
  await page.locator('#engine').selectOption('gentle');
}

test('history aliases keep DOM chronology and coalesce tool replies around local dialogue', async ({ page }) => {
  let wireText = '';
  const link = await fixture(page, (message, send) => {
    if (message.type === 'get_history') send({ type: 'history', conversationId: 'c1', messages: wireText ? [
      { id: 'h1', role: 'user', text: wireText, activities: [] },
      { id: 'h2', role: 'assistant', text: 'Primera parte\n\nParte final', activities: [] },
    ] : [] });
    if (message.type === 'send') {
      wireText = String(message.text);
      send({ type: 'user_message', messageId: 'u1', text: wireText });
      send({ type: 'message_done', messageId: 'm2', text: 'Primera parte', intermediate: true });
      send({ type: 'message_done', messageId: 'm3', text: 'Parte final' });
    }
  });
  await connect(page);
  await page.locator('#prompt').fill('Solicitud para la laptop');
  await page.locator('#send').click();
  await expect(page.locator('.chat-text')).toHaveText(['Solicitud para la laptop', 'Primera parte', 'Parte final']);
  await page.locator('#engine').selectOption('iphone');
  await page.locator('#prompt').fill('Mi siguiente turno es local');
  await page.locator('#send').click();
  await expect(page.locator('.chat-text')).toHaveCount(5);
  await link.drop();
  await expect.poll(link.connections).toBe(2);
  await expect(page.locator('.chat-text')).toHaveText([
    'Solicitud para la laptop', 'Primera parte\n\nParte final', 'Mi siguiente turno es local', 'Respuesta del fixture local',
  ]);
  expect(link.requests.filter(message => message.type === 'send')).toHaveLength(1);
  await expect.poll(async () => page.evaluate(async () =>
    (await (await import('/src/conversation.ts' as string)).loadConversation()).entries.map((entry: any) => entry.text),
  )).toEqual(['Solicitud para la laptop', 'Primera parte\n\nParte final', 'Mi siguiente turno es local', 'Respuesta del fixture local']);
});

test('a stream interrupted by disconnect stays explicit and is never replayed during reconnect', async ({ page }) => {
  let wireText = '';
  const link = await fixture(page, (message, send) => {
    if (message.type === 'get_history') send({ type: 'history', conversationId: 'c1', messages: wireText ? [
      { id: 'h1', role: 'user', text: wireText, activities: [] },
    ] : [] });
    if (message.type === 'send') {
      wireText = String(message.text);
      send({ type: 'user_message', messageId: 'u1', text: wireText });
      send({ type: 'agent_state', state: 'thinking' });
      send({ type: 'message_delta', messageId: 'm2', delta: 'Respuesta parcial' });
    }
  });
  await connect(page);
  await page.locator('#prompt').fill('No repitas este envío');
  await page.locator('#send').click();
  await expect(page.locator('.chat-card[data-role="assistant"] small')).toHaveText('Preparando respuesta…');
  await link.drop();
  await expect(page.locator('.chat-card[data-role="assistant"] small')).toContainText('Interrumpido o sin confirmar');
  await expect.poll(link.connections).toBe(2);
  await expect(page.locator('.chat-text')).toHaveText(['No repitas este envío', 'Respuesta parcial']);
  await expect(page.locator('#send')).toBeEnabled();
  expect(link.requests.filter(message => message.type === 'send')).toHaveLength(1);
  link.send({ type: 'message_done', messageId: 'm2', text: 'Respuesta final confirmada' });
  await expect(page.locator('.chat-text')).toHaveText(['No repitas este envío', 'Respuesta final confirmada']);
  await expect(page.locator('.chat-card[data-role="assistant"] small')).toHaveText('');
});

test('history recovers an input whose echo was lost without exposing context or duplicating the request', async ({ page }) => {
  let wireText = '';
  const link = await fixture(page, (message, send) => {
    if (message.type === 'get_history') send({ type: 'history', conversationId: 'c1', messages: wireText ? [
      { id: 'h1', role: 'user', text: wireText, activities: [] },
    ] : [] });
    if (message.type === 'send') wireText = String(message.text);
  });
  await page.locator('[data-panel="chat"]').click();
  await page.locator('#prompt').fill('Contexto local antes del corte');
  await page.locator('#send').click();
  await expect(page.locator('.chat-text')).toHaveCount(2);
  await connect(page);
  await page.locator('#prompt').fill('Recupera mi solicitud');
  await page.locator('#send').click();
  await expect(page.locator('.chat-card[data-role="user"]').last().locator('small')).toContainText('Esperando confirmación');
  await link.drop();
  await expect.poll(link.connections).toBe(2);
  await expect(page.locator('.chat-text')).toHaveText([
    'Contexto local antes del corte', 'Respuesta del fixture local', 'Recupera mi solicitud',
  ]);
  await expect(page.locator('.chat-card[data-role="user"]').last().locator('small')).toHaveText('');
  expect(wireText).toContain('Contexto reciente de Capri');
  expect(link.requests.filter(message => message.type === 'send')).toHaveLength(1);
});

test('host interruption without socket closure releases the composer and marks partial output', async ({ page }) => {
  const link = await fixture(page, (message, send) => {
    if (message.type === 'get_history') send({ type: 'history', conversationId: 'c1', messages: [] });
    if (message.type === 'send') {
      send({ type: 'user_message', messageId: 'u1', text: message.text });
      send({ type: 'agent_state', state: 'thinking' });
      send({ type: 'message_delta', messageId: 'm2', delta: 'Respuesta interrumpida por el host' });
    }
  });
  await connect(page);
  await page.locator('#prompt').fill('Una respuesta que se interrumpe');
  await page.locator('#send').click();
  await expect(page.locator('.chat-card[data-role="assistant"] small')).toHaveText('Preparando respuesta…');
  link.send({ type: 'interrupted' });
  await expect(page.locator('.chat-card[data-role="assistant"] small')).toContainText('Interrumpido o sin confirmar');
  await expect(page.locator('#send')).toBeEnabled();
  expect(link.connections()).toBe(1);
});
