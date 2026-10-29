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
      if (command.endsWith('check_voice')) { const record = JSON.parse(sessionStorage.getItem('session-voice-fixture') || '{\"record\":null}').record; return { available: !state.voiceNeedsAssets, status: state.voiceNeedsAssets ? 'assets_required' : 'available', assetsInstalled: !state.voiceNeedsAssets, microphonePermission: 'granted', recording: false, ...(state.recoveryOwner && record ? {sessionId:record.id,ownerId:state.recoveryOwner,retainedAudio:record,recoveryPending:true} : {}) }; }
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
      if (command.endsWith('attach_retained_voice')) { const current = retained(); if (!same(args.record, current.record) || !args.ownerId || args.ownerId === current.record.owner) throw new Error('audio mismatch'); state.recoveryOwner = args.ownerId; return { ok: true, retainedAudio: current.record, sessionId: current.record.id, ownerId: args.ownerId }; }
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
        const text = state.sessionTranscript ?? 'Revisa la evidencia.';
        const transcript = { sessionId: args.sessionId, source: 'apple-speech-analyzer', locale: 'es-MX', durationSeconds: 2, text, segments: [{ text, startSeconds: 0, endSeconds: 2 }] };
        const current = retained(); if (!current.record) return { ok: true, ...transcript };
        if (args.ownerId !== current.record.owner || args.retainDestination !== current.record.destination || (state.recoveryOwner && args.operationOwnerId !== state.recoveryOwner)) throw new Error('owner mismatch');
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

test('cancel preparation keeps typed text, fences a late callback, and leaves other sessions alone', async ({page}) => {
 await linkedPhone(page); await page.evaluate(() => { const state=globalThis as any, previous=state.__TAURI_INTERNALS__.invoke; state.voiceNeedsAssets=true; state.cancelOwners=[]; state.starts=[];
  state.__TAURI_INTERNALS__.invoke=async (command:string,args:any) => { if(command.endsWith('prepare_voice')) await new Promise<void>(resolve => {state.finishPreparation=resolve;}); if(command.endsWith('cancel_voice')) state.cancelOwners.push(args.ownerId); if(command.endsWith('start_voice')) state.starts.push(args.ownerId); return previous(command,args); }; });
 await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
 const input=page.getByRole('textbox',{name:'Continuar esta sesión'}); await input.fill('Texto previo');
 await page.getByRole('button',{name:'Dictar mensaje'}).click(); await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishPreparation)).toBe('function');
 await expect(page.getByRole('button',{name:'Enviar'})).toBeDisabled(); await page.getByRole('button',{name:'Cancelar dictado'}).click();
 await expect(page.getByRole('button',{name:'Enviar'})).toBeEnabled(); await expect(input).toHaveValue('Texto previo');
 await page.evaluate(() => (globalThis as any).finishPreparation());
 await expect.poll(() => page.evaluate(() => (globalThis as any).starts.length)).toBe(0);
 await page.getByRole('button',{name:'Todos los agentes'}).click(); await page.locator('.agent-session').filter({hasText:'Capri iOS'}).click();
 await page.getByRole('button',{name:'Dictar mensaje'}).click(); await expect(page.getByRole('button',{name:'Terminar y revisar'})).toBeVisible();
 const info=await page.evaluate(() => ({starts:(globalThis as any).starts, cancels:(globalThis as any).cancelOwners})); expect(info.starts).toHaveLength(1); expect(info.cancels).toHaveLength(1); expect(info.cancels[0]).not.toBe(info.starts[0]);
});

