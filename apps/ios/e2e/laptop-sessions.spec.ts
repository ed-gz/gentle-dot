import { expect, test, type Page } from './fixtures.ts';

async function linkedPhone(page: Page) {
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true; state.sessionCalls = [];
    const sessions = ['Operaciones', 'Capri iOS'].map((label, i) => ({ paneId: `pane-${i}`, sessionId: `session-${i}`, provider: 'herdr', label, cwd: '/workspace/capri', state: i ? 'working' : 'idle', connected: true, managed: true, capabilities: { inspect: true, prompt: true, abort: true, deliveryReceipts: true, deliveryModes: ['steer', 'followUp'], attachments: { version: 1, files: true, images: true, audio: 'file' } } }));
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('results_list')) return { ok: true, items: [] };
      if (command.startsWith('plugin:device-bridge|')) args = args?.request;
      state.sessionCalls.push({ command, ...(command.endsWith('https_request') ? { body: args.body } : {}) });
      // Simulate a persistent Keychain item; success without storing the
      // pending selection would make the app correctly reject confirmation.
      if (command.endsWith('secret_get')) {
        const value = sessionStorage.getItem(`fixture-keychain:${args.scope}:${args.account}`);
        return value === null ? { ok: true } : { ok: true, value };
      }
      if (command.endsWith('secret_set')) {
        sessionStorage.setItem(`fixture-keychain:${args.scope}:${args.account}`, args.value); return { ok: true };
      }
      if (command.endsWith('check_availability')) return { available: false, status: 'model_not_ready', supportsSpanish: false };
      if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('check_voice')) return { available: !state.voiceNeedsAssets, status: state.voiceNeedsAssets ? 'assets_required' : 'available', assetsInstalled: !state.voiceNeedsAssets, microphonePermission: 'granted', recording: false };
      if (command.endsWith('prepare_voice')) { state.voiceNeedsAssets = false; return { ok: true, available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' }; }
      const retained = () => JSON.parse(sessionStorage.getItem('session-voice-fixture') || '{"record":null,"receipt":null}');
      const keep = (value: any) => sessionStorage.setItem('session-voice-fixture', JSON.stringify(value));
      const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
      const same = (a: any, b: any) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
      if (command.endsWith('inspect_retained_voice')) return { ok: true, retainedAudio: retained().record };
      if (command.endsWith('list_voice_receipts')) return { ok: true, receipts: retained().receipt ? [retained().receipt] : [] };
      if (command.endsWith('get_voice_receipt')) { const entry = retained().receipt; return { ok: true, receipt: entry?.receipt.audio.id.toLowerCase() === args.sessionId.toLowerCase() ? entry : null }; }
      if (command.endsWith('release_retained_voice')) { const current = retained(); if (!same(args.receipt, current.receipt?.receipt)) throw new Error('receipt mismatch');
        if (args.receipt.audio.destination.startsWith('session:')) { const { createSessionVoiceDrafts } = await import('/src/session-voice-drafts.ts'); state.sessionReleaseConfirmed = await createSessionVoiceDrafts().delivered(args.receipt.audio.destination, args.receipt); if (!state.sessionReleaseConfirmed) throw new Error('draft not durable'); }
        current.receipt.releaseState = 'released'; current.record = null; keep(current); return { ok: true, releaseState: 'released' }; }
      if (command.endsWith('discard_voice_receipt')) { const current = retained(); if (!same(args.receipt, current.receipt?.receipt) || current.receipt.releaseState !== 'released') throw new Error('receipt mismatch'); current.receipt = null; keep(current); return { ok: true }; }
      if (command.endsWith('discard_retained_voice')) { const current = retained(); if (!same(args.record, current.record)) throw new Error('audio mismatch'); current.record = null; keep(current); return { ok: true }; }
      if (command.endsWith('attach_retained_voice')) { const current = retained(); if (!same(args.record, current.record)) throw new Error('audio mismatch'); return { ok: true, retainedAudio: current.record, sessionId: current.record.id, ownerId: current.record.owner }; }
      if (command.endsWith('start_voice')) {
        const id = '12345678-1234-1234-1234-123456789012';
        if (!args.retainDestination) return { ok: true, sessionId: id, maxDurationSeconds: 90 };
        const current = retained(); if (current.record) throw new Error('occupied');
        current.record = { id, owner: args.ownerId, destination: args.retainDestination, locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'capturing' }; keep(current);
        return { ok: true, sessionId: id, maxDurationSeconds: 90, retainedAudio: current.record };
      }
      if (command.endsWith('stop_voice') && state.holdTranscript) await new Promise(resolve => state.finishTranscript = resolve);
      if (command.endsWith('stop_voice')) {
        const text = state.sessionTranscript ?? 'Revisa la evidencia.';
        const transcript = { sessionId: args.sessionId, source: 'apple-speech-analyzer', locale: 'es-MX', durationSeconds: 2, text, segments: [{ text, startSeconds: 0, endSeconds: 2 }] };
        const current = retained(); if (!current.record) return { ok: true, ...transcript };
        if (args.ownerId !== current.record.owner || args.retainDestination !== current.record.destination) throw new Error('owner mismatch');
        current.record = { ...current.record, state:'ready', byteCount:10, sha256:'a'.repeat(64) };
        current.receipt = { receipt: { schema:'capri-native-voice-receipt/v1', audio:current.record, transcript }, releaseState:'retained' }; keep(current);
        return { ok: true, ...transcript, retainedAudio: current.record };
      }
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
  await expect(page.locator('#status')).toContainText('Acceso guardado en Keychain');
}

async function selectSessionFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await expect(page.locator('.agent-reply input[type="file"]')).toBeEnabled();
  const selecting = page.waitForEvent('filechooser');
  await page.locator('.agent-reply .composer-attach').click();
  await (await selecting).setFiles(file);
}

test('session composer and history remain reachable as the keyboard opens and closes', async ({ page }) => {
  await linkedPhone(page);
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session[data-pane-id="pane-0"]').click();
  await expect(page.getByText('Historial de session-0.', { exact: true })).toBeVisible();
  const prompt = page.getByRole('textbox', { name: 'Continuar esta sesión' });
  const draft = 'Revisar la sesión.\n'.repeat(30);
  await prompt.fill(draft); await prompt.focus();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperties(viewport, { height: { configurable: true, value: 300 }, pageTop: { configurable: true, value: 0 }, scale: { configurable: true, value: 1 } });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'true');
  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    return { reply: rect('.agent-reply').bottom, input: rect('.agent-reply textarea').bottom, reading: rect('.agent-detail-scroll').height,
      send: rect('.agent-reply .composer-send').bottom };
  });
  expect(geometry.reply).toBeLessThanOrEqual(301);
  expect(geometry.input).toBeLessThanOrEqual(301);
  expect(geometry.send).toBeLessThanOrEqual(301);
  expect(geometry.reading).toBeGreaterThanOrEqual(40);
  await prompt.blur();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, 'height', { configurable: true, value: window.innerHeight });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'false');
  await expect(prompt).toHaveValue(draft);
  await expect(page.getByRole('button', { name: 'Todos los agentes' })).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await prompt.focus();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, 'height', { configurable: true, value: 360 });
    viewport.dispatchEvent(new Event('resize'));
  });
  const large = await prompt.evaluate(element => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    return { bottom: box.bottom, inner: element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom), line: parseFloat(style.lineHeight) };
  });
  expect(large.bottom).toBeLessThanOrEqual(361);
  expect(large.inner).toBeGreaterThanOrEqual(large.line - 1);
  expect((await page.locator('.agent-reply .composer-send').boundingBox())!.y + (await page.locator('.agent-reply .composer-send').boundingBox())!.height).toBeLessThanOrEqual(361);
});

