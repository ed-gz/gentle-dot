import { expect, test, openRecoveryHarness, type Page } from './fixtures.ts';

const LABEL = 'Generar minuta con la laptop';

async function createWork(page: Page, kind: 'meeting' | 'task', title = 'Reunión de operaciones') {
  await page.goto('/');
  await openRecoveryHarness(page);
  await page.getByText('Crear un trabajo manualmente', { exact: true }).click();
  await page.locator('#work-title').fill(title);
  await page.locator('#work-kind').selectOption(kind);
  await page.locator('#work-instruction').fill('Preparar una minuta con acuerdos y evidencia.');
  await page.locator('#work-form').getByRole('button', { name: 'Guardar en este iPhone' }).click();
  await expect(page.locator('#work-list .work-item')).toHaveCount(1);
}

test('the minute action appears for a meeting and not for a plain request', async ({ page }) => {
  await createWork(page, 'meeting');
  const draft = page.locator('#work-list .work-item').first().getByRole('button', { name: LABEL });
  await expect(draft).toBeVisible();
  // Without a connected laptop that announces meeting drafts it must be inert.
  await expect(draft).toBeDisabled();
  await expect(page.locator('#work-list .work-item').first()).toContainText('Conecta la laptop');
});

test('a task never offers to generate a meeting minute', async ({ page }) => {
  await createWork(page, 'task', 'Pedir un informe');
  await expect(page.locator('#work-list .work-item').first().getByRole('button', { name: LABEL })).toHaveCount(0);
});

test('a connected laptop that announces meeting drafts enables the action and asks approval first', async ({ page }) => {
  const operations: string[] = [];
  await page.addInitScript(() => {
    const state = globalThis as any;
    state.isTauri = true;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('secret_get')) {
        const key = `fixture-keychain:${args.request.scope}:${args.request.account}`;
        const value = sessionStorage.getItem(key);
        return value === null ? { ok: true } : { ok: true, value };
      }
      if (command.endsWith('secret_set')) {
        sessionStorage.setItem(`fixture-keychain:${args.request.scope}:${args.request.account}`, args.request.value);
        return { ok: true, persisted: true };
      }
      if (command.endsWith('check_availability')) return { available: false, status: 'model_not_ready', supportsSpanish: false };
      if (command.endsWith('share_list') || command.endsWith('documents_list') || command.endsWith('results_list')) return { ok: true, items: [] };
      return { ok: true };
    } };
  });
  await page.routeWebSocket('wss://minutes.example/ws', ws => {
    let seq = 0;
    ws.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello') ws.send(JSON.stringify({ seq: seq++, type: 'ready', agentState: 'idle', conversationId: 'main', features: { conversations: false, workSync: 1, meetingDrafts: 1, workSyncAudioBytes: 1 << 20, workSyncAttachmentBytes: 1 << 20 } }));
      if (message.type === 'get_history') ws.send(JSON.stringify({ seq: seq++, type: 'history', conversationId: 'main', messages: [] }));
      if (message.type === 'work_sync') {
        operations.push(message.operation);
        if (message.operation === 'commit') ws.send(JSON.stringify({ seq: seq++, type: 'work_sync_reply', requestId: message.requestId, transferId: message.transferId, state: 'committed', receipt: { transferId: message.transferId, workId: message.workId, revision: message.revision, manifestHash: message.manifestHash, committedAt: 1 } }));
        else ws.send(JSON.stringify({ seq: seq++, type: 'work_sync_reply', requestId: message.requestId, transferId: message.transferId, state: 'uploading', manifestHash: message.manifestHash, offsets: {} }));
      }
    });
  });
  await page.goto('/');
  await page.locator('[data-panel="settings"]').click();
  if (!await page.locator('#url').isVisible()) await page.getByText('Conexión manual', { exact: true }).click();
  await page.locator('#url').fill('wss://minutes.example/ws');
  await page.locator('#token').fill('fixture-only');
  await page.locator('#connection button[type="submit"]').click();
  await expect(page.locator('#status')).toContainText('Vinculado a Gentle Dot', { timeout: 20000 });
  await createWork(page, 'meeting');
  const draft = page.locator('#work-list .work-item').first().getByRole('button', { name: LABEL });
  await expect(draft).toBeEnabled();
  await draft.click();
  // Nothing reaches the host before the human reviews the exact transfer.
  expect(operations).toEqual([]);
  await expect(page.locator('#work-status')).toContainText('Pidiendo la minuta');
  // The review card is mounted through the conversation view, never by the tray.
  await expect(page.getByRole('button', { name: 'Aprobar esta operación' })).toBeVisible({ timeout: 15000 });
});
test('a transfer in flight keeps the action disabled across a reload', async ({ page }) => {

  await createWork(page, 'meeting');
  // Durable state, exactly what the tools write while bytes are moving.
  await page.evaluate(async () => {
    const store = await import('/src/work-inbox.ts' as string);
    const [item] = await store.listWork();
    // Exactly the states the real transfer path writes while bytes are moving.
    const prepared = await store.transitionWork(item.id, item.revision, 'prepared');
    const approved = await store.transitionWork(prepared.id, prepared.revision, 'approved');
    // The exact transfer the real path writes while bytes are moving.
    const transfer = await (await import('/src/work-sync.ts' as string)).prepareWorkTransfer(approved, 'https://laptop.example');
    await store.beginWorkTransfer(approved.id, approved.revision, transfer);
  });
  await page.reload();
  await openRecoveryHarness(page);
  const draft = page.locator('#work-list .work-item').first().getByRole('button', { name: LABEL });
  await expect(draft).toBeDisabled();
  await expect(page.locator('#work-list .work-item').first()).toContainText('sigue en curso');
});
