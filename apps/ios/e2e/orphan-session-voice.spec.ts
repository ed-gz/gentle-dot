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
        const key = `fixture-keychain:${args.scope}:${args.account}`; if (args.compare === true && sessionStorage.getItem(key) !== (args.expected ?? null)) return { ok: true, persisted: false }; sessionStorage.setItem(key, args.value); return { ok: true, persisted: true };
      }
      if (command.endsWith('check_availability')) return { available: false, status: 'model_not_ready', supportsSpanish: false };
      if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('check_voice')) { const record = JSON.parse(sessionStorage.getItem('session-voice-fixture') || '{\"record\":null}').record; return { available: !state.voiceNeedsAssets, status: state.voiceNeedsAssets ? 'assets_required' : 'available', assetsInstalled: !state.voiceNeedsAssets, microphonePermission: 'granted', recording: false, ...(state.recoveryOwner && record ? {sessionId:record.id,ownerId:state.recoveryOwner,retainedAudio:record,recoveryPending:true} : {}) }; }
      if (command.endsWith('prepare_voice')) { state.voiceNeedsAssets = false; return { ok: true, available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' }; }
      const retained = () => JSON.parse(sessionStorage.getItem('session-voice-fixture') || '{"record":null,"receipt":null}');
      const keep = (value: any) => sessionStorage.setItem('session-voice-fixture', JSON.stringify(value));
      const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
      const same = (a: any, b: any) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
      if (command.endsWith('inspect_retained_voice')) return { ok: true, retainedAudio: retained().record };
      if (command.endsWith('list_voice_receipts')) return { ok: true, receipts: retained().receipt ? [retained().receipt] : [] };
      if (command.endsWith('get_voice_receipt')) { if (state.holdReceiptRead) { await new Promise(resolve => { state.finishReceiptRead = resolve; }); state.receiptReadFinished = true; } const entry = retained().receipt; return { ok: true, receipt: entry?.receipt.audio.id.toLowerCase() === args.sessionId.toLowerCase() ? entry : null }; }
      if (command.endsWith('release_retained_voice')) { const current = retained(); if (!same(args.receipt, current.receipt?.receipt)) throw new Error('receipt mismatch');
        if (args.receipt.audio.destination.startsWith('session:')) { const { createSessionVoiceDrafts } = await import('/src/session-voice-drafts.ts'); state.sessionReleaseConfirmed = await createSessionVoiceDrafts().delivered(args.receipt.audio.destination, args.receipt); if (!state.sessionReleaseConfirmed) throw new Error('draft not durable'); }
        current.receipt.releaseState = 'released'; current.record = null; keep(current); return { ok: true, releaseState: 'released' }; }
      if (command.endsWith('discard_voice_receipt')) { const current = retained(); if (!same(args.receipt, current.receipt?.receipt) || current.receipt.releaseState !== 'released') throw new Error('receipt mismatch'); current.receipt = null; keep(current); return { ok: true }; }
      if (command.endsWith('discard_retained_voice')) { const current = retained(); if (!same(args.record, current.record)) throw new Error('audio mismatch'); current.record = null; keep(current); return { ok: true }; }
      if (command.endsWith('export_incomplete_voice')) { const current = retained(); if (!same(args.record, current.record) || current.record.state !== 'capturing') throw new Error('audio mismatch');
        state.incompleteExports = (state.incompleteExports ?? 0) + 1;
        if (state.incompleteExportMode === 'error') throw new Error('fixture error');
        return state.incompleteExportMode === 'cancel' ? { ok: true, exported: false, cancelled: true } : { ok: true, exported: true, cancelled: false }; }
      if (command.endsWith('attach_retained_voice')) { const current = retained(); state.attachCount = (state.attachCount ?? 0) + 1; if (state.recoveryOwner) return {ok:false,error:'busy'}; if (!same(args.record, current.record) || !args.ownerId || args.ownerId === current.record.owner) throw new Error('audio mismatch'); state.recoveryOwner = args.ownerId; return { ok: true, retainedAudio: current.record, sessionId: current.record.id, ownerId: args.ownerId }; }
      if (command.endsWith('cancel_voice')) { if (args.ownerId === state.recoveryOwner) state.recoveryOwner = null; return {ok:true}; }
      if (command.endsWith('start_voice')) {
        const id = '12345678-1234-1234-1234-123456789012';
        if (!args.retainDestination) return { ok: true, sessionId: id, maxDurationSeconds: 90 };
        const current = retained(); if (current.record) throw new Error('occupied');
        current.record = { id, owner: args.ownerId, destination: args.retainDestination, locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'capturing' }; keep(current);
        return { ok: true, sessionId: id, maxDurationSeconds: 90, retainedAudio: current.record };
      }
      if (command.endsWith('stop_voice') && state.holdTranscript) await new Promise(resolve => state.finishTranscript = resolve);
      if (command.endsWith('stop_voice')) {
        if (sessionStorage.getItem('fail-orphan') === '1') { sessionStorage.removeItem('fail-orphan'); return { ok: false, error: 'failed', message: 'fixture failure' }; }
        const text = state.sessionTranscript ?? 'Revisa la evidencia.';
        const transcript = { sessionId: args.sessionId, source: 'apple-speech-analyzer', locale: 'es-MX', durationSeconds: 2, text, segments: [{ text, startSeconds: 0, endSeconds: 2 }] };
        const current = retained(); if (!current.record) return { ok: true, ...transcript };
        if (args.ownerId !== current.record.owner || args.retainDestination !== current.record.destination || (state.recoveryOwner && args.operationOwnerId !== state.recoveryOwner)) throw new Error('owner mismatch');
        current.record = { ...current.record, state:'ready', byteCount:10, sha256:'a'.repeat(64) };
        current.receipt = { receipt: { schema:'capri-native-voice-receipt/v1', audio:current.record, transcript }, releaseState:'retained' }; keep(current);
        return { ok: true, ...transcript, retainedAudio: current.record };
      }
      if (command.endsWith('export_begin')) { state.exportedBytes = []; return { ok: true, id: '22222222-2222-4222-8222-222222222222' }; }
      if (command.endsWith('export_write')) { state.exportedBytes.push(...Uint8Array.from(atob(args.data), c => c.charCodeAt(0))); return { ok: true, written: state.exportedBytes.length }; }
      if (command.endsWith('export_present')) return { ok: true, exported: true, cancelled: false };
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
        const reply = !body ? { available: true, sessions: sessionStorage.getItem('missing-session') ? sessions.slice(1) : sessions, approvals: [], policies: [], events: [] } : body.action === 'inspect' ? {
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

test('a removed session leaves its complete dictation recoverable in chat without cross-session insertion', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(() => { (globalThis as any).sessionTranscript = 'L'.repeat(12000); });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await page.getByRole('button', { name: 'Terminar y revisar' }).click();
  await expect(page.getByText('Ver dictado')).toBeVisible();
  await page.getByRole('button', { name: 'Revisar después' }).click();
  await page.evaluate(() => sessionStorage.setItem('missing-session', '1'));
  await page.reload();
  await expect(page.locator('#voice-status')).toContainText('dictado guardado de otra sesión');
  await expect(page.locator('#discard-voice')).toBeHidden();
  await page.getByRole('button', { name: 'Revisar dictado' }).click();
  await page.getByText('Dictado de otra sesión').click();
  await expect(page.getByText('L'.repeat(12000), { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Añadir al mensaje' })).toBeHidden();
  await page.getByRole('button', { name: 'Exportar texto' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Texto exportado' })).toBeVisible();
  expect(await page.evaluate(() => new TextDecoder().decode(Uint8Array.from((globalThis as any).exportedBytes)))).toBe('L'.repeat(12000));
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).receipt.releaseState)).toBe('retained');
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#prompt')).toHaveValue('');
  await page.locator('[data-panel="agents"]').click();
  await expect(page.locator('.agent-session').filter({ hasText: 'Operaciones' })).toHaveCount(0);
  await page.locator('.agent-session').filter({ hasText: 'Capri iOS' }).click();
  await expect(page.getByRole('textbox', { name: 'Continuar esta sesión' })).toHaveValue('');
  expect(await page.evaluate(() => (globalThis as any).sessionCalls.filter((c: any) => c.body && JSON.parse(c.body).action === 'prompt'))).toEqual([]);
});

test('a ready orphan without receipt can be transcribed without changing destinations', async ({ page }) => {
  await linkedPhone(page);
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await expect(page.getByRole('button', { name: 'Terminar y revisar' })).toBeVisible();
  await page.locator('[data-panel="chat"]').click();
  await page.evaluate(() => {
    const saved = JSON.parse(sessionStorage.getItem('session-voice-fixture')!);
    saved.record = { ...saved.record, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) };
    sessionStorage.setItem('session-voice-fixture', JSON.stringify(saved));
    sessionStorage.setItem('missing-session', '1'); sessionStorage.setItem('fail-orphan', '1');
  });
  await page.reload();
  const recover = page.getByRole('button', { name: 'Transcribir audio de otra sesión' });
  await expect(recover).toBeVisible(); await recover.click();
  await expect(page.locator('#voice-status')).toContainText('No pude transcribir');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).record.state)).toBe('ready');
  await recover.click();
  await expect(page.getByRole('button', { name: 'Revisar dictado' })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).attachCount)).toBe(1);
  await page.getByRole('button', { name: 'Revisar dictado' }).click();
  await page.getByText('Dictado de otra sesión').click();
  await expect(page.getByText('Revisa la evidencia.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Añadir al mensaje' })).toBeHidden();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).receipt.releaseState)).toBe('retained');
  await page.locator('[data-panel="chat"]').click(); await expect(page.locator('#prompt')).toHaveValue('');
  expect(await page.evaluate(() => (globalThis as any).sessionCalls.filter((c: any) => c.body && JSON.parse(c.body).action === 'prompt'))).toEqual([]);
});