test('cancel transcription keeps original audio and draft; a late result cannot alter a newer session', async ({page}) => {
 await page.setViewportSize({width:320,height:568}); await page.emulateMedia({reducedMotion:'reduce'});
 await linkedPhone(page); await page.evaluate(() => { document.documentElement.style.fontSize='200%'; const state=globalThis as any, previous=state.__TAURI_INTERNALS__.invoke; state.holdTranscript=true; state.cancelOwners=[]; state.starts=[];
  state.__TAURI_INTERNALS__.invoke=async (command:string,args:any) => { if(command.endsWith('cancel_voice')) state.cancelOwners.push(args.ownerId); if(command.endsWith('start_voice')) state.starts.push(args.ownerId); return previous(command,args); }; });
 await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
 const input=page.getByRole('textbox',{name:'Continuar esta sesión'}); await input.fill('Texto previo');
 await page.getByRole('button',{name:'Dictar mensaje'}).click(); await page.getByRole('button',{name:'Terminar y revisar'}).click();
 await expect(page.getByText('Transcribiendo…',{exact:true})).toBeVisible();
 const cancel=page.getByRole('button',{name:'Cancelar dictado'}); await expect(cancel).toBeEnabled(); await cancel.focus(); await expect(cancel).toBeFocused();
 const box=await cancel.boundingBox(); expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
 expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y+box!.height).toBeLessThanOrEqual(568);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false); await page.keyboard.press('Enter');
 await expect(page.getByRole('button',{name:'Enviar'})).toBeEnabled(); await expect(input).toHaveValue('Texto previo');
 await expect(page.getByRole('button',{name:'Descartar audio pendiente'})).toBeVisible();
 expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).record.state)).toBe('capturing');
 page.once('dialog', dialog => dialog.accept()); await page.getByRole('button',{name:'Descartar audio pendiente'}).click();
 await expect(page.getByRole('button',{name:'Descartar audio pendiente'})).toHaveCount(0);
 await page.getByRole('button',{name:'Todos los agentes'}).click(); await page.locator('.agent-session').filter({hasText:'Capri iOS'}).click();
 await page.getByRole('button',{name:'Dictar mensaje'}).click(); await expect(page.getByRole('button',{name:'Terminar y revisar'})).toBeVisible();
 await page.evaluate(() => (globalThis as any).finishTranscript());
 await expect(page.getByRole('button',{name:'Terminar y revisar'})).toBeVisible();
 const info=await page.evaluate(() => ({starts:(globalThis as any).starts,cancels:(globalThis as any).cancelOwners})); expect(info.starts).toHaveLength(2); expect(info.cancels.every((owner:string)=>owner!==info.starts[1])).toBe(true);
 await page.evaluate(() => { const state = globalThis as any; state.holdTranscript = false; state.sessionTranscript = 'Sólo la nueva sesión.'; });
 await page.getByRole('button',{name:'Terminar y revisar'}).click();
 await expect(page.getByRole('textbox',{name:'Continuar esta sesión'})).toHaveValue('Sólo la nueva sesión.');
});

test('an unconfirmed cancellation keeps text usable and retries the original owner without deleting audio', async ({page}) => {
 await linkedPhone(page); await page.evaluate(() => { const state=globalThis as any, previous=state.__TAURI_INTERNALS__.invoke; state.holdTranscript=true; state.cancelOwners=[];
  state.__TAURI_INTERNALS__.invoke=async (command:string,args:any) => { if(command.endsWith('cancel_voice')) { state.cancelOwners.push(args.ownerId); if(state.cancelOwners.length === 1) return new Promise(() => {}); } return previous(command,args); }; });
 await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
 const input=page.getByRole('textbox',{name:'Continuar esta sesión'}); await input.fill('Texto previo');
 await page.getByRole('button',{name:'Dictar mensaje'}).click(); await page.getByRole('button',{name:'Terminar y revisar'}).click();
 await page.getByRole('button',{name:'Cancelar dictado'}).click();
 await expect(input).toHaveValue('Texto previo'); await expect(page.getByRole('button',{name:'Enviar'})).toBeEnabled();
 await expect(page.getByText('No pude confirmar que terminó el intento de voz. Toca para reintentar.')).toBeVisible({timeout:12000});
 expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).record.state)).toBe('capturing');
 await page.getByRole('button',{name:'Dictar mensaje'}).click();
 await expect(page.getByRole('button',{name:'Descartar audio pendiente'})).toBeVisible();
 const owners=await page.evaluate(() => (globalThis as any).cancelOwners); expect(owners).toHaveLength(2); expect(owners[1]).toBe(owners[0]);
 await expect(input).toHaveValue('Texto previo');
});