for (const file of [
  { name: 'evidencia.txt', mimeType: 'text/plain', buffer: Buffer.from('evidencia') },
  { name: 'captura.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') },
]) test(`the session attachment ${file.name} stays reviewable without pushing Send below the keyboard`, async ({ page }) => {
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session[data-pane-id="pane-0"]').click();
  await selectSessionFile(page, file);
  await expect(page.getByRole('button', { name: `Quitar ${file.name}` })).toBeVisible();
  const prompt = page.getByRole('textbox', { name: 'Continuar esta sesión' });
  await prompt.fill('Conserva la evidencia.\n'.repeat(12)); await prompt.focus();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperties(viewport, { height: { configurable: true, value: 300 }, pageTop: { configurable: true, value: 0 }, scale: { configurable: true, value: 1 } });
    viewport.dispatchEvent(new Event('resize'));
  });
  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    return { send: rect('.agent-reply .composer-send').bottom, input: rect('.agent-reply textarea').bottom, chips: rect('.attachment-chips').bottom };
  });
  expect(geometry.send).toBeLessThanOrEqual(301);
  expect(geometry.input).toBeLessThanOrEqual(301);
  expect(geometry.chips).toBeLessThanOrEqual(301);
  await expect(page.getByRole('button', { name: `Quitar ${file.name}` })).toBeVisible();
  if (file.mimeType.startsWith('image/')) {
    const preview = page.getByRole('button', { name: `Ver ${file.name}` });
    const remove = page.getByRole('button', { name: `Quitar ${file.name}` });
    for (const control of [preview, remove]) {
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
      expect(await control.evaluate(element => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
      })).toBe(true);
    }
  }
  expect(await page.evaluate(() => (globalThis as any).sessionCalls.some((call: any) => call.body && JSON.parse(call.body).action === 'prompt'))).toBe(false);
});

test('a long Herdr terminal title does not prevent opening the other sessions', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, original = state.__TAURI_INTERNALS__.invoke;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      const reply = await original(command, args);
      if (command.endsWith('https_request') && !args.request?.body) {
        const body = JSON.parse(reply.body);
        if (Array.isArray(body.sessions)) {
          body.sessions[1].label = 'Una sesión extensa de Gentle Shell '.repeat(6);
          return { ...reply, body: JSON.stringify(body) };
        }
      }
      return reply;
    };
  });
  await page.locator('[data-panel="agents"]').click();
  await expect(page.locator('.agent-session')).toHaveCount(2);
  await page.locator('.agent-session[data-pane-id="pane-0"]').click();
  await expect(page.getByText('Historial de session-0.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Todos los agentes' }).click();
  await page.locator('.agent-session[data-pane-id="pane-1"]').click();
  await expect(page.getByText('Historial de session-1.', { exact: true })).toBeVisible();
});

test('a legacy image block keeps the session history readable and does not expose image bytes', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, original = state.__TAURI_INTERNALS__.invoke;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      const reply = await original(command, args);
      if (command.endsWith('https_request') && args.request?.body) {
        const request = JSON.parse(args.request.body);
        if (request.action === 'inspect' && request.sessionId === 'session-0' && !request.before) {
          const body = JSON.parse(reply.body);
          body.messages.unshift({ id: 'photo-user', role: 'user', content: [
            { type: 'text', text: 'Primero revisa esto' },
            { type: 'image', data: 'PRIVATE-IMAGE-FIXTURE', mimeType: 'image/png' },
            { type: 'text', text: 'y luego el registro' },
          ] });
          return { ...reply, body: JSON.stringify(body) };
        }
      }
      return reply;
    };
  });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session[data-pane-id="pane-0"]').click();
  const user = page.locator('[data-message-id="photo-user"]');
  await expect(user).toContainText('Primero revisa esto');
  await expect(user).toContainText('Imagen adjunta no disponible en esta vista');
  await expect(user).toContainText('y luego el registro');
  await expect(page.getByText('Historial de session-0.', { exact: true })).toBeVisible();
  await expect(page.locator('.agent-conversation')).not.toContainText('PRIVATE-IMAGE-FIXTURE');
  await page.getByRole('button', { name: 'Ver mensajes anteriores' }).click();
  await expect(page.getByText('Acuerdo anterior verificable.')).toBeVisible();
});

test('small phone keeps navigation and the session composer on one line', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await linkedPhone(page);
  const navigation = page.locator('.navigation');
  const buttons = navigation.locator('button');
  const navRects = await buttons.evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }));
  expect(navRects).toHaveLength(3);
  for (const rect of navRects) {
    expect(Math.abs(rect.y - navRects[0]!.y)).toBeLessThan(1);
    expect(rect.width).toBeGreaterThanOrEqual(44);
    expect(rect.height).toBeGreaterThanOrEqual(44);
    expect(rect.x + rect.width).toBeLessThanOrEqual(320);
  }
  await expect(navigation.getByText('Sesiones')).toBeVisible();
  await expect(navigation.getByText('Ajustes')).toBeVisible();
  await page.getByRole('button', { name: 'Sesiones' }).click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  const composer = page.locator('.agent-reply .composer');
  const text = composer.locator('textarea');
  const metrics = await text.evaluate(element => {
    const style = getComputedStyle(element);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    context.font = style.font;
    return { textWidth: context.measureText(element.placeholder).width,
      availableWidth: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
  });
  expect(metrics.textWidth).toBeLessThanOrEqual(metrics.availableWidth);
  const controls = await composer.locator('.composer-attach, .composer-mic, .composer-send').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { y: rect.y, width: rect.width, height: rect.height };
  }));
  expect(controls).toHaveLength(3);
  for (const control of controls) {
    expect(control.width).toBeGreaterThanOrEqual(44);
    expect(control.height).toBeGreaterThanOrEqual(44);
    expect(Math.abs(control.y - controls[0]!.y)).toBeLessThan(1);
  }
  await text.fill('Primera línea\nSegunda línea');
  await expect(text).toHaveValue('Primera línea\nSegunda línea');
});

test('compact navigation keeps the session list, chat, and settings usable at phone sizes', async ({ page }, testInfo) => {
  await linkedPhone(page);
  const navigation = page.locator('.navigation');
  await expect(navigation.getByRole('button', { name: /archivo/i })).toHaveCount(0);
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    for (const fontSize of ['100%', '200%']) {
      await page.evaluate(size => { document.documentElement.style.fontSize = size; }, fontSize);
      for (const panel of ['chat', 'agents', 'settings']) {
        await page.locator(`[data-panel="${panel}"]`).click();
        await expect(page.locator(`#panel-${panel}`)).toBeVisible();
        if (panel === 'agents') await expect(page.locator('.agent-session')).toHaveCount(2);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        for (const button of await navigation.locator('button').all()) {
          const rect = await button.boundingBox();
          expect(rect!.width).toBeGreaterThanOrEqual(44);
          expect(rect!.height).toBeGreaterThanOrEqual(44);
          expect(rect!.x).toBeGreaterThanOrEqual(0);
          expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width + 1);
        }
        if (fontSize === '100%' && viewport.width === 390) {
          await page.locator(`#panel-${panel}`).evaluate(element => { element.scrollTop = 0; });
          await page.screenshot({ path: testInfo.outputPath(`compact-${panel}.png`) });
          if (panel === 'agents') {
            await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
            await expect(page.getByText('Historial de session-0.', { exact: true })).toBeVisible();
            const title = await page.locator('.agent-current-session h3').evaluate(element => ({ height: element.getBoundingClientRect().height, line: parseFloat(getComputedStyle(element).lineHeight) }));
            expect(title.height).toBeLessThanOrEqual(title.line + 1);
            await page.screenshot({ path: testInfo.outputPath('compact-session-detail.png') });
            await page.getByRole('button', { name: 'Todos los agentes' }).click();
          }
        }
        if (fontSize === '200%' && viewport.width === 320) {
          await page.screenshot({ path: testInfo.outputPath(`large-text-${panel}.png`) });
        }
      }
    }
  }
  // Removing the normal entry must not delete the stored-work view itself.
  await expect(page.locator('#panel-inbox')).toBeAttached();
  await expect(page.locator('#work-list')).toBeAttached();
});

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

