import { expect, test } from '@playwright/test';

for (const supported of [false, true]) test(`${supported ? 'capable host confirms exact work transfer' : 'legacy host keeps work local without approval or work frames'} while ordinary chat remains available`, async ({ page }) => {
  const requests: any[] = [];
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true; state.nativePrompts = []; let step = 0;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('agent_step')) {
        state.nativePrompts.push(args.prompt); step++;
        const decision = step === 1 ? { kind: 'tool', text: '', toolName: 'tool_describe', argumentsJSON: JSON.stringify({ name: 'work_sync' }) }
          : step === 2 ? { kind: 'tool', text: '', toolName: 'work_sync', argumentsJSON: JSON.stringify({ id: state.testWork, revision: 1 }) }
          : { kind: 'answer', text: 'Consulta el resultado de la operación en esta conversación.', toolName: '', argumentsJSON: '{}' };
        return { ok: true, decision };
      }
      return { ok: true };
    } };
  });
  await page.routeWebSocket('wss://capability.example/ws', ws => {
    let seq = 0, manifest: any, manifestHash = ''; const offsets: Record<string, number> = {};
    const send = (data: object) => ws.send(JSON.stringify({ seq: ++seq, ...data }));
    ws.onMessage(raw => {
      const request = JSON.parse(String(raw)); requests.push(request);
      if (request.type === 'hello') send({ type: 'ready', agentState: 'idle', conversationId: 'session-1', features: { conversations: false, historyRefresh: true, ...(supported ? { workSync: 1, meetingDrafts: 1 } : {}) } });
      if (request.type === 'get_history') send({ type: 'history', messages: [] });
      if (request.type === 'work_sync') {
        if (!supported) { send({ type: 'error', code: 'bad_message', message: 'Unsupported by legacy host' }); return; }
        if (request.operation === 'begin') { manifest = request.manifest; manifestHash = request.manifestHash; for (const file of manifest.files) offsets[file.id] = 0; }
        if (request.operation === 'chunk') offsets[request.fileId] += Buffer.from(request.data, 'base64').length;
        const base = { type: 'work_sync_reply', requestId: request.requestId, transferId: request.transferId };
        if (request.operation === 'commit') send({ ...base, state: 'committed', receipt: { transferId: request.transferId, workId: manifest.workId, revision: manifest.revision, manifestHash, committedAt: 123 } });
        else send({ ...base, state: 'uploading', manifestHash, offsets });
      }
      if (request.type === 'send') {
        send({ type: 'user_message', messageId: 'ordinary-user', text: request.text });
        send({ type: 'message_done', messageId: 'ordinary-reply', text: 'Chat del host disponible.' });
      }
    });
  });
  const started = Date.now();
  await page.goto('/'); await expect(page.locator('#send')).toBeEnabled({ timeout: 15000 });
  await test.info().attach('startup-ready', { body: JSON.stringify({ milliseconds: Date.now() - started }), contentType: 'application/json' });
  await page.evaluate(async () => {
    const { createWork } = await import('/src/work-inbox.ts');
    const item = await createWork({ title: 'Material local', kind: 'meeting', instruction: 'Conservar evidencia exacta.', files: [new File(['audio-original'], 'meeting.m4a', { type: 'audio/mp4' })] });
    (globalThis as any).testWork = item.id;
  });
  await page.locator('[data-panel="settings"]').click(); await page.getByText('Conexión manual', { exact: true }).click();
  await page.locator('#url').fill('wss://capability.example/ws'); await page.locator('#token').fill('fixture-only'); await page.locator('#connection button[type="submit"]').click();
  await expect(page.locator('#status')).toHaveText('Vinculado a Gentle Dot');
  await page.locator('[data-panel="chat"]').click(); await page.locator('#prompt').fill('Transfiere mi trabajo a Gentle Dot.'); await page.locator('#send').click();
  if (supported) {
    const approval = page.locator('#requests .review-card'); await expect(approval).toContainText('Material local');
    expect(requests.some(request => request.type === 'work_sync')).toBe(false);
    await approval.getByRole('button', { name: 'Aprobar esta operación', exact: true }).click();
  }
  await expect(page.locator('#cards')).toContainText('Consulta el resultado de la operación');
  const work = await page.evaluate(async () => {
    const state = globalThis as any; const { readWork, readWorkFile } = await import('/src/work-inbox.ts');
    const item = await readWork(state.testWork); return { status: item.status, revision: item.revision, transfer: Boolean(item.transfer), receipt: Boolean(item.transfer?.receipt), bytes: await (await readWorkFile(item.id, item.files[0].id))!.text(), prompts: state.nativePrompts };
  });
  expect(work.bytes).toBe('audio-original');
  if (supported) {
    expect(work).toMatchObject({ status: 'sent', transfer: true, receipt: true });
    expect(requests.filter(request => request.type === 'work_sync').map(request => request.operation)).toEqual(['begin','chunk','commit']);
  } else {
    expect(work).toMatchObject({ status: 'local', revision: 1, transfer: false, receipt: false });
    expect(requests.some(request => request.type === 'work_sync')).toBe(false);
    expect(work.prompts.at(-1)).toContain('Actualiza Gentle Dot');
    await expect(page.locator('#requests .review-card')).toHaveCount(0);
  }
  await page.locator('.engine-details summary').click(); await page.locator('#engine').selectOption('gentle');
  await page.locator('#prompt').fill('Continuamos con el chat.'); await page.locator('#send').click();
  await expect(page.locator('#cards')).toContainText('Chat del host disponible.');
  await expect(page.locator('#connection-badge')).toHaveText('VINCULADO');
});