test('audit retained session preparation explains the explicit retry and cancel affordance', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await linkedPhone(page); await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.evaluate(async () => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const { sessionVoiceOrigin } = await import('/src/voice-origin.ts');
    const destination = await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-0','session-0']));
    const record = { id:'12345678-1234-1234-1234-123456789012', owner:'abcdef03-abcd-4bcd-8bcd-abcdef012345', destination, locale:'es-MX', kind:'speech', createdAt:1, state:'ready', byteCount:10, sha256:'a'.repeat(64) };
    sessionStorage.setItem('session-voice-fixture', JSON.stringify({ record, receipt:null }));
    state.calls = [];
    state.__TAURI_INTERNALS__.invoke = async (command:string,args:any) => {
      if (command.endsWith('check_voice')) return {available:false,status:'unsupported_configuration',assetsInstalled:false,microphonePermission:'granted'};
      if (command.endsWith('attach_retained_voice')) { state.calls.push('attach'); return { ok:false, error:'assets_required' }; }
      if (command.endsWith('prepare_retained_voice')) { state.calls.push('prepare'); return await new Promise(resolve => { state.finishAsset = resolve; }); }
      if (command.endsWith('cancel_voice')) { state.calls.push('cancel'); return { ok:true }; }
      return previous(command,args);
    };
  });
  await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  await expect(page.getByText('Hay audio guardado. Toca el micrófono para reintentar la transcripción.')).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).calls)).toEqual([]);
  const input = page.getByRole('textbox',{name:'Continuar esta sesión'}); await input.fill('Texto previo');
  await page.getByRole('button',{name:'Reintentar transcripción'}).click();
  await page.waitForFunction(() => typeof (globalThis as any).finishAsset === 'function');
  await expect(page.getByText(/Necesitas internet/)).toBeVisible();
  const cancel = page.getByRole('button',{name:'Cancelar preparación de voz'}); await expect(cancel).toBeVisible();
  await cancel.focus(); await expect(cancel).toBeFocused(); const box = await cancel.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(568);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Enter'); await expect(input).toHaveValue('Texto previo');
  await expect.poll(() => page.evaluate(() => (globalThis as any).calls.includes('cancel'))).toBe(true);
  await page.evaluate(() => (globalThis as any).finishAsset({ok:true, available:true, status:'available', locale:'es-MX', assetsInstalled:true}));
  await expect(page.getByRole('button',{name:'Reintentar transcripción'})).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).calls.filter((v:string) => v === 'attach').length)).toBe(1);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).record.destination.startsWith('session:'))).toBe(true);
  await page.getByRole('button',{name:'Todos los agentes'}).click(); await page.locator('.agent-session').filter({hasText:'Capri iOS'}).click();
  await expect(page.getByRole('textbox',{name:'Continuar esta sesión'})).toHaveValue('');

});