test('session dictation exits recording on native interruption and preserves its draft', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = '12345678-1234-1234-1234-123456789012';
    state.voiceInterrupted = false; state.voiceStops = 0;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('check_voice') && state.voiceInterrupted) return { available: true, status: 'available', assetsInstalled: true,
        microphonePermission: 'granted', recording: false, readyToTranscribe: true, sessionId: id, previewIssue: 'Audio interrumpido.' };
      if (command.endsWith('start_voice')) { state.voiceInterrupted = true; return previous(command, args); }
      if (command.endsWith('stop_voice')) { state.voiceStops++; return { ok: false, message: 'Audio interrumpido.' }; }
      return previous(command, args);
    };
  });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  const draft = page.getByRole('textbox', { name: 'Continuar esta sesión' });
  await draft.fill('Conservado');
  await page.getByRole('button', { name: /dictar/i }).click();
  await expect(page.getByText(/Audio interrumpido/)).toBeVisible();
  await expect(draft).toHaveValue('Conservado');
  expect(await page.evaluate(() => (globalThis as any).voiceStops)).toBe(1);
});

test('a chat microphone cancellation does not block a separate Herdr instruction', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('cancel_voice')) return await new Promise(resolve => { state.finishChatVoiceCancellation = () => resolve({ ok: true }); });
      return previous(command, args);
    };
  });
  await page.locator('[data-panel="chat"]').click();
  await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.getByRole('textbox', { name: 'Continuar esta sesión' }).fill('Instrucción independiente');
  await expect(page.getByRole('button', { name: 'Enviar instrucción', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Enviar instrucción', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).sessionCalls.some((entry: any) => entry.body && JSON.parse(entry.body).action === 'prompt'))).toBe(true);
  await page.evaluate(() => (globalThis as any).finishChatVoiceCancellation());
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

test('a session cannot send its partial instruction while its own dictation is preparing or transcribing', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, original = state.__TAURI_INTERNALS__.invoke;
    state.holdTranscript = true;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('start_voice')) await new Promise(resolve => { state.finishStart = resolve; });
      return original(command, args);
    };
  });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  const text = page.getByRole('textbox', { name: 'Continuar esta sesión' });
  const send = page.getByRole('button', { name: 'Enviar instrucción', exact: true });
  await text.fill('Revisa también');
  await expect(send).toBeEnabled();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishStart)).toBe('function');
  await expect(send).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Dictar mensaje' })).toBeDisabled();
  await page.locator('.agent-reply form').evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(await page.evaluate(() => (globalThis as any).sessionCalls.filter((c: any) => c.body && JSON.parse(c.body).action === 'prompt'))).toHaveLength(0);
  await page.evaluate(() => (globalThis as any).finishStart());
  await page.getByRole('button', { name: 'Terminar y revisar' }).click();
  await expect(page.getByText('Transcribiendo…', { exact: true })).toBeVisible();
  await expect(send).toBeDisabled();
  for (const viewport of [{ width: 375, height: 667 }, { width: 667, height: 375 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await expect(send).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const box = await send.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  }
  await page.locator('.agent-reply form').evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(await page.evaluate(() => (globalThis as any).sessionCalls.filter((c: any) => c.body && JSON.parse(c.body).action === 'prompt'))).toHaveLength(0);
  await page.evaluate(() => (globalThis as any).finishTranscript());
  await expect(text).toHaveValue('Revisa también\nRevisa la evidencia.');
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).sessionCalls.filter((c: any) => c.body && JSON.parse(c.body).action === 'prompt').map((c: any) => JSON.parse(c.body).text))).toEqual(['Revisa también\nRevisa la evidencia.']);
});

test('a refused session microphone leaves the typed instruction available to send', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, original = state.__TAURI_INTERNALS__.invoke;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => command.endsWith('start_voice')
      ? { ok: false, error: 'microphone_denied', message: 'Activa el micrófono para Capri en Ajustes del iPhone.' }
      : original(command, args);
  });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  const input = page.getByRole('textbox', { name: 'Continuar esta sesión' });
  await input.fill('Conservar instrucción');
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await expect(page.getByText('Activa el micrófono para Capri en Ajustes del iPhone.')).toBeVisible();
  await expect(input).toHaveValue('Conservar instrucción');
  await expect(page.getByRole('button', { name: 'Enviar instrucción' })).toBeEnabled();
});

test('session dictation distinguishes voice assets downloading and incompatible configuration', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, original = state.__TAURI_INTERNALS__.invoke;
    state.voiceAssetStatus = 'assets_downloading'; state.voiceStarts = 0;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: false, status: state.voiceAssetStatus,
        assetsInstalled: false, microphonePermission: 'granted', recording: false };
      if (command.endsWith('start_voice')) state.voiceStarts++;
      return original(command, args);
    };
  });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  const mic = page.getByRole('button', { name: 'Dictar mensaje' });
  await expect(page.getByText(/Apple está preparando la voz/)).toBeVisible();
  await expect(mic).toBeEnabled();
  await mic.click();
  await expect(page.getByText(/Apple está preparando la voz/)).toBeVisible();
  await expect(mic).toBeEnabled();
  expect(await page.evaluate(() => (globalThis as any).voiceStarts)).toBe(0);
  await page.evaluate(() => (globalThis as any).voiceAssetStatus = 'unsupported_configuration');
  await mic.click();
  await expect(page.getByText('La configuración de voz en español no está disponible en este iPhone.')).toBeVisible();
  await expect(mic).toBeDisabled();
  expect(await page.evaluate(() => (globalThis as any).voiceStarts)).toBe(0);
});

test('session dictation displays provisional text without adding it to the draft', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, original = state.__TAURI_INTERNALS__.invoke;
    state.voicePreview = 'Borrador hablado'; state.previewRecording = false;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('start_voice')) state.previewRecording = true;
      if (command.endsWith('stop_voice')) state.previewRecording = false;
      if (command.endsWith('check_voice') && state.previewRecording) return { available: true, status: 'available', assetsInstalled: true,
        microphonePermission: 'granted', recording: true, sessionId: '12345678-1234-1234-1234-123456789012', partial: state.voicePreview };
      return original(command, args);
    };
  });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.getByRole('textbox', { name: 'Continuar esta sesión' }).fill('Anterior');
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await expect(page.locator('.agent-reply .voice-partial')).toHaveText('Borrador hablado');
  await page.evaluate(() => (globalThis as any).voicePreview = 'Hipótesis nueva');
  await expect(page.locator('.agent-reply .voice-partial')).toHaveText('Hipótesis nueva');
  await page.getByRole('button', { name: 'Terminar y revisar' }).click();
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('Anterior\nRevisa la evidencia.');
  expect(await page.evaluate(() => (globalThis as any).sessionCalls.filter((c: any) => c.body && JSON.parse(c.body).action === 'prompt'))).toEqual([]);
});

