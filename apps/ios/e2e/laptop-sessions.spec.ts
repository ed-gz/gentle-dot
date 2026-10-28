import { expect, test, type Page } from './fixtures.ts';

async function linkedPhone(page: Page) {
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true; state.sessionCalls = [];
    const sessions = ['Operaciones', 'Capri iOS'].map((label, i) => ({ paneId: `pane-${i}`, sessionId: `session-${i}`, provider: 'herdr', label, cwd: '/workspace/capri', state: i ? 'working' : 'idle', connected: true, managed: true, capabilities: { inspect: true, prompt: true, abort: true, deliveryReceipts: true, deliveryModes: ['steer', 'followUp'], attachments: { version: 1, files: true, images: true, audio: 'file' } } }));
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('results_list')) return { ok: true, items: [] };
      if (command.startsWith('plugin:device-bridge|')) args = args?.request;
      state.sessionCalls.push({ command, ...(command.endsWith('https_request') ? { body: args.body } : {}) });
      if (command.endsWith('check_availability')) return { available: false, status: 'model_not_ready', supportsSpanish: false };
      if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted', recording: false };
      if (command.endsWith('start_voice')) return { ok: true, sessionId: '12345678-1234-1234-1234-123456789012', maxDurationSeconds: 90 };
      if (command.endsWith('stop_voice') && state.holdTranscript) await new Promise(resolve => state.finishTranscript = resolve);
      if (command.endsWith('stop_voice')) return { ok: true, sessionId: args.sessionId, source: 'apple-speech-analyzer', locale: 'es-MX', durationSeconds: 2, text: 'Revisa la evidencia.', segments: [{ text: 'Revisa la evidencia.', startSeconds: 0, endSeconds: 2 }] };
      if (command.endsWith('crypto_hash_begin')) { state.hashBytes = []; return { ok: true, id: '11111111-1111-4111-8111-111111111111' }; }
      if (command.endsWith('crypto_hash_update')) { state.hashBytes.push(...Uint8Array.from(atob(args.data), c => c.charCodeAt(0))); return { ok: true }; }
      if (command.endsWith('crypto_hash_finish')) return { ok: true, hex: [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(state.hashBytes)))].map(n => n.toString(16).padStart(2, '0')).join('') };
      if (command.endsWith('session_upload_begin')) {
        state.uploadTarget = { paneId: args.paneId, sessionId: args.sessionId, name: args.name, size: args.size }; state.uploadBytes = [];
        return { ok: true, id: '22222222-2222-4222-8222-222222222222' };
      }
      if (command.endsWith('session_upload_write')) { state.uploadBytes.push(...Uint8Array.from(atob(args.data), c => c.charCodeAt(0))); return { ok: true, written: state.uploadBytes.length }; }
      if (command.endsWith('session_upload_send')) {
        const target = state.uploadTarget; state.uploadSending = true;
        if (state.holdUpload) await new Promise(resolve => state.finishUpload = resolve);
        return { ok: true, status: 200, body: JSON.stringify({ uploadId: 'u_abcdefghijklmnopqrstuv', name: target.name, size: target.size, mime: 'application/octet-stream', path: `uploads/u_abcdefghijklmnopqrstuv/${target.name}` }) };
      }
      if (command.endsWith('https_request')) {
        const body = args.body ? JSON.parse(args.body) : undefined;
        const reply = !body ? { available: true, sessions, approvals: [], policies: [], events: [] } : body.action === 'inspect' ? {
          sessionId: body.sessionId, instanceId: 'instance-1', status: 'idle', deliveries: [],
          messages: [{ id: body.before ? 'older' : 'new', role: 'assistant', content: [{ type: 'text', text: body.before ? 'Acuerdo anterior verificable.' : `Historial de ${body.sessionId}.` }], timestamp: '2026-10-28T12:00:00Z' }],
          history: { hasEarlier: !body.before, ...(body.before ? {} : { before: 'older-cursor' }) },
          metadata: { version: 1, model: { id: 'configured', name: 'Modelo configurado', provider: 'host' } },
          work: { version: 1, commands: [], agents: [], truncated: false },
        } : { ok: true };
        return { ok: true, status: 200, headers: {}, body: JSON.stringify(reply) };
      }
      return { ok: true };
    } };
  });
  await page.routeWebSocket('wss://sessions.fixture.example/ws', ws => {
    let seq = 0;
    ws.onMessage(raw => { const m = JSON.parse(String(raw));
      if (m.type === 'hello') ws.send(JSON.stringify({ type: 'ready', seq: ++seq, agentState: 'idle', conversationId: 'main' }));
      if (m.type === 'get_history') ws.send(JSON.stringify({ type: 'history', seq: ++seq, conversationId: 'main', messages: Array.from({ length: 100 }, (_, i) => ({ id: `main-${i}`, role: i % 2 ? 'assistant' : 'user', text: `Turno ${i}`, activities: [] })) }));
    });
  });
  await connectPhone(page);
}