test('audit session retained preparation remains reachable with landscape keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 568, height: 320 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await linkedPhone(page); await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.evaluate(async () => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const { sessionVoiceOrigin } = await import('/src/voice-origin.ts');
    const destination = await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-0','session-0']));
    const record = { id:'12345678-1234-1234-1234-123456789012', owner:'abcdef03-abcd-4bcd-8bcd-abcdef012345', destination, locale:'es-MX', kind:'speech', createdAt:1, state:'ready', byteCount:10, sha256:'a'.repeat(64) };
    sessionStorage.setItem('session-voice-fixture', JSON.stringify({ record, receipt:null }));
    state.calls = [];
    state.__TAURI_INTERNALS__.invoke = async (command:string,args:any) => {
      if (command.endsWith('attach_retained_voice')) { state.calls.push('attach'); return { ok:false, error:'assets_required' }; }
      if (command.endsWith('prepare_retained_voice')) { state.calls.push('prepare'); return await new Promise(resolve => { state.finishAsset = resolve; }); }
      if (command.endsWith('cancel_voice')) { state.calls.push('cancel'); return { ok:true }; }
      return previous(command,args);
    };
  });
  await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  await expect(page.getByText('Hay audio guardado. Toca el micrófono para reintentar la transcripción.')).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).calls)).toEqual([]);
  const input = page.getByRole('textbox',{name:'Continuar esta sesión'}); await input.fill('Texto previo');
  await page.getByRole('button',{name:'Reintentar transcripción'}).click();
  await page.waitForFunction(() => typeof (globalThis as any).finishAsset === 'function');
  await expect(page.getByText(/Necesitas internet/)).toBeVisible();
  await input.focus(); await page.evaluate(() => { const viewport=window.visualViewport!;Object.defineProperties(viewport,{height:{configurable:true,value:180},pageTop:{configurable:true,value:0},scale:{configurable:true,value:1}});viewport.dispatchEvent(new Event('resize')); });
  const cancel = page.getByRole('button',{name:'Cancelar preparación de voz'}); await expect(cancel).toBeVisible();
  await cancel.focus(); await expect(cancel).toBeFocused(); const box = await cancel.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(180);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Enter'); await expect(input).toHaveValue('Texto previo');
  await expect.poll(() => page.evaluate(() => (globalThis as any).calls.includes('cancel'))).toBe(true);
  await page.evaluate(() => (globalThis as any).finishAsset({ok:true, available:true, status:'available', locale:'es-MX', assetsInstalled:true}));
  await expect(page.getByRole('button',{name:'Reintentar transcripción'})).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).calls.filter((v:string) => v === 'attach').length)).toBe(1);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('session-voice-fixture')!).record.destination.startsWith('session:'))).toBe(true);
  await page.getByRole('button',{name:'Todos los agentes'}).click(); await page.locator('.agent-session').filter({hasText:'Capri iOS'}).click();
  await expect(page.getByRole('textbox',{name:'Continuar esta sesión'})).toHaveValue('');

});

test('audit failed cancellation does not claim an active microphone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await linkedPhone(page); await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.evaluate(async () => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const { sessionVoiceOrigin } = await import('/src/voice-origin.ts');
    const destination = await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-0','session-0']));
    const record = { id:'12345678-1234-1234-1234-123456789012', owner:'abcdef03-abcd-4bcd-8bcd-abcdef012345', destination, locale:'es-MX', kind:'speech', createdAt:1, state:'ready', byteCount:10, sha256:'a'.repeat(64) };
    sessionStorage.setItem('session-voice-fixture', JSON.stringify({ record, receipt:null }));
    state.calls = [];
    state.__TAURI_INTERNALS__.invoke = async (command:string,args:any) => {
      if (command.endsWith('check_voice')) return {available:false,status:'unsupported_configuration',assetsInstalled:false,microphonePermission:'granted'};
      if (command.endsWith('attach_retained_voice')) { state.calls.push('attach'); return { ok:false, error:'assets_required' }; }
      if (command.endsWith('prepare_retained_voice')) { state.calls.push('prepare'); return await new Promise(resolve => { state.finishAsset = resolve; }); }
      if (command.endsWith('cancel_voice')) { state.calls.push('cancel'); return { ok:false, error:'unavailable' }; }
      return previous(command,args);
    };
  });
  await page.locator('[data-panel="agents"]').click(); await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
  await expect(page.getByText('Hay audio guardado. Toca el micrófono para reintentar la transcripción.')).toBeVisible();
  expect(await page.evaluate(() => (globalThis as any).calls)).toEqual([]);
  const input = page.getByRole('textbox',{name:'Continuar esta sesión'}); await input.fill('Texto previo');
  await page.getByRole('button',{name:'Reintentar transcripción'}).click();
  await page.waitForFunction(() => typeof (globalThis as any).finishAsset === 'function');
  await expect(page.getByText(/Necesitas internet/)).toBeVisible();
  const cancel = page.getByRole('button',{name:'Cancelar preparación de voz'}); await expect(cancel).toBeVisible();
  await cancel.focus(); await expect(cancel).toBeFocused(); const box = await cancel.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(568);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByText(/No pude confirmar/)).toBeVisible();
  await expect(page.getByText(/No pude confirmar/)).not.toContainText('micrófono');
});