test('session microphone meter follows native capture level without sending audio or text', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, original = state.__TAURI_INTERNALS__.invoke;
    state.meterLevel = 0.7; state.meterRecording = false;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('start_voice')) state.meterRecording = true;
      if (command.endsWith('stop_voice')) state.meterRecording = false;
      if (command.endsWith('check_voice') && state.meterRecording) return { available: true, status: 'available', assetsInstalled: true,
        microphonePermission: 'granted', recording: true, sessionId: '12345678-1234-1234-1234-123456789012', microphoneLevel: state.meterLevel };
      return original(command, args);
    };
  });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  const meter = page.getByRole('meter', { name: 'Nivel del micrófono' });
  await expect(meter).toHaveJSProperty('value', 0.7);
  await page.evaluate(() => (globalThis as any).meterLevel = 0.2);
  await expect(meter).toHaveJSProperty('value', 0.2);
  await page.getByRole('button', { name: 'Terminar y revisar' }).click();
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('Revisa la evidencia.');
  expect(await page.evaluate(() => (globalThis as any).sessionCalls.filter((c: any) => c.body && JSON.parse(c.body).action === 'prompt'))).toEqual([]);
});

test('first session dictation prepares Apple voice after a microphone tap', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => (globalThis as any).voiceNeedsAssets = true);
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  const mic = page.getByRole('button', { name: 'Dictar mensaje' });
  await expect(mic).toBeEnabled();
  await mic.click();
  await expect(page.getByRole('button', { name: 'Terminar y revisar' })).toBeVisible();
  const commands = await page.evaluate(() => (globalThis as any).sessionCalls.map((c: any) => c.command));
  expect(commands.findIndex((c: string) => c.endsWith('prepare_voice'))).toBeLessThan(commands.findIndex((c: string) => c.endsWith('start_voice')));
  await page.getByRole('button', { name: 'Terminar y revisar' }).click();
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('Revisa la evidencia.');
});

test('a microphone permission dialog does not cancel a pending session capture', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, original = state.__TAURI_INTERNALS__.invoke;
    state.permissionActions = []; state.permissionStartOwners = []; state.permissionCancelOwners = [];
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('start_voice')) { state.permissionActions.push('start'); await new Promise<void>(resolve => { state.finishSessionPermission = resolve; }); return original(command, args); }
      if (command.endsWith('cancel_voice')) state.permissionActions.push('cancel');
      return original(command, args);
    };
  });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishSessionPermission)).toBe('function');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.evaluate(() => (globalThis as any).finishSessionPermission());
  await expect(page.getByRole('button', { name: 'Terminar y revisar' })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).permissionActions)).toEqual(['start']);
  await page.getByRole('button', { name: 'Terminar y revisar' }).click();
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('Revisa la evidencia.');
});

test('an unavailable session microphone explains the problem instead of silently disabling the control', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, original = state.__TAURI_INTERNALS__.invoke;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => command.endsWith('check_voice')
      ? { available: false, status: 'unsupported_language', assetsInstalled: false, microphonePermission: 'granted' }
      : original(command, args);
  });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await expect(page.getByRole('button', { name: 'Dictar mensaje' })).toBeDisabled();
  await expect(page.locator('.agent-reply .voice-status')).toContainText('transcripción local en español no está disponible');
});

test('a transient voice status failure can be retried from the session microphone', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, original = state.__TAURI_INTERNALS__.invoke;
    let checks = 0;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('check_voice') && ++checks === 1) throw new Error('fixture transient bridge error');
      return original(command, args);
    };
  });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await expect(page.locator('.agent-reply .voice-status')).toContainText('Toca el micrófono para reintentar');
  const mic = page.getByRole('button', { name: 'Dictar mensaje' });
  await expect(mic).toBeEnabled();
  await mic.click();
  await expect(page.getByRole('button', { name: 'Terminar y revisar' })).toBeVisible();
  await page.getByRole('button', { name: 'Terminar y revisar' }).click();
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('Revisa la evidencia.');
});

test('late permission result after leaving one session never cancels a newer capture', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, original = state.__TAURI_INTERNALS__.invoke; let starts = 0;
    state.permissionActions = []; state.permissionStartOwners = []; state.permissionCancelOwners = [];
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('start_voice')) {
        state.permissionActions.push('start');
        state.permissionStartOwners.push(args.ownerId);
        if (++starts === 1) return await new Promise(resolve => { state.finishOldPermission = resolve; });
      }
      if (command.endsWith('cancel_voice')) { state.permissionActions.push('cancel'); state.permissionCancelOwners.push(args.ownerId); }
      return original(command, args);
    };
  });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishOldPermission)).toBe('function');
  await page.getByRole('button', { name: 'Todos los agentes' }).click();
  await page.locator('.agent-session').filter({ hasText: 'Capri iOS' }).click();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await expect(page.getByRole('button', { name: 'Terminar y revisar' })).toBeVisible();
  await page.evaluate(() => (globalThis as any).finishOldPermission({ ok: false, error: 'cancelled', message: 'Cancelado.' }));
  await expect.poll(() => page.evaluate(() => (globalThis as any).permissionActions)).toEqual(['start', 'cancel', 'start', 'cancel']);
  const owners = await page.evaluate(() => ({ starts: (globalThis as any).permissionStartOwners, cancels: (globalThis as any).permissionCancelOwners }));
  expect(owners.cancels).toEqual([owners.starts[0], owners.starts[0]]);
  expect(owners.starts[1]).not.toBe(owners.starts[0]);
  await page.getByRole('button', { name: 'Terminar y revisar' }).click();
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('Revisa la evidencia.');
});


test('leaving a session retains its late dictation only for the original session', async ({ page }) => {
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.evaluate(() => (globalThis as any).holdTranscript = true);
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await page.getByRole('button', { name: 'Terminar y revisar' }).click();
  await page.getByRole('button', { name: 'Todos los agentes' }).click();
  await page.locator('.agent-session').filter({ hasText: 'Capri iOS' }).click();
  await page.evaluate(() => (globalThis as any).finishTranscript());
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('');
  expect(await page.evaluate(() => (globalThis as any).sessionCalls.some((c: any) => c.command.endsWith('cancel_voice')))).toBe(false);
  await page.getByRole('button', { name: 'Todos los agentes' }).click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await expect(page.getByText(/Hay audio guardado/)).toBeVisible();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('Revisa la evidencia.');
});