test('unfinished orphan audio can be exported and requires confirmation to discard', async ({ page }) => {
  await linkedPhone(page);
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await expect(page.getByRole('button', { name: 'Terminar y revisar' })).toBeVisible();
  await page.locator('[data-panel="chat"]').click();
  await page.evaluate(() => sessionStorage.setItem('missing-session', '1'));
  await page.setViewportSize({ width: 320, height: 568 });
  await page.reload();
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; const viewport = window.visualViewport!;
    Object.defineProperties(viewport, { height: { configurable: true, value: 360 }, pageTop: { configurable: true, value: 0 }, scale: { configurable: true, value: 1 } }); viewport.dispatchEvent(new Event('resize')); });
  await expect(page.locator('#voice-status')).toContainText('Audio incompleto de otra sesión');
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'true');
  expect(await page.locator('#composer').evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(361);
  const exportAudio = page.getByRole('button', { name: 'Exportar audio incompleto' }); await expect(exportAudio).toBeVisible();
  await page.evaluate(() => { (globalThis as any).incompleteExportMode = 'cancel'; }); await exportAudio.click();
  await expect(page.locator('#voice-status')).toHaveText('Exportación cancelada.');
  await page.evaluate(() => { (globalThis as any).incompleteExportMode = 'error'; }); await exportAudio.click();
  await expect(page.locator('#voice-status')).toContainText('No pude confirmar');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).record.state)).toBe('capturing');
  await page.evaluate(() => { (globalThis as any).incompleteExportMode = 'success'; }); await exportAudio.click();
  await expect(page.locator('#voice-status')).toContainText('Audio incompleto exportado');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).record.state)).toBe('capturing');
  const discard = page.locator('#discard-voice'); await expect(discard).toBeVisible();
  page.once('dialog', dialog => dialog.dismiss()); await discard.click();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).record.state)).toBe('capturing');
  page.once('dialog', dialog => dialog.accept()); await discard.click();
  await expect(page.locator('#voice-status')).toHaveText('Audio eliminado.');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).record)).toBeNull();
  await page.getByRole('button', { name: 'Dictar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Terminar dictado' })).toBeVisible();
});