test('audit cancelled retained audio stays in its session and retry uses a fresh operation', async ({page})=>{
 await page.setViewportSize({width:320,height:568}); await page.emulateMedia({reducedMotion:'reduce'}); await linkedPhone(page); await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});
 await page.evaluate(async()=>{const state=globalThis as any,previous=state.__TAURI_INTERNALS__.invoke;const {sessionVoiceOrigin}=await import('/src/voice-origin.ts');const destination=await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-0','session-0']));const record={id:'12345678-1234-1234-1234-123456789012',owner:'abcdef03-abcd-4bcd-8bcd-abcdef012345',destination,locale:'es-MX',kind:'speech',createdAt:1,state:'ready',byteCount:10,sha256:'a'.repeat(64)};sessionStorage.setItem('session-voice-fixture',JSON.stringify({record,receipt:null}));state.auditOwners=[];state.auditStops=0;
  state.__TAURI_INTERNALS__.invoke=async(command:string,args:any)=>{if(command.endsWith('attach_retained_voice'))state.auditOwners.push(args.ownerId);if(command.endsWith('stop_voice')&&++state.auditStops===1){await new Promise(resolve=>{state.releaseOldAuditStop=resolve;});return {ok:false,error:'cancelled'};}return previous(command,args);};
 });
 await page.locator('[data-panel="agents"]').click();await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();const input=page.getByRole('textbox',{name:'Continuar esta sesión'});await input.fill('Texto previo');
 await expect(page.getByRole('button',{name:'Reintentar transcripción'})).toBeVisible();await page.getByRole('button',{name:'Reintentar transcripción'}).click();await page.waitForFunction(()=>typeof (globalThis as any).releaseOldAuditStop==='function');
 const cancel=page.getByRole('button',{name:'Cancelar dictado'});await cancel.focus();await expect(cancel).toBeFocused();await page.keyboard.press('Enter');await expect(input).toHaveValue('Texto previo');await expect(page.getByRole('button',{name:'Reintentar transcripción'})).toBeVisible();
 await page.getByRole('button',{name:'Todos los agentes'}).click();await page.locator('.agent-session').filter({hasText:'Capri iOS'}).click();await expect(page.getByRole('textbox',{name:'Continuar esta sesión'})).toHaveValue('');await expect(page.getByText(/audio pendiente en otra sesión|audio pendiente en otra conversación/i)).toBeVisible();
 await page.getByRole('button',{name:'Todos los agentes'}).click();await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();await expect(input).toHaveValue('Texto previo');await expect(page.getByRole('button',{name:'Reintentar transcripción'})).toBeVisible();await page.getByRole('button',{name:'Reintentar transcripción'}).click();await expect(input).toHaveValue('Texto previo\nRevisa la evidencia.');
 const owners=await page.evaluate(()=>(globalThis as any).auditOwners);expect(owners).toHaveLength(2);expect(owners[0]).not.toBe(owners[1]);expect(owners).not.toContain('abcdef03-abcd-4bcd-8bcd-abcdef012345');
 await page.evaluate(()=>(globalThis as any).releaseOldAuditStop());await expect(input).toHaveValue('Texto previo\nRevisa la evidencia.');
});