test('a preserved session recording cannot migrate to another session or chat', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = '12345678-1234-1234-1234-123456789012';
    let owner = '', pending = false, stops = 0;
    state.voiceRecoveryCancels = 0;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted',
        ...(pending ? { recoveryPending: true, ownerId: owner, sessionId: id, recoveryIssue: 'No detecté palabras. Descarta este audio y vuelve a dictar.' } : {}) };
      if (command.endsWith('start_voice')) { owner = args.ownerId; return previous(command, args); }
      if (command.endsWith('cancel_voice')) { state.voiceRecoveryCancels++; pending = false; return { ok: true }; }
      if (command.endsWith('stop_voice')) {
        if (++stops === 1) { pending = true; return { ok: false, error: 'preview_pending', sessionId: id, message: 'Audio guardado.' }; }
        pending = false; state.sessionTranscript = 'Sólo en operaciones.'; return previous(command, args);
      }
      return previous(command, args);
    };
  });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await page.getByRole('button', { name: 'Terminar y revisar' }).click();
  await expect(page.getByText('Audio guardado.')).toBeVisible();
  await page.getByRole('button', { name: 'Todos los agentes' }).click();
  await page.locator('.agent-session').filter({ hasText: 'Capri iOS' }).click();
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('');
  await expect(page.getByText(/audio pendiente en otra conversación/i)).toBeVisible();
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#prompt')).toHaveValue('');
  await expect(page.locator('#voice-status')).toContainText('otra conversación');
  expect(await page.evaluate(() => (globalThis as any).voiceRecoveryCancels)).toBe(0);
  await page.locator('[data-panel="agents"]').click();
  await page.getByRole('button', { name: 'Todos los agentes' }).click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await expect(page.getByText(/Hay audio guardado/i)).toBeVisible();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('Sólo en operaciones.');
});

test('returning to the original session while stopping reveals its eventual retry', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = '12345678-1234-1234-1234-123456789012';
    let owner = '', pending = false, busy = false, stops = 0;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted',
        ...(pending ? { recoveryPending: true, busy, ownerId: owner, sessionId: id } : {}) };
      if (command.endsWith('start_voice')) { owner = args.ownerId; return previous(command, args); }
      if (command.endsWith('stop_voice')) {
        if (++stops === 1) {
          pending = true; busy = true;
          await new Promise<void>(resolve => state.finishPendingStop = resolve);
          busy = false;
          return { ok: false, error: 'preview_pending', sessionId: id, message: 'Audio guardado.' };
        }
        pending = false; state.sessionTranscript = 'Recuperado al volver.'; return previous(command, args);
      }
      return previous(command, args);
    };
  });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await page.getByRole('button', { name: 'Terminar y revisar' }).click();
  await page.getByRole('button', { name: 'Todos los agentes' }).click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await expect(page.getByText('Terminando el audio guardado…')).toBeVisible();
  await page.evaluate(() => (globalThis as any).finishPendingStop());
  await expect(page.getByText(/Hay audio guardado/i)).toBeVisible();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('Recuperado al volver.');
});

test('a session can discard a silent recording explicitly, and a failed discard stays recoverable', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = '12345678-1234-1234-1234-123456789012';
    let owner = '', pending = false;
    state.voiceDiscardCalls = 0;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted',
        ...(pending ? { recoveryPending: true, ownerId: owner, sessionId: id, recoveryIssue: 'No detecté palabras. Descarta este audio y vuelve a dictar.' } : {}) };
      if (command.endsWith('start_voice')) { owner = args.ownerId; return previous(command, args); }
      if (command.endsWith('stop_voice')) { pending = true; return { ok: false, error: 'preview_pending', sessionId: id, message: 'No detecté palabras. Descarta este audio y vuelve a dictar.' }; }
      if (command.endsWith('cancel_voice')) {
        state.voiceDiscardCalls++;
        if (state.voiceDiscardCalls === 1) return { ok: false, message: 'No pude descartar el audio.' };
        pending = false; return { ok: true };
      }
      return previous(command, args);
    };
  });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await page.getByRole('button', { name: 'Terminar y revisar' }).click();
  await expect(page.getByText(/No detecté palabras/i)).toBeVisible();
  const discard = page.getByRole('button', { name: 'Descartar audio pendiente' });
  await expect(discard).toBeVisible();
  page.once('dialog', dialog => dialog.dismiss());
  await discard.click();
  expect(await page.evaluate(() => (globalThis as any).voiceDiscardCalls)).toBe(0);
  page.once('dialog', dialog => dialog.accept());
  await discard.click();
  await expect(page.getByText(/No pude confirmar que el micrófono se detuvo/)).toBeVisible();
  await expect(discard).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await discard.click();
  await expect(discard).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as any).voiceDiscardCalls)).toBe(2);
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await expect(page.getByRole('button', { name: 'Terminar y revisar' })).toBeVisible();
});

test('an unconfirmed session cancellation can be retried safely from the main chat', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = '12345678-1234-1234-1234-123456789012';
    state.cancelOwners = []; state.startOwners = [];
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('start_voice')) { state.startOwners.push(args.ownerId); return previous(command, args); }
      if (command.endsWith('cancel_voice')) {
        state.cancelOwners.push(args.ownerId);
        if (state.cancelOwners.length === 1) throw new Error('bridge unavailable');
        return { ok: true };
      }
      return previous(command, args);
    };
  });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await expect(page.getByRole('button', { name: 'Terminar y revisar' })).toBeVisible();
  await page.locator('[data-panel="chat"]').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).cancelOwners.length)).toBe(1);
  await page.locator('#dictate').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).cancelOwners.length)).toBe(2);
  expect(await page.evaluate(() => (globalThis as any).cancelOwners)).toEqual([
    await page.evaluate(() => (globalThis as any).startOwners[0]), await page.evaluate(() => (globalThis as any).startOwners[0]),
  ]);
  expect(await page.evaluate(() => (globalThis as any).startOwners.length)).toBe(1);
  await expect(page.locator('#dictate')).toHaveAccessibleName('Dictar');
  await expect(page.locator('#voice-status')).toContainText('otra conversación');
  await page.locator('[data-panel="agents"]').click();
  const operations = page.locator('.agent-session').filter({ hasText: 'Operaciones' });
  if (await operations.isVisible()) await operations.click();
  const discard = page.getByRole('button', { name: 'Descartar audio pendiente' });
  await expect(discard).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await discard.click();
  await expect(discard).toBeHidden();
  await page.locator('[data-panel="chat"]').click(); await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  expect(await page.evaluate(() => (globalThis as any).startOwners.length)).toBe(2);
});

test('a session shows an unconfirmed cancellation and retries its original owner', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = '12345678-1234-1234-1234-123456789012';
    state.cancelOwners = []; state.startOwners = [];
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('start_voice')) { state.startOwners.push(args.ownerId); return previous(command, args); }
      if (command.endsWith('cancel_voice')) {
        state.cancelOwners.push(args.ownerId);
        if (state.cancelOwners.length === 1) throw new Error('bridge unavailable');
        return { ok: true };
      }
      return previous(command, args);
    };
  });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await page.getByRole('button', { name: 'Cancelar grabación' }).click();
  await expect(page.getByText(/No pude confirmar que el micrófono se detuvo/)).toBeVisible();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await expect(page.getByText('Micrófono detenido. Toca de nuevo para dictar.')).toBeVisible();
  const { cancelOwners, startOwners } = await page.evaluate(() => ({ cancelOwners: (globalThis as any).cancelOwners, startOwners: (globalThis as any).startOwners }));
  expect(cancelOwners).toEqual([startOwners[0], startOwners[0]]);
  expect(startOwners).toHaveLength(1);
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