test('orphan recovery stays keyboard reachable at large text and cancelled removal preserves audio', async ({page}) => {
 await linkedPhone(page); await page.evaluate(async () => {
  const id='ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345',owner='abcdef02-abcd-4bcd-8bcd-abcdef012345';
  const {sessionVoiceOrigin}=await import('/src/voice-origin.ts'); const destination=await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-0','session-0']));
  const audio={id,owner,destination,locale:'es-MX',kind:'speech',createdAt:1,state:'ready',byteCount:10,sha256:'a'.repeat(64)};
  const text='X'.repeat(12000),transcript={sessionId:id,text,segments:[{text,startSeconds:0,endSeconds:1}],durationSeconds:1,locale:'es-MX',source:'apple-speech-analyzer'};
  sessionStorage.setItem('session-voice-fixture',JSON.stringify({record:audio,receipt:{receipt:{schema:'capri-native-voice-receipt/v1',audio,transcript},releaseState:'retained'}})); sessionStorage.setItem('missing-session','1');
 });
 await page.setViewportSize({width:320,height:568}); await page.reload(); await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});
 const review=page.getByRole('button',{name:'Revisar dictado'}); await expect(review).toBeVisible(); await review.focus(); await page.keyboard.press('Enter');
 const summary=page.getByText('Dictado de otra sesión'); await expect(summary).toBeVisible(); await summary.focus(); await page.keyboard.press('Enter');
 await expect(page.getByText('No se añadirá a esta conversación',{exact:false})).toBeVisible();
 const exportButton=page.getByRole('button',{name:'Exportar texto'}); await exportButton.focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('status').filter({hasText:'Texto exportado'})).toBeVisible();
 const audio=page.getByRole('button',{name:'Eliminar audio'}); page.once('dialog',dialog=>dialog.dismiss()); await audio.focus(); await page.keyboard.press('Enter');
 const facts=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth, state:JSON.parse(sessionStorage.getItem('session-voice-fixture')!), sent:(globalThis as any).sessionCalls.filter((c:any)=>c.body&&JSON.parse(c.body).action==='prompt').length}));
 expect(facts.overflow).toBe(false);expect(facts.state.record.state).toBe('ready');expect(facts.state.receipt.releaseState).toBe('retained');expect(facts.sent).toBe(0);
});