test('background during first session asset preparation cancels the exact owner without starting capture', async ({page}) => {
 await linkedPhone(page);
 await page.evaluate(()=>{const state=globalThis as any, previous=state.__TAURI_INTERNALS__.invoke;state.voiceNeedsAssets=true;state.actions=[];
  state.__TAURI_INTERNALS__.invoke=async(command:string,args:any)=>{
   if(command.endsWith('prepare_voice')){state.actions.push(['prepare',args.ownerId]);return await new Promise(resolve=>{state.finishAssets=resolve;});}
   if(command.endsWith('cancel_voice')){state.actions.push(['cancel',args.ownerId]);return {ok:true};}
   if(command.endsWith('start_voice'))state.actions.push(['start',args.ownerId]);
   return previous(command,args);
  };
 });
 await page.locator('[data-panel="agents"]').click();await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
 const input=page.getByRole('textbox',{name:'Continuar esta sesión'});await input.fill('Texto previo');
 await page.getByRole('button',{name:'Dictar mensaje'}).click(); await expect(page.getByText(/Descargando la voz/)).toBeVisible();
 const owner=await page.evaluate(()=>(globalThis as any).actions[0][1]);
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
 await expect.poll(()=>page.evaluate(()=>(globalThis as any).actions)).toContainEqual(['cancel',owner]);
 await page.evaluate(()=>(globalThis as any).finishAssets({ok:true,available:true,status:'available',assetsInstalled:true}));
 await expect(input).toHaveValue('Texto previo');
 expect(await page.evaluate(()=>(globalThis as any).actions.some((x:any)=>x[0]==='start'))).toBe(false);
});

test('background during retained session language preparation preserves audio and original session', async ({page}) => {
 await linkedPhone(page);
 await page.evaluate(async()=>{const state=globalThis as any,previous=state.__TAURI_INTERNALS__.invoke;const {sessionVoiceOrigin}=await import('/src/voice-origin.ts');
  const destination=await sessionVoiceOrigin(JSON.stringify(['wss://sessions.fixture.example/ws','pane-0','session-0']));
  const record={id:'12345678-1234-1234-1234-123456789012',owner:'abcdef03-abcd-4bcd-8bcd-abcdef012345',destination,locale:'es-MX',kind:'speech',createdAt:1,state:'ready',byteCount:10,sha256:'a'.repeat(64)};
  sessionStorage.setItem('session-voice-fixture',JSON.stringify({record,receipt:null}));state.actions=[];
  state.__TAURI_INTERNALS__.invoke=async(command:string,args:any)=>{
   if(command.endsWith('attach_retained_voice')){state.actions.push('attach');return {ok:false,error:'assets_required'};}
   if(command.endsWith('prepare_retained_voice')){state.actions.push(['prepare',args.ownerId]);return await new Promise(resolve=>{state.finishAssets=resolve;});}
   if(command.endsWith('cancel_voice')){state.actions.push(['cancel',args.ownerId]);return {ok:true};}
   return previous(command,args);
  };
 });
 await page.locator('[data-panel="agents"]').click();await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();
 const input=page.getByRole('textbox',{name:'Continuar esta sesión'});await input.fill('Texto previo');
 await page.getByRole('button',{name:'Reintentar transcripción'}).click();await expect(page.getByText(/Necesitas internet/)).toBeVisible();
 const snapshot=await page.evaluate(()=>({audio:JSON.parse(sessionStorage.getItem('session-voice-fixture')!).record,owner:(globalThis as any).actions[1][1]}));
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
 await expect.poll(()=>page.evaluate(()=>(globalThis as any).actions)).toContainEqual(['cancel',snapshot.owner]);
 await page.evaluate(()=>(globalThis as any).finishAssets({ok:true,available:true,status:'available',locale:'es-MX',assetsInstalled:true}));
 expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('session-voice-fixture')!).record)).toEqual(snapshot.audio);
 expect(await page.evaluate(()=>(globalThis as any).actions.filter((x:any)=>x==='attach').length)).toBe(1);
 await expect(input).toHaveValue('Texto previo');
});