test('a session draft persists through reload and remains isolated from another session', async ({ page }) => {
  await linkedPhone(page);
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  const input = page.getByRole('textbox', { name: 'Continuar esta sesión' });
  await input.fill('Borrador privado en operaciones');
  await expect.poll(async () => page.evaluate(async () => {
    const { sessionVoiceOrigin } = await import('/src/voice-origin.ts');
    const { createSessionVoiceDrafts } = await import('/src/session-voice-drafts.ts');
    return (await createSessionVoiceDrafts().read(await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-0','session-0'])))).text;
  })).toBe('Borrador privado en operaciones');
  await page.reload(); await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Capri iOS' }).click();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'Todos los agentes' }).click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await expect(input).toHaveValue('Borrador privado en operaciones');
});

test('two windows cannot overwrite a newer session draft', async ({ page, context }) => {
  const other = await context.newPage();
  await linkedPhone(page); await linkedPhone(other);
  for (const tab of [page, other]) { await tab.locator('[data-panel="agents"]').click(); await tab.locator('.agent-session').filter({ hasText: 'Operaciones' }).click(); }
  const one = page.getByRole('textbox', { name: 'Continuar esta sesión' }); const two = other.getByRole('textbox', { name: 'Continuar esta sesión' });
  await one.fill('Primera ventana');
  await expect.poll(async () => page.evaluate(async () => { const {sessionVoiceOrigin}=await import('/src/voice-origin.ts'); const {createSessionVoiceDrafts}=await import('/src/session-voice-drafts.ts'); return (await createSessionVoiceDrafts().read(await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-0','session-0'])))).text; })).toBe('Primera ventana');
  await two.fill('Otra ventana');
  await expect(other.getByRole('alert')).toContainText('No se confirmó el borrador');
  await expect(two).toHaveValue('Otra ventana');
  await expect(other.getByRole('textbox', { name: 'Borrador sin confirmar' })).toHaveValue('Otra ventana');
  await expect(one).toHaveValue('Primera ventana');
});

test('retained session dictation commits its draft before audio release and survives reload', async ({ page }) => {
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  const input = page.getByRole('textbox', { name: 'Continuar esta sesión' });
  await input.fill('Texto anterior');
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await page.getByRole('button', { name: 'Terminar y revisar' }).click();
  await expect(input).toHaveValue('Texto anterior\nRevisa la evidencia.');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture') || '{}').record)).toBeNull();
  expect(await page.evaluate(() => (globalThis as any).sessionReleaseConfirmed)).toBe(true);
  await page.reload(); await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await expect(input).toHaveValue('Texto anterior\nRevisa la evidencia.');
  expect(await page.evaluate(() => (globalThis as any).sessionCalls.filter((call: any) => call.body && JSON.parse(call.body).action === 'prompt'))).toEqual([]);
});

test('an oversized session dictation remains selectable and retained across restart', async ({ page }) => {
  await linkedPhone(page); await page.evaluate(() => { (globalThis as any).sessionTranscript = 'L'.repeat(12000); });
  await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  const input = page.getByRole('textbox', { name: 'Continuar esta sesión' }); await input.fill('Antes');
  await page.getByRole('button', { name: 'Dictar mensaje' }).click(); await page.getByRole('button', { name: 'Terminar y revisar' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'No se confirmó el dictado' })).toBeVisible();
  await page.getByText('Ver dictado').click();
  await expect(page.getByText('L'.repeat(12000), { exact: true })).toBeVisible();
  await expect(input).toHaveValue('Antes');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).receipt.releaseState)).toBe('retained');
  await page.getByRole('button', { name: 'Revisar después' }).click();
  await page.reload(); await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await expect(page.getByText(/Hay audio guardado/)).toBeVisible();
  await expect(input).toHaveValue('Antes');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).receipt.receipt.transcript.text.length)).toBe(12000);
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'No se confirmó el dictado' })).toBeVisible();
  await page.getByText('Ver dictado').click();
  await expect(page.getByText('L'.repeat(12000), { exact: true })).toBeVisible();
});

test('a late session transcript cannot enter another session and remains recoverable by its owner', async ({ page }) => {
  await linkedPhone(page); await page.evaluate(() => { (globalThis as any).holdTranscript = true; });
  await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click(); await page.getByRole('button', { name: 'Terminar y revisar' }).click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishTranscript)).toBe('function');
  await page.getByRole('button', { name: 'Todos los agentes' }).click(); await page.locator('.agent-session').filter({ hasText: 'Capri iOS' }).click();
  await page.evaluate(() => { (globalThis as any).holdTranscript = false; (globalThis as any).finishTranscript(); });
  const input = page.getByRole('textbox', { name: 'Continuar esta sesión' }); await expect(input).toHaveValue('');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture') || '{}').receipt?.receipt?.transcript?.text)).toBe('Revisa la evidencia.');
  await page.getByRole('button', { name: 'Todos los agentes' }).click(); await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await expect(page.getByText(/Hay audio guardado/)).toBeVisible();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click(); await expect(input).toHaveValue('Revisa la evidencia.');
});