test('audit ready orphan controls fit small viewport and large text without overlap', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(async () => {
    const {sessionVoiceOrigin}=await import('/src/voice-origin.ts');
    const dest=await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-0','session-0']));
    const record={id:'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345',owner:'abcdef02-abcd-4bcd-8bcd-abcdef012345',destination:dest,locale:'es-MX',kind:'speech',createdAt:1,state:'ready',byteCount:10,sha256:'a'.repeat(64)};
    sessionStorage.setItem('session-voice-fixture',JSON.stringify({record,receipt:null}));
  });
  await page.setViewportSize({width:320,height:568}); await page.reload();
  await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});
  const recover=page.getByRole('button',{name:'Transcribir audio de otra sesión'}), discard=page.getByRole('button',{name:'Descartar audio pendiente'});
  await expect(recover).toBeVisible(); await expect(discard).toBeVisible();
  await page.evaluate(() => { const state = globalThis as any; state.holdReceiptRead = true; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishReceiptRead)).toBe('function');
  await recover.focus(); await expect(recover).toBeFocused();
  await page.evaluate(() => { const state = globalThis as any; state.holdReceiptRead = false; state.finishReceiptRead(); });
  await expect.poll(() => page.evaluate(() => (globalThis as any).receiptReadFinished)).toBe(true);
  await expect(recover).toBeFocused();
  const geometry=await page.evaluate(()=>{const selectors=['#composer','#prompt','#discard-voice'];const boxes=Object.fromEntries(selectors.map(s=>[s,document.querySelector(s)!.getBoundingClientRect().toJSON()]));return {boxes,viewport:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth};});
  expect(geometry.overflow).toBe(false); expect(geometry.boxes['#composer'].bottom).toBeLessThanOrEqual(569);
  const checkActions = async (visualHeight: number) => {
    for (const target of [recover, discard]) {
      await target.focus(); await expect(target).toBeFocused();
      await expect.poll(() => target.evaluate((el, height) => {
        const b = el.getBoundingClientRect(), c = el.closest('.voice-context')!.getBoundingClientRect();
        const top = Math.max(b.top, c.top, 0), bottom = Math.min(b.bottom, c.bottom, height);
        return bottom > top && document.elementFromPoint(b.left + b.width / 2, (top + bottom) / 2)?.closest('button') === el;
      }, visualHeight)).toBe(true);
    }
  };
  await checkActions(568);
  const input=page.locator('#prompt'); await input.focus();
  await page.evaluate(()=>{const viewport=window.visualViewport!;Object.defineProperties(viewport,{height:{configurable:true,value:360},pageTop:{configurable:true,value:0},scale:{configurable:true,value:1}});viewport.dispatchEvent(new Event('resize'));});
  await expect(page.locator('html')).toHaveAttribute('data-keyboard','true');
  const draft = Array.from({length: 20}, (_, i) => `línea ${i}`).join('\n');
  await input.fill(draft);
  expect(await page.locator('#composer').evaluate(el=>el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(361);
  await checkActions(360);
  const point = async (target: typeof recover) => target.evaluate(el => {
    const b = el.getBoundingClientRect(), c = el.closest('.voice-context')!.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: (Math.max(b.top, c.top, 0) + Math.min(b.bottom, c.bottom, 360)) / 2 };
  });
  await discard.focus(); page.once('dialog', dialog => dialog.dismiss());
  const discardPoint = await point(discard); await page.mouse.click(discardPoint.x, discardPoint.y);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).record.state)).toBe('ready');
  await page.evaluate(() => sessionStorage.setItem('fail-orphan', '1'));
  await recover.focus(); const recoverPoint = await point(recover); await page.mouse.click(recoverPoint.x, recoverPoint.y);
  await expect(page.locator('#voice-status')).toContainText('No pude transcribir');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).record.state)).toBe('ready');
  await page.evaluate(()=>{const viewport=window.visualViewport!;Object.defineProperty(viewport,'height',{configurable:true,value:568});viewport.dispatchEvent(new Event('resize'));});
  await expect(page.locator('html')).not.toHaveAttribute('data-keyboard','true');
  await expect(input).toHaveValue(draft);
  await checkActions(568);
});