async function connectPhone(page: Page) {
  await page.goto('/'); await page.locator('[data-panel="settings"]').click();
  await page.getByText('Conexión manual', { exact: true }).click();
  await page.locator('#url').fill('wss://sessions.fixture.example/ws'); await page.locator('#token').fill('fixture-only');
  await page.locator('#connection button[type="submit"]').click();
  await expect(page.locator('#status')).toHaveText('Vinculado a Gentle Dot');
}

async function selectSessionFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await expect(page.locator('.agent-reply input[type="file"]')).toBeEnabled();
  const selecting = page.waitForEvent('filechooser');
  await page.locator('.agent-reply .composer-attach').click();
  await (await selecting).setFiles(file);
}

test('main history and individual Herdr sessions are directly visible with earlier pages and separate drafts', async ({ page }) => {
  await linkedPhone(page);
  await page.locator('[data-panel="chat"]').click(); await expect(page.locator('#cards .chat-card')).toHaveCount(100);
  await page.locator('[data-panel="agents"]').click(); await expect(page.locator('.agent-session')).toHaveCount(2);
  // A missing/unprepared character must not put its placeholder over sessions.
  await expect(page.locator('#rig-handle')).toBeHidden();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await expect(page.getByText('Historial de session-0.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Ver mensajes anteriores' }).click();
  await expect(page.getByText('Acuerdo anterior verificable.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Continuar esta sesión' }).fill('Borrador para operaciones');
  await page.getByRole('button', { name: 'Todos los agentes' }).click();
  await page.locator('.agent-session').filter({ hasText: 'Capri iOS' }).click();
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('');
  await expect(page.getByText('Historial de session-1.', { exact: true })).toBeVisible();
  const boxes = await page.locator('.agent-reply').boundingBox(); expect(boxes!.y + boxes!.height).toBeLessThanOrEqual(844);
  await page.getByRole('button', { name: 'Todos los agentes' }).click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('Borrador para operaciones');
  expect(await page.evaluate(() => (globalThis as any).sessionCalls.filter((c: any) => c.body && JSON.parse(c.body).action !== 'inspect'))).toEqual([]);
  for (const viewport of [{ width: 375, height: 667 }, { width: 667, height: 375 }]) {
    await page.setViewportSize(viewport); await page.evaluate(() => document.documentElement.style.fontSize = '200%');
    await expect.poll(async () => page.locator('.agent-reply').evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(viewport.height);
    expect(await page.locator('.agent-detail-scroll').evaluate(el => el.clientHeight)).toBeGreaterThan(30);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const line = await page.locator('.agent-reply textarea').evaluate(el => { const css = getComputedStyle(el); return { available: el.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom), needed: parseFloat(css.lineHeight) }; });
    expect(line.available).toBeGreaterThanOrEqual(line.needed - 1);
  }
});

test('session dictation uses Apple and leaves a reviewable draft without desktop transcription', async ({ page }) => {
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.getByRole('button', { name: /Dictar mensaje/ }).click();
  await page.getByRole('button', { name: /Terminar y revisar/ }).click();
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('Revisa la evidencia.');
  const commands = await page.evaluate(() => (globalThis as any).sessionCalls.map((c: any) => c.command));
  expect(commands.some((c: string) => c.endsWith('stop_voice'))).toBe(true);
  expect(commands.some((c: string) => /voice_native|voice_transcribe|native_voice/.test(c))).toBe(false);
});