test('changing session during a durable voice commit never writes into the new session', async ({ page }) => {
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await page.evaluate(() => {
    const g = globalThis as any, original = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (new TextDecoder().decode(bytes).includes('capri-native-voice-receipt/v1') && !g.delayedVoiceDigest) {
        g.delayedVoiceDigest = true; await new Promise<void>(resolve => { g.releaseVoiceDigest = resolve; });
      }
      return original(algorithm, data);
    };
  });
  await page.getByRole('button', { name: 'Terminar y revisar' }).click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).releaseVoiceDigest)).toBe('function');
  await page.getByRole('button', { name: 'Todos los agentes' }).click(); await page.locator('.agent-session').filter({ hasText: 'Capri iOS' }).click();
  const input = page.getByRole('textbox', { name: 'Continuar esta sesión' }); await expect(input).toHaveValue('');
  await page.evaluate(() => (globalThis as any).releaseVoiceDigest());
  await expect.poll(async () => page.evaluate(async () => { const {sessionVoiceOrigin}=await import('/src/voice-origin.ts'); const {createSessionVoiceDrafts}=await import('/src/session-voice-drafts.ts'); return (await createSessionVoiceDrafts().read(await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-0','session-0'])))).text; })).toBe('Revisa la evidencia.');
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'Todos los agentes' }).click(); await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await expect(input).toHaveValue('Revisa la evidencia.');
  await expect(page.getByText(/Hay audio guardado/)).toBeVisible();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await expect(input).toHaveValue('Revisa la evidencia.');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture') || '{}').record)).toBeNull();
});

test('switching laptop hosts keeps their session drafts separate after reload', async ({ page }) => {
  await linkedPhone(page);
  await page.routeWebSocket('wss://other.fixture.example/ws', ws => { let seq = 0; ws.onMessage(raw => { const m = JSON.parse(String(raw)); if (m.type === 'hello') ws.send(JSON.stringify({ type:'ready', seq:++seq, agentState:'idle', conversationId:'main' })); if (m.type === 'get_history') ws.send(JSON.stringify({ type:'history',seq:++seq,conversationId:'main',messages:[] })); }); });
  await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({ hasText:'Operaciones' }).click();
  const input = page.getByRole('textbox', { name:'Continuar esta sesión' }); await input.fill('Sólo la primera laptop');
  await expect.poll(async () => page.evaluate(async () => { const {sessionVoiceOrigin}=await import('/src/voice-origin.ts'); const {createSessionVoiceDrafts}=await import('/src/session-voice-drafts.ts'); return (await createSessionVoiceDrafts().read(await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-0','session-0'])))).text; })).toBe('Sólo la primera laptop');
  await page.locator('[data-panel="settings"]').click();
  if (!await page.locator('#url').isVisible()) await page.getByText('Conexión manual', {exact:true}).click();
  await page.locator('#url').fill('wss://other.fixture.example/ws'); await page.locator('#token').fill('fixture-other'); await page.locator('#connection button[type="submit"]').click();
  await expect(page.locator('#status')).toContainText('Acceso guardado');
  await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({ hasText:'Operaciones' }).click(); await expect(input).toHaveValue('');
  await input.fill('Sólo la segunda laptop');
  await expect.poll(async () => page.evaluate(async () => { const {sessionVoiceOrigin}=await import('/src/voice-origin.ts'); const {createSessionVoiceDrafts}=await import('/src/session-voice-drafts.ts'); return (await createSessionVoiceDrafts().read(await sessionVoiceOrigin(JSON.stringify(['wss://other.fixture.example/ws','pane-0','session-0'])))).text; })).toBe('Sólo la segunda laptop');
  await page.reload(); await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({ hasText:'Operaciones' }).click(); await expect(input).toHaveValue('Sólo la segunda laptop');
});

test('a late session draft read cannot overwrite the newly selected session', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(async () => {
    const {sessionVoiceOrigin}=await import('/src/voice-origin.ts'); const {createSessionVoiceDrafts}=await import('/src/session-voice-drafts.ts');
    const dest=await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-0','session-0'])); const store=createSessionVoiceDrafts(); await store.save(dest,await store.read(dest),'Borrador de operaciones');
    const g=globalThis as any, original=crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest=async (algorithm: AlgorithmIdentifier,data: BufferSource) => {
      const bytes=data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
      if (new TextDecoder().decode(bytes).includes('pane-0') && !g.delayedSessionHash) { g.delayedSessionHash=true; await new Promise<void>(resolve=>{g.releaseSessionHash=resolve;}); }
      return original(algorithm,data);
    };
  });
  await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).releaseSessionHash)).toBe('function');
  await page.getByRole('button',{name:'Todos los agentes'}).click(); await page.locator('.agent-session').filter({hasText:'Capri iOS'}).click();
  const input=page.getByRole('textbox',{name:'Continuar esta sesión'}); await expect(input).toHaveValue('');
  await page.evaluate(() => (globalThis as any).releaseSessionHash()); await expect(input).toHaveValue('');
  await page.getByRole('button',{name:'Todos los agentes'}).click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  await expect(input).toHaveValue('Borrador de operaciones');
});

test('a session voice commit failure retains audio and retries without duplicating the draft', async ({ page }) => {
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  const input = page.getByRole('textbox', {name:'Continuar esta sesión'}); await input.fill('Base');
  await page.getByRole('button', {name:'Dictar mensaje'}).click();
  await page.evaluate(() => { const g=globalThis as any, original=IDBObjectStore.prototype.put; g.restoreVoicePut=()=>{IDBObjectStore.prototype.put=original;}; IDBObjectStore.prototype.put=function(value:any,key?:IDBValidKey) { if(typeof key==='string'&&key.startsWith('delivery:')) throw new DOMException('Cuota simulada','QuotaExceededError'); return Reflect.apply(original,this,key===undefined?[value]:[value,key]); }; });
  await page.getByRole('button', {name:'Terminar y revisar'}).click();
  await expect(page.getByRole('alert').filter({hasText:'No se confirmó el dictado'})).toBeVisible(); await expect(input).toHaveValue('Base');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).receipt.releaseState)).toBe('retained');
  await page.evaluate(() => (globalThis as any).restoreVoicePut()); await page.getByRole('button', {name:'Reintentar',exact:true}).click();
  await expect(input).toHaveValue('Base\nRevisa la evidencia.');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).record)).toBeNull();
  await page.reload(); await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  await expect(input).toHaveValue('Base\nRevisa la evidencia.');
});

test('session edits made while transcription is pending are saved before the dictation', async ({ page }) => {
  await linkedPhone(page); await page.evaluate(() => { (globalThis as any).holdTranscript = true; });
  await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  const input=page.getByRole('textbox',{name:'Continuar esta sesión'}); await input.fill('Antes');
  await page.getByRole('button',{name:'Dictar mensaje'}).click(); await page.getByRole('button',{name:'Terminar y revisar'}).click();
  await expect.poll(()=>page.evaluate(()=>typeof (globalThis as any).finishTranscript)).toBe('function');
  await input.fill('Editado durante transcripción  ');
  await page.evaluate(()=>{ (globalThis as any).holdTranscript=false; (globalThis as any).finishTranscript(); });
  await expect(input).toHaveValue('Editado durante transcripción  \nRevisa la evidencia.');
  await expect.poll(()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('session-voice-fixture')!).record)).toBeNull();
  await page.reload(); await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  await expect(input).toHaveValue('Editado durante transcripción  \nRevisa la evidencia.');
});