test('orphan language preparation is explicit and can be cancelled without changing its destination', async ({ page }) => {
  await linkedPhone(page);
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  await page.getByRole('button', { name: 'Dictar mensaje' }).click();
  await expect(page.getByRole('button', { name: 'Terminar y revisar' })).toBeVisible();
  await page.locator('[data-panel="chat"]').click();
  await page.evaluate(() => {
    const saved = JSON.parse(sessionStorage.getItem('session-voice-fixture')!);
    saved.record = { ...saved.record, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) };
    sessionStorage.setItem('session-voice-fixture', JSON.stringify(saved));
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke; state.assetCalls = [];
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('attach_retained_voice')) { state.assetCalls.push('attach'); return { ok:false,error:'assets_required' }; }
      if (command.endsWith('prepare_retained_voice')) { state.assetCalls.push(['prepare',args]); return await new Promise(resolve => { state.resolveAsset = resolve; }); }
      if (command.endsWith('cancel_voice')) { state.assetCalls.push(['cancel',args.ownerId]); return await new Promise(resolve => { state.resolveCancel = resolve; }); }
      return previous(command,args);
    };
  });
  await page.locator('[data-panel="settings"]').click(); await page.locator('[data-panel="chat"]').click();
  const button = page.getByRole('button',{name:'Transcribir audio de otra sesión'}); await expect(button).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).assetCalls)).toEqual([]);
  await button.click(); await expect(page.getByRole('button',{name:'Cancelar preparación de voz'})).toBeEnabled();
  await expect(page.locator('#voice-status')).toContainText('Necesitas internet');
  const info = await page.evaluate(() => ({ calls: (globalThis as any).assetCalls, saved: JSON.parse(sessionStorage.getItem('session-voice-fixture')!).record }));
  expect(info.calls[1][1].record).toEqual(info.saved); expect(info.calls[1][1].ownerId).not.toBe(info.saved.owner);
  await page.getByRole('button',{name:'Cancelar preparación de voz'}).click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).assetCalls.some((x:any)=>Array.isArray(x) && x[0] === 'cancel'))).toBe(true);
  await expect(page.locator('#voice-status')).toHaveText('Cancelando la preparación de voz…');
  await expect(button).toBeDisabled();
  await button.evaluate(element => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(await page.evaluate(() => (globalThis as any).assetCalls.filter((x:any)=>x==='attach').length)).toBe(1);
  await page.evaluate(() => (globalThis as any).resolveAsset({ok:true,available:true,status:'available',locale:'es-MX',assetsInstalled:true}));
  await page.evaluate(() => (globalThis as any).resolveCancel({ok:true}));
  await expect(button).toBeEnabled();
  expect(await page.evaluate(() => (globalThis as any).assetCalls.filter((x:any)=>x==='attach').length)).toBe(1);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).record)).toEqual(info.saved);
  await expect(page.locator('#prompt')).toHaveValue('');
});