test('leaving a session discards its late dictation instead of inserting it into the next session', async ({ page }) => {
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.evaluate(() => (globalThis as any).holdTranscript = true);
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await page.getByRole('button', { name: 'Terminar y revisar' }).click();
  await page.getByRole('button', { name: 'Todos los agentes' }).click();
  await page.locator('.agent-session').filter({ hasText: 'Capri iOS' }).click();
  await page.evaluate(() => (globalThis as any).finishTranscript());
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('');
  expect(await page.evaluate(() => (globalThis as any).sessionCalls.some((c: any) => c.command.endsWith('cancel_voice')))).toBe(true);
});


test('a human session instruction uses a secure UUID even without WKWebView randomUUID', async ({ page }) => {
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.evaluate(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }));
  await page.getByRole('textbox', { name: 'Continuar esta sesión' }).fill('Revisa esta evidencia.');
  await page.getByRole('button', { name: 'Enviar instrucción' }).click();
  await expect.poll(async () => page.evaluate(() => (globalThis as any).sessionCalls.filter((c: any) => c.body && JSON.parse(c.body).action === 'prompt').length)).toBe(1);
  const sent = await page.evaluate(() => JSON.parse((globalThis as any).sessionCalls.find((c: any) => c.body && JSON.parse(c.body).action === 'prompt').body));
  expect(sent).toMatchObject({ paneId: 'pane-0', sessionId: 'session-0', text: 'Revisa esta evidencia.' });
  expect(sent.clientMessageId).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('');
});

test('selected files stay local until Send and only a verified native upload becomes a session attachment', async ({ page }) => {
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  const bytes = Buffer.from([0, 255, 17, 128, 42]);
  await selectSessionFile(page, { name: 'evidence.bin', mimeType: 'application/octet-stream', buffer: bytes });
  await expect(page.locator('.agent-reply')).toContainText('evidence.bin');
  expect(await page.evaluate(() => (globalThis as any).sessionCalls.some((c: any) => c.command.startsWith('plugin:device-bridge|session_upload_')))).toBe(false);
  await page.getByRole('textbox', { name: 'Continuar esta sesión' }).fill('Revisa este archivo.');
  await page.getByRole('button', { name: 'Enviar instrucción', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).sessionCalls.filter((c: any) => c.body && JSON.parse(c.body).action === 'prompt').length)).toBe(1);
  const result = await page.evaluate(() => { const s = globalThis as any; return { target: s.uploadTarget, bytes: s.uploadBytes, sent: JSON.parse(s.sessionCalls.find((c: any) => c.body && JSON.parse(c.body).action === 'prompt').body) }; });
  expect(result.bytes).toEqual([...bytes]);
  expect(result.target).toMatchObject({ paneId: 'pane-0', sessionId: 'session-0', size: 5 });
  expect(result.sent).toMatchObject({ paneId: 'pane-0', sessionId: 'session-0', text: 'Revisa este archivo.', attachments: [{ uploadId: 'u_abcdefghijklmnopqrstuv', name: 'evidence.bin' }] });
});

test('leaving a session cancels its native upload and a late receipt cannot send to the next session', async ({ page }) => {
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.evaluate(() => (globalThis as any).holdUpload = true);
  await selectSessionFile(page, { name: 'private.txt', mimeType: 'text/plain', buffer: Buffer.from('original') });
  await page.getByRole('textbox', { name: 'Continuar esta sesión' }).fill('Sólo para Operaciones.');
  await page.getByRole('button', { name: 'Enviar instrucción', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).uploadSending)).toBe(true);
  await page.getByRole('button', { name: 'Todos los agentes' }).click();
  await page.locator('.agent-session').filter({ hasText: 'Capri iOS' }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).sessionCalls.some((c: any) => c.command.endsWith('session_upload_cancel')))).toBe(true);
  await page.evaluate(() => (globalThis as any).finishUpload());
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('');
  expect(await page.evaluate(() => (globalThis as any).sessionCalls.some((c: any) => c.body && JSON.parse(c.body).action === 'prompt'))).toBe(false);
  await page.getByRole('button', { name: 'Todos los agentes' }).click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await expect(page.locator('.agent-reply')).toContainText('private.txt');
});