test('a queued second edit remains available when leaving and reopening a session', async ({ page }) => {
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  const input=page.getByRole('textbox',{name:'Continuar esta sesión'}); await expect(input).toBeEnabled();
  await page.evaluate(() => {
    const g=globalThis as any, original=IDBDatabase.prototype.transaction; let held=false;
    IDBDatabase.prototype.transaction=function(names: string|string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
      const tx=Reflect.apply(original,this,options?[names,mode,options]:mode?[names,mode]:[names]);
      if(this.name==='capri-ios-session-voice-drafts' && mode==='readwrite' && !held) {
        held=true; Object.defineProperty(tx,'oncomplete',{configurable:true,set(callback) { tx.addEventListener('complete', event => { g.releaseFirstDraftSave=()=>callback.call(tx,event); }); }});
      }
      return tx;
    };
  });
  await input.fill('Primera edición');
  await expect.poll(()=>page.evaluate(()=>typeof (globalThis as any).releaseFirstDraftSave)).toBe('function');
  await input.fill('Segunda edición');
  await page.getByRole('button',{name:'Todos los agentes'}).click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  await page.evaluate(()=>(globalThis as any).releaseFirstDraftSave());
  await expect(input).toHaveValue('Segunda edición');
  await expect(page.getByRole('alert').filter({hasText:'borrador'})).toHaveCount(0);
  await expect.poll(async () => page.evaluate(async () => { const {sessionVoiceOrigin}=await import('/src/voice-origin.ts'); const {createSessionVoiceDrafts}=await import('/src/session-voice-drafts.ts'); return (await createSessionVoiceDrafts().read(await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-0','session-0'])))).text; })).toBe('Segunda edición');
  await page.reload(); await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  await expect(input).toHaveValue('Segunda edición');
});

test('an oversized draft remains editable, can be shortened and recovered after reload', async ({ page }) => {
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  const input=page.getByRole('textbox',{name:'Continuar esta sesión'}), send=page.getByRole('button',{name:'Enviar instrucción',exact:true});
  await input.fill('X'.repeat(8001)); await expect(page.getByRole('alert').filter({hasText:'borrador'})).toBeVisible();
  await expect(input).toBeEnabled(); await expect(send).toBeDisabled(); await input.fill('X'.repeat(8000));
  await page.getByRole('button',{name:'Reintentar guardado'}).click(); await expect(page.getByRole('alert').filter({hasText:'borrador'})).toBeHidden();
  await expect(send).toBeEnabled();
  await expect.poll(async ()=>page.evaluate(async()=>{const {sessionVoiceOrigin}=await import('/src/voice-origin.ts'); const {createSessionVoiceDrafts}=await import('/src/session-voice-drafts.ts'); return (await createSessionVoiceDrafts().read(await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-0','session-0'])))).text.length;})).toBe(8000);
  await page.reload(); await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  await expect(input).toHaveValue('X'.repeat(8000));
});

test('a failed session draft write remains editable and can be retried after storage recovers', async ({ page }) => {
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  const input=page.getByRole('textbox',{name:'Continuar esta sesión'}); await input.fill('Base');
  await expect.poll(async ()=>page.evaluate(async()=>{const {sessionVoiceOrigin}=await import('/src/voice-origin.ts');const {createSessionVoiceDrafts}=await import('/src/session-voice-drafts.ts');return (await createSessionVoiceDrafts().read(await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-0','session-0'])))).text;})).toBe('Base');
  await page.evaluate(()=>{const g=globalThis as any, original=IDBObjectStore.prototype.put;g.restoreDraftPut=()=>{IDBObjectStore.prototype.put=original;};IDBObjectStore.prototype.put=function(value:any,key?:IDBValidKey){if(typeof key==='string'&&key.startsWith('draft:'))throw new DOMException('Cuota simulada','QuotaExceededError');return Reflect.apply(original,this,key===undefined?[value]:[value,key]);};});
  await input.fill('Edición sin confirmar'); await expect(page.getByRole('alert').filter({hasText:'borrador'})).toBeVisible();
  await expect(input).toBeEnabled(); await input.fill('Edición corregida');
  await page.evaluate(()=>(globalThis as any).restoreDraftPut()); await page.getByRole('button',{name:'Reintentar guardado'}).click();
  await expect(page.getByRole('alert').filter({hasText:'borrador'})).toBeHidden();
  await expect.poll(async ()=>page.evaluate(async()=>{const {sessionVoiceOrigin}=await import('/src/voice-origin.ts');const {createSessionVoiceDrafts}=await import('/src/session-voice-drafts.ts');return (await createSessionVoiceDrafts().read(await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-0','session-0'])))).text;})).toBe('Edición corregida');
  await page.reload(); await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click(); await expect(input).toHaveValue('Edición corregida');
});

test('a delayed draft write does not block a different session', async ({ page }) => {
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  const input=page.getByRole('textbox',{name:'Continuar esta sesión'}); await expect(input).toBeEnabled();
  await page.evaluate(()=>{const g=globalThis as any, original=IDBDatabase.prototype.transaction; let held=false; IDBDatabase.prototype.transaction=function(names:string|string[],mode?:IDBTransactionMode,options?:IDBTransactionOptions){const tx=Reflect.apply(original,this,options?[names,mode,options]:mode?[names,mode]:[names]);if(this.name==='capri-ios-session-voice-drafts'&&mode==='readwrite'&&!held){held=true;Object.defineProperty(tx,'oncomplete',{configurable:true,set(callback){tx.addEventListener('complete',event=>{g.releaseDelayedDraft=()=>callback.call(tx,event);});}});}return tx;};});
  await input.fill('Edición demorada'); await expect.poll(()=>page.evaluate(()=>typeof (globalThis as any).releaseDelayedDraft)).toBe('function');
  await page.getByRole('button',{name:'Todos los agentes'}).click(); await page.locator('.agent-session').filter({hasText:'Capri iOS'}).click();
  await expect(input).toBeEnabled(); await input.fill('Otra sesión libre');
  await expect.poll(async()=>page.evaluate(async()=>{const {sessionVoiceOrigin}=await import('/src/voice-origin.ts');const {createSessionVoiceDrafts}=await import('/src/session-voice-drafts.ts');return(await createSessionVoiceDrafts().read(await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-1','session-1'])))).text;})).toBe('Otra sesión libre');
  await page.evaluate(()=>(globalThis as any).releaseDelayedDraft()); await expect(input).toHaveValue('Otra sesión libre');
});

test('a lost write callback cannot hold a reopened session indefinitely', async ({ page }) => {
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  const input=page.getByRole('textbox',{name:'Continuar esta sesión'}); await expect(input).toBeEnabled(); await page.clock.install();
  await page.evaluate(()=>{const g=globalThis as any,original=IDBDatabase.prototype.transaction;let held=false;IDBDatabase.prototype.transaction=function(names:string|string[],mode?:IDBTransactionMode,options?:IDBTransactionOptions){const tx=Reflect.apply(original,this,options?[names,mode,options]:mode?[names,mode]:[names]);if(this.name==='capri-ios-session-voice-drafts'&&mode==='readwrite'&&!held){held=true;Object.defineProperty(tx,'oncomplete',{configurable:true,set(callback){tx.addEventListener('complete',event=>{g.releaseLostDraft=()=>callback.call(tx,event);});}});}return tx;};});
  await input.fill('Texto que conservar'); await expect.poll(()=>page.evaluate(()=>typeof (globalThis as any).releaseLostDraft)).toBe('function');
  await page.getByRole('button',{name:'Todos los agentes'}).click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  await page.clock.fastForward(11000);
  await expect(input).toBeEnabled(); await expect(input).toHaveValue('Texto que conservar');
  await page.reload(); await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click(); await expect(input).toHaveValue('Texto que conservar');
});

test('a timed-out draft read exposes retry without discarding the visible draft', async ({ page }) => {
  await linkedPhone(page); await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  const input=page.getByRole('textbox',{name:'Continuar esta sesión'}); await input.fill('Texto para rescatar');
  await expect.poll(async()=>page.evaluate(async()=>{const {sessionVoiceOrigin}=await import('/src/voice-origin.ts');const {createSessionVoiceDrafts}=await import('/src/session-voice-drafts.ts');return(await createSessionVoiceDrafts().read(await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-0','session-0'])))).text;})).toBe('Texto para rescatar');
  await page.getByRole('button',{name:'Todos los agentes'}).click(); await page.clock.install();
  await page.evaluate(()=>{const g=globalThis as any,original=crypto.subtle.digest.bind(crypto.subtle);g.releaseDraftHashes=[];g.restoreDraftHash=()=>{crypto.subtle.digest=original;};crypto.subtle.digest=async(algorithm:AlgorithmIdentifier,data:BufferSource)=>{const bytes=data instanceof ArrayBuffer?new Uint8Array(data):new Uint8Array(data.buffer,data.byteOffset,data.byteLength);if(new TextDecoder().decode(bytes).includes('pane-0'))await new Promise<void>(resolve=>g.releaseDraftHashes.push(resolve));return original(algorithm,data);};});
  await page.locator('.agent-session').filter({hasText:'Operaciones'}).click(); await expect.poll(()=>page.evaluate(()=>(globalThis as any).releaseDraftHashes.length)).toBeGreaterThan(0);
  await page.clock.fastForward(11000); await expect(page.getByRole('alert').filter({hasText:'borrador'})).toBeVisible();
  await expect(input).toHaveValue('Texto para rescatar'); await expect(input).toBeEnabled();
  await page.evaluate(()=>{(globalThis as any).restoreDraftHash();for(const release of (globalThis as any).releaseDraftHashes)release();});
  await page.getByRole('button',{name:'Reintentar guardado'}).click(); await expect(page.getByRole('alert').filter({hasText:'borrador'})).toBeHidden();
  await expect(input).toHaveValue('Texto para rescatar');
  await page.reload(); await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click(); await expect(input).toHaveValue('Texto para rescatar');
});