test('a foreground reinspection cannot overwrite an orphan audio export result', async ({ page }) => {
  await linkedPhone(page);
  await page.evaluate(async () => {
    const {sessionVoiceOrigin} = await import('/src/voice-origin.ts');
    const destination = await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws', 'pane-0', 'session-0']));
    sessionStorage.setItem('session-voice-fixture', JSON.stringify({record:{id:'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345',owner:'abcdef02-abcd-4bcd-8bcd-abcdef012345',destination,locale:'es-MX',kind:'speech',createdAt:1,state:'capturing'},receipt:null}));
    sessionStorage.setItem('missing-session','1');
  });
  await page.reload();
  const button = page.getByRole('button', {name:'Exportar audio incompleto'});
  await expect(button).toBeVisible();
  for (const [mode, expected] of [['cancel','Exportación cancelada.'], ['error','No pude confirmar'], ['success','Audio incompleto exportado']]) {
    await page.evaluate(value => { (globalThis as any).incompleteExportMode = value; }, mode);
    await button.click(); await expect(page.locator('#voice-status')).toContainText(expected);
    const before = await page.evaluate(() => (globalThis as any).sessionCalls.filter((call: any) => call.command.endsWith('inspect_retained_voice')).length);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => page.evaluate(() => (globalThis as any).sessionCalls.filter((call: any) => call.command.endsWith('inspect_retained_voice')).length)).toBeGreaterThan(before);
    await expect(page.locator('#voice-status')).toContainText(expected);
  }
  await page.evaluate(() => {
    const stored = JSON.parse(sessionStorage.getItem('session-voice-fixture')!);
    stored.record.owner = 'abcdef03-abcd-4bcd-8bcd-abcdef012345';
    sessionStorage.setItem('session-voice-fixture', JSON.stringify(stored));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#voice-status')).toContainText('Audio incompleto de otra sesión');
});