test('working sessions keep the full action row visible with attachments and large landscape text', async ({ page }) => {
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Capri iOS' }).click();
  await selectSessionFile(page, { name: 'follow-up.txt', mimeType: 'text/plain', buffer: Buffer.from('Revisa al terminar.') });
  await expect(page.locator('.agent-reply')).toContainText('Adjuntos guardados');
  await page.setViewportSize({ width: 667, height: 375 });
  await page.evaluate(() => document.documentElement.style.fontSize = '200%');
  await expect(page.locator('.agent-detail-scroll .session-working')).toHaveCount(1);
  await expect(page.getByRole('img', { name: 'Trabajando', exact: true })).toBeVisible();
  for (const name of ['Todos los agentes', 'Enviar instrucción', 'Quitar follow-up.txt']) {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(375);
  }
  expect(await page.locator('.agent-detail-scroll').evaluate(el => el.clientHeight)).toBeGreaterThanOrEqual(64);
  expect(await page.evaluate(() => (globalThis as any).sessionCalls.some((c: any) => c.body && JSON.parse(c.body).action === 'prompt'))).toBe(false);
});

test('attachments restore only into their owning session after restart, and accepted delivery clears the local draft', async ({ page }) => {
  // Two complete app starts plus portrait/landscape checks; individual assertions keep their 5s deadline.
  test.setTimeout(60_000);
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await expect(page.locator('.agent-reply input[type="file"]')).toBeEnabled();
  const clip = page.locator('.agent-reply .composer-attach');
  const target = await clip.boundingBox();
  expect(target!.width).toBeGreaterThanOrEqual(44); expect(target!.height).toBeGreaterThanOrEqual(44);
  const nativeInput = await page.locator('.agent-reply input[type="file"]').boundingBox();
  expect(nativeInput!.height).toBeLessThanOrEqual(1); expect(nativeInput!.width).toBeLessThanOrEqual(1);
  await selectSessionFile(page, { name: 'recover.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 255, 19]) });
  await expect(page.locator('.agent-reply')).toContainText('Adjuntos guardados en el iPhone.');
  await connectPhone(page); await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Capri iOS' }).click();
  await expect(page.locator('.agent-reply input[type="file"]')).toBeEnabled();
  await expect(page.locator('.agent-reply .attachment-chips')).toHaveCount(0);
  await page.getByRole('button', { name: 'Todos los agentes' }).click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await expect(page.locator('.agent-reply')).toContainText('recover.bin');
  await expect(page.locator('.agent-reply')).toContainText('Adjuntos recuperados. Revisa el historial.');
  for (const viewport of [{ width: 375, height: 667 }, { width: 667, height: 375 }]) {
    await page.setViewportSize(viewport); await page.evaluate(() => document.documentElement.style.fontSize = '200%');
    await expect.poll(async () => page.locator('.agent-reply').evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await expect(page.getByRole('button', { name: 'Enviar instrucción', exact: true })).toBeInViewport();
    const send = await page.getByRole('button', { name: 'Enviar instrucción', exact: true }).boundingBox();
    expect(send!.y + send!.height).toBeLessThanOrEqual(viewport.height);
    await expect(clip).toBeInViewport();
    const removal = await page.getByRole('button', { name: 'Quitar recover.bin' }).boundingBox();
    const list = await page.locator('.agent-reply .attachment-chips').boundingBox();
    expect(removal!.height).toBeGreaterThanOrEqual(44);
    expect(removal!.y + removal!.height).toBeLessThanOrEqual(list!.y + list!.height);
    expect(await page.locator('.agent-detail-scroll').evaluate(el => el.clientHeight)).toBeGreaterThan(30);
    if (viewport.width > viewport.height) {
      const note = await page.locator('.agent-reply .voice-status').evaluate(el => ({ visible: el.clientHeight, text: el.scrollHeight }));
      expect(note.visible).toBeGreaterThanOrEqual(note.text);
    }
  }
  await page.screenshot({ path: '.cache/capri-phase2-qa/session-files-landscape-large-text.png' });
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => document.documentElement.style.fontSize = '');
  expect(await page.evaluate(() => (globalThis as any).sessionCalls.some((c: any) => c.command.endsWith('session_upload_begin')))).toBe(false);
  await page.getByRole('button', { name: 'Enviar instrucción', exact: true }).click();
  await expect(page.locator('.agent-reply .attachment-chips')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as any).uploadBytes)).toEqual([0, 255, 19]);
  expect(await page.evaluate(async () => {
    const path = '/src/session-attachment-drafts.ts';
    const { sessionAttachmentDraft } = await import(path);
    return (await sessionAttachmentDraft('wss://sessions.fixture.example/ws', 'pane-0', 'session-0').load()).length;
  })).toBe(0);
});
