import { expect, test, openRecoveryHarness } from './fixtures.ts';

async function nativeFixture(page: import('@playwright/test').Page, delayed = false, decisions: object[] = []) {
  await page.addInitScript(({ delayed, decisions }) => {
    const state = globalThis as any;
    state.isTauri = true;
    state.nativePrompts = [];
    state.nativeCalls = [];
    state.nativeDecisions = decisions;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('results_list')) return { ok: true, items: [] };
      state.nativeCalls.push(command);
      if (command.endsWith('secret_get')) {
        const request = args.request;
        const value = sessionStorage.getItem(`fixture-keychain:${request.scope}:${request.account}`);
        return value === null ? { ok: true } : { ok: true, value };
      }
      if (command.endsWith('secret_set')) {
        const request = args.request;
        sessionStorage.setItem(`fixture-keychain:${request.scope}:${request.account}`, request.value); return { ok: true };
      }
      if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('agent_step')) {
        state.nativePrompts.push(args.prompt);
        if (delayed) return await new Promise(resolve => { state.finishNative = resolve; });
        return { ok: true, decision: state.nativeDecisions.shift() ?? { kind: 'answer', text: 'Respuesta local de prueba <b>literal</b>.', toolName: '', argumentsJSON: '{}' } };
      }
      return { ok: true };
    } };
    // Adapt legacy per-test voice replies to the retained native protocol.
    // Cancellation keeps the journal; only an exact release/discard clears it.
    let record: any = null, receipt: any = null, captureEpoch = 0;
    state.wrapRetainedVoice = (invoke: (command: string, args: any) => Promise<any>) => async (command: string, args: any = {}) => {
      if (command.endsWith('inspect_retained_voice')) return { ok: true, retainedAudio: record };
      if (command.endsWith('list_voice_receipts')) return { ok: true, receipts: receipt ? [receipt] : [] };
      if (command.endsWith('get_voice_receipt')) return { ok: true, receipt: receipt?.receipt.audio.id.toLowerCase() === args.sessionId.toLowerCase() ? receipt : null };
      if (command.endsWith('release_retained_voice')) {
        if (!receipt || JSON.stringify(args.receipt) !== JSON.stringify(receipt.receipt)) throw new Error('Unmatched receipt');
        receipt.releaseState = 'released'; record = null; return { ok: true, releaseState: 'released' };
      }
      if (command.endsWith('discard_retained_voice')) {
        if (JSON.stringify(args.record) !== JSON.stringify(record)) throw new Error('Unmatched audio');
        record = null; return { ok: true };
      }
      if (command.endsWith('attach_retained_voice')) {
        if (JSON.stringify(args.record) !== JSON.stringify(record) || record?.state !== 'ready') throw new Error('Unmatched audio');
        return { ok: true, sessionId: record.id, ownerId: record.owner, retainedAudio: record };
      }
      const startedAt = captureEpoch;
      const result = await invoke(command, args);
      if (command.endsWith('cancel_voice') && result?.ok) captureEpoch++;
      if (command.endsWith('start_voice') && result?.ok && result.sessionId) {
        const started = { id: result.sessionId, owner: args.ownerId, destination: args.retainDestination, locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'capturing' };
        if (startedAt === captureEpoch) record = started;
        return { ...result, retainedAudio: started };
      }
      if (command.endsWith('stop_voice') && result?.ok && record && result.sessionId === record.id) {
        record = { ...record, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) };
        const { sessionId, text, segments, durationSeconds, locale, source } = result;
        receipt = { receipt: { schema: 'capri-native-voice-receipt/v1', audio: record, transcript: { sessionId, text, segments, durationSeconds, locale, source } }, releaseState: 'retained' };
        return { ...result, retainedAudio: record };
      }
      return result;
    };
  }, { delayed, decisions });
}

async function openManualConnection(page: import('@playwright/test').Page) {
  await page.locator('[data-panel="settings"]').click();
  if (!await page.locator('#url').isVisible()) await page.getByText('Conexión manual', { exact: true }).click();
}

async function chooseEngine(page: import('@playwright/test').Page, value: string) {
  await page.locator('[data-panel="chat"]').click();
  if (!await page.locator('#engine').isVisible()) await page.locator('.engine-details summary').click();
  await page.locator('#engine').selectOption(value);
}

test('changing laptops interrupts the previous host stream without resending it', async ({ page }) => {
  let firstSend: ((data: object) => void) | undefined;
  const submissions: string[] = [];
  for (const [host, first] of [['first.example', true], ['second.example', false]] as const) {
    await page.routeWebSocket(`wss://${host}/ws`, ws => {
      let sequence = 0;
      const send = (data: object) => ws.send(JSON.stringify({ seq: sequence++, ...data }));
      if (first) firstSend = send;
      ws.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (message.type === 'hello') send({ type: 'ready', agentState: 'idle', conversationId: 'main' });
        if (message.type === 'get_history') send({ type: 'history', conversationId: 'main', messages: [] });
        if (message.type === 'send') submissions.push(message.text);
      });
    });
  }
  await page.goto('/');
  await openManualConnection(page);
  await page.locator('#url').fill('wss://first.example/ws');
  await page.locator('#token').fill('fixture-one');
  await page.locator('#connection button[type="submit"]').click();
  await expect(page.locator('#status')).toHaveText('Vinculado a Gentle Dot');
  await page.locator('[data-panel="chat"]').click();
  firstSend!({ type: 'message_delta', messageId: 'stream-1', delta: 'Respuesta parcial' });
  firstSend!({ type: 'activity', messageId: 'stream-1', activity: { id: 'task-1', title: 'Consultando contexto', kind: 'read', status: 'running' } });
  const card = page.locator('.chat-card[data-role="assistant"]').filter({ hasText: 'Respuesta parcial' });
  await expect(card).toHaveAttribute('data-state', 'pending');
  await openManualConnection(page);
  await page.locator('#url').fill('wss://second.example/ws');
  await page.locator('#token').fill('fixture-two');
  await page.locator('#connection button[type="submit"]').click();
  await expect(page.locator('#status')).toHaveText('Vinculado a Gentle Dot');
  await page.locator('[data-panel="chat"]').click();
  await expect(card).toHaveAttribute('data-state', 'interrupted');
  await expect(card).toContainText('No se reenvía automáticamente');
  await expect(card.locator('.tool-trace > summary')).toContainText('interrumpida o fallida');
  expect(submissions).toEqual([]);
});

test('browser never claims native inference; draft survives reload without sending', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#engine-status')).toContainText('esta vista no ejecuta');
  await expect(page.locator('#engine-status')).toBeVisible();
  await expect(page.locator('#send')).toBeDisabled();
  await page.locator('#prompt').fill('Conservar este borrador offline');
  await expect.poll(async () => page.evaluate(async () => (await (await import('/src/conversation.ts' as string)).loadConversation()).draft)).toBe('Conservar este borrador offline');
  await page.reload();
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#prompt')).toHaveValue('Conservar este borrador offline');
  await expect(page.locator('.chat-card')).toHaveCount(0);
});

test('automatic routing names its current destination and settings show connection state', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await expect(page.locator('#engine-summary')).toHaveText('Auto · iPhone');
  await page.locator('.engine-details summary').click();
  await expect(page.locator('#engine-explanation')).toContainText('primero la IA del iPhone');
  await page.locator('#engine').selectOption('gentle');
  await expect(page.locator('#engine-summary')).toHaveText('Laptop');
  await expect(page.locator('#engine-explanation')).toContainText('Gentle Dot');
  await page.locator('[data-panel="settings"]').click();
  await expect(page.locator('#settings-connection-state')).toHaveText('Sin conexión');
  await expect(page.locator('#settings-connection-detail')).toContainText('Vincula tu laptop');
  await expect(page.locator('#pairing-camera')).toBeVisible();
});

test('native bridge fixture maintains one local timeline and bounds follow-up context', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await page.locator('[data-panel="chat"]').click();
  await page.locator('#prompt').fill('Mi proyecto se llama Capri.');
  await page.locator('#send').click();
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText('Respuesta local de prueba');
  await expect(page.locator('.chat-text b')).toHaveCount(0);
  await page.locator('#prompt').fill('¿Cómo se llama mi proyecto?');
  await page.locator('#send').click();
  await expect(page.locator('.chat-card[data-role="assistant"]')).toHaveCount(2);
  await expect(page.locator('.chat-card[data-role="assistant"]').last()).toContainText('Respuesta local de prueba');
  const prompts = await page.evaluate(() => (globalThis as any).nativePrompts);
  expect(prompts[1]).toContain('Mi proyecto se llama Capri.');
  expect(Array.from(prompts[1]).length).toBeLessThanOrEqual(8000);
  await expect.poll(async () => page.evaluate(async () => (await (await import('/src/conversation.ts' as string)).loadConversation()).entries.length)).toBe(4);
  await page.reload();
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('.chat-card')).toHaveCount(4);
});

test('cancel suppresses late native completion and never reports success', async ({ page }) => {
  await nativeFixture(page, true);
  await page.goto('/');
  await page.locator('[data-panel="chat"]').click();
  await page.locator('#prompt').fill('Genera una respuesta');
  await page.locator('#send').click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishNative)).toBe('function');
  await page.locator('#stop').click();
  await page.evaluate(() => (globalThis as any).finishNative({ ok: true, decision: { kind: 'answer', text: 'LATE RESULT', toolName: '', argumentsJSON: '{}' } }));
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText('Respuesta interrumpida.');
  await expect(page.locator('#cards')).not.toContainText('LATE RESULT');
  await expect(page.locator('#send')).toBeEnabled();
});

test('agent fixture uses the real local work tool from the conversation and persists its receipt', async ({ page }) => {
  await nativeFixture(page, false, [
    { kind: 'tool', text: '', toolName: 'tool_describe', argumentsJSON: JSON.stringify({ name: 'work_create' }) },
    { kind: 'tool', text: '', toolName: 'work_create', argumentsJSON: JSON.stringify({ title: 'Revisar E-503', kind: 'task', instruction: 'Contrastar el error con el registro original.' }) },
    { kind: 'answer', text: 'Guardé Revisar E-503 en este iPhone. No se envió a la laptop.', toolName: '', argumentsJSON: '{}' },
  ]);
  await page.goto('/');
  await page.locator('#prompt').fill('Capri, guarda una tarea para revisar E-503.');
  await page.locator('#send').click();
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText('Guardé Revisar E-503');
  const trace = page.locator('.chat-card[data-role="assistant"] .tool-trace');
  await trace.locator(':scope > summary').click();
  await expect(trace).toContainText('Completado');
  await trace.getByText('Ver resultado', { exact: true }).click();
  await expect(trace.locator('pre')).toContainText('"savedLocally":true');
  const work = await page.evaluate(async () => (await (await import('/src/work-inbox.ts' as string)).listWork())[0]);
  expect(work).toMatchObject({ title: 'Revisar E-503', kind: 'task', instruction: 'Contrastar el error con el registro original.', revision: 1, status: 'local' });
  const prompts = await page.evaluate(() => (globalThis as any).nativePrompts);
  expect(prompts).toHaveLength(3);
  expect(prompts[2]).toContain('"savedLocally":true');
  expect(prompts[2]).toContain('"synchronized":false');
  await expect.poll(async () => page.evaluate(async () => {
    const saved = await (await import('/src/conversation.ts' as string)).loadConversation();
    return saved.entries.find((entry: any) => entry.role === 'assistant')?.activities?.[0]?.status;
  })).toBe('done');
  await page.reload();
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText('Guardé Revisar E-503');
  await openRecoveryHarness(page);
  await expect(page.locator('#work-list .work-item')).toHaveCount(1);
  await expect(page.locator('#work-list')).toContainText('Solo en este iPhone');
});

test('host activity, exact human answers and steering stay in the same conversation', async ({ page }) => {
  const submissions: string[] = [];
  const answers: object[] = [];
  let hostSend: ((data: object) => void) | undefined;
  await page.routeWebSocket('wss://activity.example/ws', ws => {
    let sequence = 0;
    const send = (data: object) => ws.send(JSON.stringify({ seq: sequence++, ...data }));
    hostSend = send;
    ws.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello') send({ type: 'ready', agentState: 'idle', conversationId: 'operations' });
      if (message.type === 'get_history') send({ type: 'history', conversationId: 'operations', messages: [] });
      if (message.type === 'send') {
        submissions.push(message.text);
        send({ type: 'user_message', messageId: 'user-' + submissions.length, text: message.text });
        send({ type: 'agent_state', state: 'working' });
        if (submissions.length === 1) {
          send({ type: 'activity', messageId: 'assistant-1', activity: { id: 'read-1', title: 'Leyendo registro de operaciones', kind: 'read', status: 'running' } });
          send({ type: 'ask', ask: { requestId: 'confirm-1', method: 'confirm', title: 'Revisar cambio exacto', message: 'Proyecto: CAPRI\nCambio: E-503 <b>literal</b>' } });
        } else send({ type: 'queue', steering: [message.text], followUp: [] });
      }
      if (message.type === 'ui_response') answers.push(message);
    });
  });
  await page.goto('/');
  await openManualConnection(page);
  await page.locator('#url').fill('wss://activity.example/ws');
  await page.locator('#token').fill('fixture-only');
  await page.locator('#connection button[type="submit"]').click();
  await expect(page.locator('#status')).toHaveText('Vinculado a Gentle Dot');
  await page.locator('[data-panel="chat"]').click();
  await page.locator('#prompt').fill('Revisa operaciones.');
  await page.locator('#send').click();
  await expect(page.locator('#active-tool')).toHaveText('Leyendo registro de operaciones');
  await expect(page.locator('.chat-card[data-role="assistant"] .tool-trace > summary')).toHaveText('1 acción · En curso: Leyendo registro de operaciones');
  const request = page.locator('#requests .review-card').first();
  await expect(request).toContainText('Proyecto: CAPRI\nCambio: E-503 <b>literal</b>');
  await expect(request.locator('b')).toHaveCount(0);
  expect(answers).toEqual([]);
  const staleButton = await request.getByRole('button', { name: 'Permitir', exact: true }).elementHandle();
  hostSend!({ type: 'ask', ask: { requestId: 'confirm-1', method: 'confirm', title: 'Revisar cambio exacto', message: 'Proyecto: CAPRI\nCambio actualizado: E-504' } });
  await expect(request).toContainText('La solicitud cambió.');
  await expect(request.getByRole('button')).toHaveCount(0);
  // A stale DOM event must not approve the newer server snapshot.
  await staleButton!.evaluate(button => button.click());
  expect(answers).toEqual([]);
  const currentRequest = page.locator('#requests .review-card').last();
  await expect(currentRequest).toContainText('Cambio actualizado: E-504');
  await currentRequest.getByRole('button', { name: 'Permitir', exact: true }).click();
  await expect.poll(() => answers.length).toBe(1);
  expect(answers[0]).toMatchObject({ type: 'ui_response', requestId: 'confirm-1', confirmed: true });
  await expect(currentRequest).toContainText('esperando confirmación del host');
  hostSend!({ type: 'ask_resolved', requestId: 'confirm-1' });
  await expect(currentRequest).toContainText('Solicitud cerrada por el host.');
  await expect(page.locator('#send')).toHaveAccessibleName('Añadir instrucción');
  await page.locator('#prompt').fill('Prioriza los errores de hoy.');
  await page.locator('#send').click();
  await expect.poll(() => submissions.length).toBe(2);
  await expect(page.locator('#chat-notice')).toContainText('1 instrucción(es) recibidas');
  hostSend!({ type: 'activity', messageId: 'assistant-1', activity: { id: 'read-1', title: 'Leyendo registro de operaciones', kind: 'read', status: 'done' } });
  hostSend!({ type: 'message_done', messageId: 'assistant-1', text: 'Revisión preparada.' });
  hostSend!({ type: 'agent_state', state: 'idle' });
  await expect(page.locator('#active-tool')).toBeEmpty();
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText('Revisión preparada.');
  await expect(page.locator('.chat-card[data-role="assistant"] .tool-trace > summary')).toHaveText('1 acción · Completada');
  // The legacy host supplies no identity tying either echo to our request.
  await expect(page.locator('.chat-card[data-role="user"]')).toHaveCount(4);
});

test('conversation approval renders exact content and cancellation cannot authorize it', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { createConversationRequests } = await import('/src/conversation-requests.ts' as string);
    const state = globalThis as any;
    state.approvalController = new AbortController();
    state.humanApproval = 'pending';
    const requests = createConversationRequests(document.getElementById('requests')!);
    void requests.approve({ title: 'Enviar revisión', details: 'Destinatario: ops@example.test\nTexto: <b>exacto</b>', operation: 'test' }, state.approvalController.signal)
      .then((approved: boolean) => { state.humanApproval = approved; });
  });
  const card = page.locator('#requests .review-card');
  await expect(card).toContainText('Destinatario: ops@example.test');
  await expect(card.locator('b')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as any).humanApproval)).toBe('pending');
  await page.evaluate(() => (globalThis as any).approvalController.abort());
  await expect.poll(() => page.evaluate(() => (globalThis as any).humanApproval)).toBe(false);
  await expect(card).toContainText('Operación no autorizada.');
  await expect(card.getByRole('button')).toHaveCount(0);
});

for (const [status, message] of [
  ['assets_downloading', 'Apple está preparando la voz o esperando condiciones para descargarla.'],
  ['unsupported_configuration', 'La configuración de voz en español no está disponible en este iPhone.'],
] as const) {
  test(`chat reports ${status} after voice preparation`, async ({ page }) => {
    await nativeFixture(page);
    await page.addInitScript((resultStatus: string) => {
      const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
      state.voicePreparationCalls = [];
      state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
        if (command.endsWith('check_voice')) return { ok: true, available: false, status: 'assets_required', assetsInstalled: false, microphonePermission: 'granted' };
        if (command.endsWith('prepare_voice')) { state.voicePreparationCalls.push('prepare'); return { ok: true, available: false, status: resultStatus, assetsInstalled: false, microphonePermission: 'granted' }; }
        if (command.endsWith('start_voice')) state.voicePreparationCalls.push('start');
        return previous(command, args);
      });
    }, status);
    await page.goto('/');
    await page.locator('#dictate').click();
    await expect(page.locator('#voice-status')).toContainText(message);
    expect(await page.evaluate(() => (globalThis as any).voicePreparationCalls)).toEqual(['prepare']);
    await expect(page.locator('#voice-status')).not.toContainText('Comprueba la conexión');
  });
}

test('voice fixture prepares assets on microphone tap and appends dictation without sending', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any;
    const previous = state.__TAURI_INTERNALS__.invoke;
    let prepared = false;
    state.voiceActions = [];
    const availability = () => ({ ok: true, available: prepared, status: prepared ? 'available' : 'assets_required', assetsInstalled: prepared, locale: 'es-MX', microphonePermission: 'granted' });
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return availability();
      if (command.endsWith('prepare_voice')) { state.voiceActions.push('prepare'); prepared = true; return availability(); }
      if (command.endsWith('start_voice')) { state.voiceActions.push('start'); return { ok: true, sessionId: '01234567-89ab-cdef-0123-456789abcdef', maxDurationSeconds: 90 }; }
      if (command.endsWith('stop_voice')) {
        state.voiceActions.push('stop');
        return { ok: true, sessionId: args.sessionId, text: 'Añade evidencia del error.', locale: 'es-MX', durationSeconds: 2,
          source: 'apple-speech-analyzer', segments: [{ text: 'Añade evidencia del error.', startSeconds: 0.1, endSeconds: 1.8 }] };
      }
      return previous(command, args);
    });
  });
  await page.goto('/');
  await page.locator('#prompt').fill('Borrador existente.');
  await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  await expect(page.locator('#voice-status')).toContainText('Escuchando');
  expect(await page.evaluate(() => (globalThis as any).voiceActions)).toEqual(['prepare', 'start']);
  await page.locator('#dictate').click();
  await expect(page.locator('#prompt')).toHaveValue('Borrador existente.\nAñade evidencia del error.');
  await expect(page.locator('#voice-status')).toBeEmpty();
  await expect(page.locator('.chat-card[data-role="user"]')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as any).nativePrompts)).toEqual([]);
  expect(await page.evaluate(() => (globalThis as any).voiceActions)).toEqual(['prepare', 'start', 'stop']);
});

test('sending waits for dictation to finish and ignores programmatic submission while listening', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('start_voice')) return { ok: true, sessionId: id, maxDurationSeconds: 90 };
      if (command.endsWith('stop_voice')) return await new Promise(resolve => { state.finishVoice = () => resolve({ ok: true, sessionId: args.sessionId, text: 'parte dictada', locale: 'es-MX', durationSeconds: 2,
        source: 'apple-speech-analyzer', segments: [{ text: 'parte dictada', startSeconds: 0.1, endSeconds: 1.8 }] }); });
      return previous(command, args);
    });
  });
  await page.goto('/');
  await page.locator('#prompt').fill('parte escrita');
  await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  await expect(page.locator('#send')).toBeDisabled();
  await page.locator('#composer').evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(await page.evaluate(() => (globalThis as any).nativePrompts)).toEqual([]);
  await page.locator('#dictate').click();
  await expect(page.locator('#voice-status')).toContainText('Transcribiendo');
  await expect(page.locator('#send')).toBeDisabled();
  await page.locator('#composer').evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(await page.evaluate(() => (globalThis as any).nativePrompts)).toEqual([]);
  await page.evaluate(() => (globalThis as any).finishVoice());
  await expect(page.locator('#prompt')).toHaveValue('parte escrita\nparte dictada');
  await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#send').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).nativePrompts.length)).toBe(1);
  expect((await page.evaluate(() => (globalThis as any).nativePrompts[0]))).toContain('parte escrita\nparte dictada');
});

test('a failed transcription releases send while retaining the typed draft', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('start_voice')) return { ok: true, sessionId: id, maxDurationSeconds: 90 };
      if (command.endsWith('stop_voice')) return { ok: false, error: 'preview_pending', sessionId: id, message: 'Audio pendiente.' };
      return previous(command, args);
    });
  });
  await page.goto('/');
  await page.locator('#prompt').fill('texto que sí escribí');
  await page.locator('#dictate').click();
  await page.locator('#dictate').click();
  await expect(page.locator('#voice-status')).toContainText('Audio pendiente.');
  await expect(page.locator('#prompt')).toHaveValue('texto que sí escribí');
  await expect(page.locator('#send')).toBeEnabled();
});

test('a stuck transcription can be cancelled and its late result cannot change the draft', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    state.voiceCancels = 0;
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('start_voice')) return { ok: true, sessionId: id, maxDurationSeconds: 90 };
      if (command.endsWith('cancel_voice')) { state.voiceCancels++; return { ok: true }; }
      if (command.endsWith('stop_voice')) return await new Promise(resolve => { state.finishVoice = () => resolve({ ok: true, sessionId: args.sessionId, text: 'resultado tardío', locale: 'es-MX', durationSeconds: 2,
        source: 'apple-speech-analyzer', segments: [{ text: 'resultado tardío', startSeconds: 0, endSeconds: 2 }] }); });
      return previous(command, args);
    });
  });
  await page.goto('/');
  await page.locator('#prompt').fill('texto preservado');
  await page.locator('#dictate').click();
  await page.locator('#dictate').click();
  await expect(page.locator('#voice-status')).toContainText('Transcribiendo');
  await expect(page.locator('#send')).toBeDisabled();
  await page.locator('#dictate').click();
  await expect(page.locator('#send')).toBeEnabled();
  expect(await page.evaluate(() => (globalThis as any).voiceCancels)).toBe(1);
  await page.evaluate(() => (globalThis as any).finishVoice());
  await expect(page.locator('#prompt')).toHaveValue('texto preservado');
});

test('a denied microphone permission releases sending and preserves typed text', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'denied' };
      if (command.endsWith('start_voice')) return { ok: false, error: 'microphone_denied', message: 'Activa el micrófono para Capri en Ajustes del iPhone.' };
      if (command.endsWith('cancel_voice')) return { ok: true };
      return previous(command, args);
    });
  });
  await page.goto('/');
  await page.locator('#prompt').fill('Borrador escrito');
  await page.locator('#dictate').click();
  await expect(page.locator('#voice-status')).toContainText('Activa el micrófono');
  await expect(page.locator('#send')).toBeEnabled();
  await expect(page.locator('#prompt')).toHaveValue('Borrador escrito');
});

test('returning from settings waits only for the original microphone cancellation', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('start_voice')) return { ok: true, sessionId: id, maxDurationSeconds: 90 };
      if (command.endsWith('cancel_voice')) return await new Promise(resolve => { state.finishCancellation = () => resolve({ ok: true }); });
      return previous(command, args);
    });
  });
  await page.goto('/');
  await page.locator('#prompt').fill('Borrador escrito');
  await page.locator('#dictate').click();
  await page.locator('[data-panel="settings"]').click();
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#send')).toBeDisabled();
  await page.locator('#composer').evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(await page.evaluate(() => (globalThis as any).nativePrompts)).toEqual([]);
  await page.evaluate(() => (globalThis as any).finishCancellation());
  await expect(page.locator('#send')).toBeEnabled();
  await expect(page.locator('#prompt')).toHaveValue('Borrador escrito');
});

test('a preserved voice command returns to its original chat after navigation', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    let owner = '', pending = false, stops = 0;
    state.voiceRecoveryCancels = 0;
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted',
        ...(pending ? { recoveryPending: true, ownerId: owner, sessionId: id, recoveryIssue: 'No detecté palabras. Descarta este audio y vuelve a dictar.' } : {}) };
      if (command.endsWith('start_voice')) { owner = args.ownerId; return { ok: true, sessionId: id, maxDurationSeconds: 90 }; }
      if (command.endsWith('cancel_voice')) { state.voiceRecoveryCancels++; pending = false; return { ok: true }; }
      if (command.endsWith('stop_voice')) {
        if (++stops === 1) { pending = true; return { ok: false, error: 'preview_pending', sessionId: id, message: 'No detecté palabras. Descarta este audio y vuelve a dictar.' }; }
        pending = false; return { ok: true, sessionId: id, text: 'Transcripción recuperada.', locale: 'es-MX', durationSeconds: 2,
          source: 'apple-speech-analyzer', segments: [{ text: 'Transcripción recuperada.', startSeconds: 0, endSeconds: 2 }] };
      }
      return previous(command, args);
    });
  });
  await page.goto('/');
  await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Reintentar transcripción');
  await page.locator('[data-panel="settings"]').click();
  expect(await page.evaluate(() => (globalThis as any).voiceRecoveryCancels)).toBe(0);
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Reintentar transcripción');
  await expect(page.locator('#voice-status')).toContainText('No detecté palabras');
  await page.locator('#dictate').click();
  await expect(page.locator('#prompt')).toHaveValue('Transcripción recuperada.');
  await expect(page.locator('#discard-voice')).toBeHidden();
});

test('an unconfirmed microphone cancellation retains its owner and retries before recording again', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    let owner = '', attempts = 0;
    state.voiceCancelAttempts = [];
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('start_voice')) { owner = args.ownerId; state.voiceOwner = owner; return { ok: true, sessionId: id, maxDurationSeconds: 90 }; }
      if (command.endsWith('cancel_voice')) {
        state.voiceCancelAttempts.push(args.ownerId);
        if (++attempts === 1) throw new Error('bridge unavailable');
        return { ok: true };
      }
      return previous(command, args);
    });
  });
  await page.goto('/');
  await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  await page.locator('[data-panel="settings"]').click();
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Reintentar detener micrófono');
  await expect(page.locator('#voice-status')).toContainText('No pude confirmar');
  expect(await page.evaluate(() => sessionStorage.getItem(`capri.voice.origin.${(globalThis as any).voiceOwner}`))).toBe('chat');
  await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Dictar');
  await expect(page.locator('#voice-status')).toContainText('Audio incompleto; podría no reproducirse');
  await expect(page.locator('#discard-voice')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem(`capri.voice.origin.${(globalThis as any).voiceOwner}`))).toBeNull();
  expect(await page.evaluate(() => (globalThis as any).voiceCancelAttempts)).toEqual([
    await page.evaluate(() => (globalThis as any).voiceOwner), await page.evaluate(() => (globalThis as any).voiceOwner),
  ]);
});

test('failed audio cleanup is shown distinctly and the same owner can retry', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    state.cleanupOwners = [];
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('start_voice')) return { ok: true, sessionId: id, maxDurationSeconds: 90 };
      if (command.endsWith('cancel_voice')) {
        state.cleanupOwners.push(args.ownerId);
        if (state.cleanupOwners.length === 1) return { ok: false, error: 'cancel_cleanup_failed', message: 'No pude eliminar el audio pendiente. Toca el micrófono para reintentar.' };
        return { ok: true };
      }
      return previous(command, args);
    });
  });
  await page.goto('/');
  await page.locator('#dictate').click();
  await page.locator('[data-panel="settings"]').click();
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#voice-status')).toContainText('No pude eliminar el audio pendiente');
  await expect(page.locator('#dictate')).toHaveAccessibleName('Reintentar detener micrófono');
  await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Dictar');
  const owners = await page.evaluate(() => (globalThis as any).cleanupOwners);
  expect(owners).toHaveLength(2); expect(owners[0]).toBe(owners[1]);
});

test('an unattributed pending recording can be explicitly discarded without inserting its contents', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = '01234567-89ab-cdef-0123-456789abcdef', owner = '11111111-1111-4111-8111-111111111111';
    let pending = true;
    state.discardedOwner = '';
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted',
        ...(pending ? { recoveryPending: true, ownerId: owner, sessionId: id } : {}) };
      if (command.endsWith('cancel_voice')) { state.discardedOwner = args.ownerId; pending = false; return { ok: true }; }
      return previous(command, args);
    });
  });
  await page.goto('/');
  await expect(page.locator('#voice-status')).toContainText('otra sesión');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#discard-voice').click();
  await expect(page.locator('#discard-voice')).toBeHidden();
  await expect(page.locator('#prompt')).toHaveValue('');
  expect(await page.evaluate(() => (globalThis as any).discardedOwner)).toBe('11111111-1111-4111-8111-111111111111');
});

test('provisional live dictation stays separate from the draft until one final result', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    let recording = false;
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    state.voicePartial = 'Primera hipótesis';
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true,
        microphonePermission: 'granted', ...(recording ? { recording: true, sessionId: id, partial: state.voicePartial } : {}) };
      if (command.endsWith('start_voice')) { recording = true; return { ok: true, sessionId: id, maxDurationSeconds: 90 }; }
      if (command.endsWith('stop_voice')) { recording = false; return { ok: true, sessionId: args.sessionId, text: 'Texto final.', locale: 'es-MX', durationSeconds: 2,
        source: 'apple-speech-analyzer', segments: [{ text: 'Texto final.', startSeconds: 0.1, endSeconds: 1.8 }] }; }
      return previous(command, args);
    });
  });
  await page.goto('/');
  await page.locator('#prompt').fill('Borrador original');
  await page.locator('#dictate').click();
  await expect(page.locator('#voice-status')).toContainText('Primera hipótesis');
  await expect(page.locator('#prompt')).toHaveValue('Borrador original');
  await page.evaluate(() => (globalThis as any).voicePartial = 'Hipótesis corregida');
  await expect(page.locator('#voice-status')).toContainText('Hipótesis corregida');
  await page.locator('#dictate').click();
  await expect(page.locator('#prompt')).toHaveValue('Borrador original\nTexto final.');
  await expect(page.locator('#voice-status')).not.toContainText('Hipótesis corregida');
  expect(await page.evaluate(() => (globalThis as any).nativePrompts)).toEqual([]);
});

test('interrupted native capture exits recording and preserves its draft and retained audio', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    state.interruptedVoice = false; state.voiceStops = 0;
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true,
        microphonePermission: 'granted', ...(state.interruptedVoice ? { recording: false, readyToTranscribe: true, sessionId: id, previewIssue: 'Audio interrumpido.' } : {}) };
      if (command.endsWith('start_voice')) { state.interruptedVoice = true; return { ok: true, sessionId: id, maxDurationSeconds: 90 }; }
      if (command.endsWith('stop_voice')) { state.voiceStops++; return { ok: false, message: 'Audio interrumpido.' }; }
      return previous(command, args);
    });
  });
  await page.goto('/'); await page.locator('#prompt').fill('Conservado'); await page.locator('#dictate').click();
  await expect(page.locator('#voice-status')).toContainText('Audio interrumpido');
  await expect(page.locator('#dictate')).toHaveAccessibleName('Reintentar transcripción');
  await expect(page.locator('#prompt')).toHaveValue('Conservado');
  expect(await page.evaluate(() => (globalThis as any).voiceStops)).toBe(1);
});

test('a late provisional result cannot overwrite a completed dictation', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    let recording = false;
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice') && recording) return await new Promise(resolve => { state.finishOldPreview = resolve; });
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('start_voice')) { recording = true; return { ok: true, sessionId: id, maxDurationSeconds: 90 }; }
      if (command.endsWith('stop_voice')) { recording = false; return { ok: true, sessionId: args.sessionId, text: 'Final correcto.', locale: 'es-MX', durationSeconds: 2,
        source: 'apple-speech-analyzer', segments: [{ text: 'Final correcto.', startSeconds: 0.1, endSeconds: 1.8 }] }; }
      return previous(command, args);
    });
  });
  await page.goto('/'); await page.locator('#dictate').click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishOldPreview)).toBe('function');
  await page.locator('#dictate').click();
  await expect(page.locator('#prompt')).toHaveValue('Final correcto.');
  await page.evaluate(() => (globalThis as any).finishOldPreview({ available: true, status: 'available', assetsInstalled: true,
    recording: true, sessionId: '01234567-89ab-cdef-0123-456789abcdef', partial: 'resultado viejo' }));
  await expect(page.locator('#voice-status')).toBeEmpty();
  await expect(page.locator('#prompt')).toHaveValue('Final correcto.');
});

test('a temporary hidden web view during the microphone permission does not cancel the pending capture', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    state.voiceActions = [];
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'undetermined' };
      if (command.endsWith('start_voice')) { state.voiceActions.push('start'); return await new Promise(resolve => { state.finishPermission = resolve; }); }
      if (command.endsWith('cancel_voice')) state.voiceActions.push('cancel');
      if (command.endsWith('stop_voice')) return { ok: true, sessionId: args.sessionId, text: 'Transcripción de prueba.', locale: 'es-MX', durationSeconds: 2,
        source: 'apple-speech-analyzer', segments: [{ text: 'Transcripción de prueba.', startSeconds: 0.1, endSeconds: 1.8 }] };
      return previous(command, args);
    });
  });
  await page.goto('/'); await page.locator('#dictate').click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishPermission)).toBe('function');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.evaluate(() => (globalThis as any).finishPermission({ ok: true, sessionId: '01234567-89ab-cdef-0123-456789abcdef', maxDurationSeconds: 90 }));
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  expect(await page.evaluate(() => (globalThis as any).voiceActions)).toEqual(['start']);
  await page.locator('#dictate').click();
  await expect(page.locator('#prompt')).toHaveValue('Transcripción de prueba.');
});

test('a stuck microphone start can be cancelled and its late result does not cancel a newer recording', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke; let starts = 0;
    state.voiceActions = [];
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('start_voice')) {
        state.voiceActions.push('start');
        if (++starts === 1) return await new Promise(resolve => { state.finishOldVoice = resolve; });
        return { ok: true, sessionId: '01234567-89ab-cdef-0123-456789abcdef', maxDurationSeconds: 90 };
      }
      if (command.endsWith('cancel_voice')) state.voiceActions.push('cancel');
      if (command.endsWith('stop_voice')) return { ok: true, sessionId: args.sessionId, text: 'Nuevo dictado.', locale: 'es-MX', durationSeconds: 2,
        source: 'apple-speech-analyzer', segments: [{ text: 'Nuevo dictado.', startSeconds: 0, endSeconds: 1.8 }] };
      return previous(command, args);
    });
  });
  await page.goto('/'); await page.locator('#dictate').click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishOldVoice)).toBe('function');
  await expect(page.locator('#dictate')).toHaveAccessibleName('Cancelar dictado');
  await page.locator('#dictate').click();
  await expect(page.locator('#voice-status')).toContainText('cancelado');
  await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  await page.evaluate(() => (globalThis as any).finishOldVoice({ ok: true, sessionId: '01234567-89ab-cdef-0123-456789abcdef', maxDurationSeconds: 90 }));
  await expect.poll(() => page.evaluate(() => (globalThis as any).voiceActions)).toEqual(['start', 'cancel', 'start']);
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  await page.locator('#dictate').click();
  await expect(page.locator('#prompt')).toHaveValue('Nuevo dictado.');
});

test('native cancellation of a pending microphone request remains visible and can be retried', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke; let starts = 0;
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'undetermined' };
      if (command.endsWith('start_voice')) {
        if (++starts === 1) return await new Promise(resolve => { state.finishBackgroundedVoice = resolve; });
        return { ok: true, sessionId: '01234567-89ab-cdef-0123-456789abcdef', maxDurationSeconds: 90 };
      }
      return previous(command, args);
    });
  });
  await page.goto('/'); await page.locator('#dictate').click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishBackgroundedVoice)).toBe('function');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.evaluate(() => (globalThis as any).finishBackgroundedVoice({ ok: false, error: 'cancelled', message: 'Dictado cancelado al salir.' }));
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('#voice-status')).toContainText('cancelado al salir');
  await expect(page.locator('#dictate')).toHaveAccessibleName('Dictar');
  await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
});

test('a delayed cancellation is confirmed before a newer dictation starts', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    state.voiceOwners = []; state.cancelledOwners = [];
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('start_voice')) {
        state.activeVoiceOwner = args.ownerId; state.voiceOwners.push(args.ownerId);
        return { ok: true, sessionId: '01234567-89ab-cdef-0123-456789abcdef', maxDurationSeconds: 90 };
      }
      if (command.endsWith('cancel_voice')) {
        const captured = args.ownerId;
        await new Promise(resolve => { state.releaseOldCancel = resolve; });
        if (state.activeVoiceOwner === captured) state.cancelledOwners.push(captured);
        return { ok: true };
      }
      return previous(command, args);
    });
  });
  await page.goto('/'); await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  await page.locator('[data-panel="settings"]').click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).releaseOldCancel)).toBe('function');
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#dictate')).toBeDisabled();
  expect(await page.evaluate(() => (globalThis as any).voiceOwners)).toHaveLength(1);
  await page.evaluate(() => (globalThis as any).releaseOldCancel());
  await expect(page.locator('#dictate')).toBeEnabled();
  await expect(page.locator('#discard-voice')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.evaluate(() => { (globalThis as any).previousCancel = (globalThis as any).releaseOldCancel; });
  await page.locator('#discard-voice').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).releaseOldCancel !== (globalThis as any).previousCancel)).toBe(true);
  await page.evaluate(() => (globalThis as any).releaseOldCancel());
  await expect(page.locator('#discard-voice')).toBeHidden();
  await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  const ids = await page.evaluate(() => (globalThis as any).voiceOwners);
  expect(ids).toHaveLength(2); expect(ids[0]).toMatch(/^[a-f0-9-]{36}$/i); expect(ids[1]).not.toBe(ids[0]);
  // Explicitly discarding the retained audio fences the same old owner once
  // more; neither cancellation may target the newer recording.
  expect(await page.evaluate(() => (globalThis as any).cancelledOwners)).toEqual([ids[0], ids[0]]);
});

test('an interrupted recording does not leave a false recording indicator', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('start_voice')) return { ok: true, sessionId: '01234567-89ab-cdef-0123-456789abcdef', maxDurationSeconds: 90 };
      return previous(command, args);
    });
  });
  await page.goto('/');
  await page.locator('#dictate').click();
  await expect(page.locator('#voice-status')).toContainText('Escuchando');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('#dictate')).toHaveAccessibleName('Dictar');
  await expect(page.locator('#voice-status')).toContainText('se interrumpió');
});

test('linked stream, intermediate completion, error and reconnect remain honest', async ({ page }) => {
  let wireText = '';
  let sentCount = 0;
  let connection = 0;
  await page.routeWebSocket('wss://fixture.example/ws', ws => {
    let seq = 0;
    const send = (data: object) => ws.send(JSON.stringify({ seq: seq++, ...data }));
    connection++;
    ws.onMessage(raw => {
      const data = JSON.parse(String(raw));
      if (data.type === 'hello') send({ type: 'ready', agentState: 'idle', conversationId: 'c1' });
      if (data.type === 'get_history') send({ type: 'history', conversationId: 'c1', messages: wireText ? [
        { id: 'h1', role: 'user', text: wireText, activities: [] },
        { id: 'h2', role: 'assistant', text: 'Primera parte', activities: [] },
      ] : [] });
      if (data.type === 'send') {
        sentCount++; wireText = data.text;
        send({ type: 'user_message', messageId: 'm1', text: data.text });
        send({ type: 'agent_state', state: 'thinking' });
        send({ type: 'message_delta', messageId: 'm2', delta: 'Primera ' });
        send({ type: 'message_done', messageId: 'm2', text: 'Primera parte', intermediate: true });
        send({ type: 'message_done', messageId: 'm3', text: '', error: 'Error de prueba visible' });
        send({ type: 'agent_state', state: 'idle' });
      }
    });
  });
  await nativeFixture(page);
  await page.goto('/');
  await page.locator('[data-panel="chat"]').click();
  await page.locator('#prompt').fill('Contexto desde el iPhone');
  await page.locator('#send').click();
  await expect(page.locator('.chat-card[data-role="assistant"]')).toHaveCount(1);
  await openManualConnection(page);
  await page.locator('#url').fill('wss://fixture.example/ws');
  await page.locator('#token').fill('fixture-only');
  await page.locator('#connection button[type="submit"]').click();
  await expect(page.locator('#status')).toHaveText('Vinculado a Gentle Dot. Acceso guardado en Keychain.');
  await expect(page.locator('#token')).toHaveValue('');
  await chooseEngine(page, 'gentle');
  await page.locator('#prompt').fill('Continúa desde la laptop');
  await page.locator('#send').click();
  await expect(page.locator('#cards')).toContainText('Error de prueba visible');
  await expect(page.locator('#cards')).not.toContainText('Preparando respuesta');
  expect(wireText).toContain('Contexto desde el iPhone');
  const userCount = await page.locator('.chat-card[data-role="user"]').count();
  await openManualConnection(page);
  await page.locator('#disconnect').click();
  await page.locator('#token').fill('fixture-only');
  await page.locator('#connection button[type="submit"]').click();
  await expect.poll(() => connection).toBe(2);
  await page.locator('[data-panel="chat"]').click();
  // A historical ID and a live ID cannot be merged just because their text
  // matches. Keep both until the host provides a verified identity link.
  await expect(page.locator('.chat-card[data-role="user"]')).toHaveCount(userCount + 1);
  await expect(page.locator('#cards')).not.toContainText('Contexto reciente de Capri en el iPhone');
  expect(sentCount).toBe(1);
  const persisted = await page.evaluate(() => JSON.stringify(localStorage));
  expect(persisted).not.toContain('fixture-only');
});

test('character artwork persists; appearance and motion controls fit small and large text', async ({ page }, testInfo) => {
  // Image decoding and the real WebGL rig also run on software renderers in CI.
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 240; c.height = 420;
    const ctx = c.getContext('2d')!; ctx.fillStyle = '#ff408e'; ctx.fillRect(10, 10, 220, 400);
    return c.toDataURL().split(',')[1];
  });
  await page.locator('[data-panel="settings"]').click();
  await expect(page.locator('#panel-settings')).toBeVisible();
  await page.locator('#art').setInputFiles({ name: 'capri-test.png', mimeType: 'image/png', buffer: Buffer.from(png!, 'base64') });
  // Software WebGL can stall the browser task queue after the status is set.
  try { await expect(page.locator('#settings-status')).toHaveText('Arte guardado en este dispositivo.', { timeout: 20000 }); }
  catch (error) {
    console.log('Artwork selection failure', await page.evaluate(async () => ({
      fileCount: (document.querySelector('#art') as HTMLInputElement).files?.length,
      savedBytes: (await (await import('/src/local-state.ts' as string)).loadArtwork())?.size,
      status: document.getElementById('art-status')?.textContent,
      ready: document.getElementById('rig-handle')?.dataset.ready,
    })), errors);
    throw error;
  }
  await page.locator('#settings-character > summary').click();
  await page.locator('#motion').selectOption('reduced');
  await page.reload();
  const restored = await page.evaluate(async () => {
    const blob = await (await import('/src/local-state.ts' as string)).loadArtwork();
    if (!blob) return { missing: true };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image(); img.src = url; await img.decode();
      return { png: btoa(String.fromCharCode(...bytes)), width: img.naturalWidth, height: img.naturalHeight };
    } finally { URL.revokeObjectURL(url); }
  });
  await testInfo.attach('art-restoration.json', { body: JSON.stringify({ restored, errors }), contentType: 'application/json' });
  expect(restored).toEqual({ png, width: 240, height: 420 });
  await expect(page.locator('#motion')).toHaveValue('reduced');
  try {
    await expect(page.locator('#art-placeholder')).toBeHidden();
  } catch (error) {
    console.log('Art restoration failure', await page.evaluate(() => ({
      ready: document.readyState,
      settings: document.getElementById('settings-status')?.textContent,
      art: document.getElementById('art-status')?.textContent,
      conversation: document.getElementById('chat-notice')?.textContent,
      hidden: (document.getElementById('art-placeholder') as HTMLElement)?.hidden,
    })), errors);
    throw error;
  }
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#settings-character > summary').click();
  await page.getByText('Gestos y presencia', { exact: true }).click();
  await page.locator('#appear').click();
  await expect(page.locator('#rig-handle')).toBeDisabled();
  await page.locator('#appear').click();
  await expect(page.locator('#rig-handle')).toBeEnabled();
  for (const size of [{ width: 375, height: 812 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    for (const panel of ['settings', 'chat']) {
      await page.locator('[data-panel="' + panel + '"]').click();
      expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('body *')].filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1) && !node.closest('#stage');
      }).map(node => node.id || node.className || node.tagName))).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const button of await page.locator('.navigation button, .character-actions button:visible, .composer button:visible').all()) {
        const bounds = await button.boundingBox(); expect(bounds!.height).toBeGreaterThanOrEqual(44);
      }
      await page.screenshot({ path: testInfo.outputPath('layout-' + panel + '-' + size.width + '-200-percent.png'), fullPage: true });
    }
    await page.screenshot({ path: testInfo.outputPath(`layout-${size.width}-200-percent.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});

test('an old unverifiable receipt does not block chat recording while capacity remains', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = 'abcdef01-abcd-4bcd-8bcd-abcdef012345', text = 'Dictado anterior';
    const receipt = { schema: 'capri-native-voice-receipt/v1', audio: { id, owner: 'abcdef03-abcd-4bcd-8bcd-abcdef012345', destination: 'chat', locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) }, transcript: { sessionId: id, text, segments: [{ text, startSeconds: 0, endSeconds: 1 }], durationSeconds: 1, locale: 'es-MX', source: 'apple-speech-analyzer' } };
    state.oldVoiceReceipt = { receipt, releaseState: 'released' }; state.oldVoiceDeletes = 0;
    const retained = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('start_voice')) return { ok: true, sessionId: '12345678-1234-1234-1234-123456789012', maxDurationSeconds: 90 };
      return previous(command, args);
    });
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('list_voice_receipts')) return { ok: true, receipts: [state.oldVoiceReceipt] };
      if (command.endsWith('discard_voice_receipt')) { state.oldVoiceDeletes++; return { ok: true }; }
      return retained(command, args);
    };
  });
  await page.goto('/');
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => { const req = indexedDB.open('capri-ios-conversation', 1); req.onerror = () => reject(req.error); req.onsuccess = () => { const db = req.result, tx = db.transaction('conversation', 'readwrite'); tx.objectStore('conversation').put({ corrupt: true }, 'native-voice-delivery:v1:abcdef01-abcd-4bcd-8bcd-abcdef012345'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); }; });
  });
  await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  expect(await page.evaluate(() => (globalThis as any).oldVoiceDeletes)).toBe(0);
});

test('retained voice prepares its exact locale only on retry and cancellation fences late completion', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const record = { id: '12345678-1234-1234-1234-123456789012', owner: 'abcdef03-abcd-4bcd-8bcd-abcdef012345', destination: 'chat', locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) };
    state.savedAudio = record; state.assetCalls = []; state.assetArgs = undefined;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('inspect_retained_voice')) return { ok: true, retainedAudio: state.savedAudio };
      if (command.endsWith('list_voice_receipts')) return { ok: true, receipts: [] };
      if (command.endsWith('get_voice_receipt')) return { ok: true, receipt: null };
      if (command.endsWith('check_voice')) return { ok: true, available: false, status: 'assets_required', assetsInstalled: false, microphonePermission: 'granted', recording: false };
      if (command.endsWith('attach_retained_voice')) { state.assetCalls.push('attach'); return { ok: false, error: 'assets_required' }; }
      if (command.endsWith('prepare_retained_voice')) { state.assetCalls.push('prepare'); state.assetArgs = args; return await new Promise(resolve => { state.resolvePreparation = resolve; }); }
      if (command.endsWith('cancel_voice')) { state.assetCalls.push(['cancel', args.ownerId]); return { ok: true }; }
      if (command.endsWith('discard_retained_voice')) { state.assetCalls.push('discard'); state.savedAudio = null; return { ok: true }; }
      return previous(command, args);
    };
  });
  await page.goto('/'); await expect(page.locator('#dictate')).toHaveAccessibleName('Reintentar transcripción');
  expect(await page.evaluate(() => (globalThis as any).assetCalls)).toEqual([]);
  await page.locator('#dictate').click();
  await expect(page.locator('#voice-status')).toContainText('Necesitas internet');
  const args = await page.evaluate(() => (globalThis as any).assetArgs);
  expect(args.record).toEqual(await page.evaluate(() => (globalThis as any).savedAudio));
  expect(args.ownerId).not.toBe(args.record.owner);
  await expect(page.locator('#dictate')).toHaveAccessibleName('Cancelar preparación de voz');
  await page.locator('#dictate').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).assetCalls)).toContainEqual(['cancel', args.ownerId]);
  await page.evaluate(() => (globalThis as any).resolvePreparation({ok:true,available:true,status:'available',locale:'es-MX',assetsInstalled:true}));
  await expect(page.locator('#dictate')).toHaveAccessibleName('Reintentar transcripción');
  expect(await page.evaluate(() => (globalThis as any).savedAudio)).toEqual(args.record);
  expect(await page.evaluate(() => (globalThis as any).assetCalls.filter((x:any) => x === 'attach').length)).toBe(1);
  expect(await page.evaluate(() => (globalThis as any).assetCalls)).not.toContain('discard');
});

test('retained voice prepares its exact language then retries without losing audio on transcription failure', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const record = { id:'12345678-1234-1234-1234-123456789012', owner:'abcdef03-abcd-4bcd-8bcd-abcdef012345', destination:'chat', locale:'es-ES', kind:'dictation', createdAt:1, state:'ready', byteCount:10, sha256:'a'.repeat(64) };
    state.savedAudio = record; state.calls = []; state.prepared = false;
    state.__TAURI_INTERNALS__.invoke = async (command:string,args:any) => {
      if (command.endsWith('inspect_retained_voice')) return {ok:true,retainedAudio:state.savedAudio};
      if (command.endsWith('list_voice_receipts')) return {ok:true,receipts:[]};
      if (command.endsWith('get_voice_receipt')) return {ok:true,receipt:null};
      if (command.endsWith('check_voice')) return {available:true,status:'available',assetsInstalled:true,microphonePermission:'granted'};
      if (command.endsWith('attach_retained_voice')) { state.calls.push('attach'); return state.prepared ? {ok:true,retainedAudio:record,sessionId:record.id,ownerId:args.ownerId} : {ok:false,error:'assets_required'}; }
      if (command.endsWith('prepare_retained_voice')) { state.calls.push(['prepare',args]); state.prepared=true; return {ok:true,available:true,status:'available',locale:record.locale,assetsInstalled:true}; }
      if (command.endsWith('stop_voice')) { state.calls.push('stop'); return {ok:false,message:'Transcripción incompleta'}; }
      if (command.endsWith('discard_retained_voice') || command.endsWith('release_retained_voice')) { state.calls.push('delete'); return {ok:true}; }
      return previous(command,args);
    };
  });
  await page.goto('/'); await expect(page.locator('#dictate')).toHaveAccessibleName('Reintentar transcripción');
  expect(await page.evaluate(() => (globalThis as any).calls)).toEqual([]);
  await page.locator('#dictate').click();
  await expect(page.locator('#voice-status')).toContainText('Transcripción incompleta');
  await expect(page.locator('#dictate')).toHaveAccessibleName('Reintentar transcripción');
  const state = await page.evaluate(() => ({calls:(globalThis as any).calls,audio:(globalThis as any).savedAudio}));
  expect(state.calls.map((x:any) => Array.isArray(x) ? x[0] : x)).toEqual(['attach','prepare','attach','stop']);
  expect(state.calls[1][1].record).toEqual(state.audio); expect(state.audio.locale).toBe('es-ES'); expect(state.audio.kind).toBe('dictation');
  await page.locator('[data-panel="settings"]').click();
  expect(await page.evaluate(() => (globalThis as any).calls)).not.toContain('delete');
});

test('audit cancelling retained preparation must not claim the microphone is recording', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const record = { id: '12345678-1234-1234-1234-123456789012', owner: 'abcdef03-abcd-4bcd-8bcd-abcdef012345', destination: 'chat', locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) };
    state.savedAudio = record; state.assetCalls = []; state.assetArgs = undefined;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('inspect_retained_voice')) return { ok: true, retainedAudio: state.savedAudio };
      if (command.endsWith('list_voice_receipts')) return { ok: true, receipts: [] };
      if (command.endsWith('get_voice_receipt')) return { ok: true, receipt: null };
      if (command.endsWith('check_voice')) return { ok: true, available: false, status: 'assets_required', assetsInstalled: false, microphonePermission: 'granted', recording: false };
      if (command.endsWith('attach_retained_voice')) { state.assetCalls.push('attach'); return { ok: false, error: 'assets_required' }; }
      if (command.endsWith('prepare_retained_voice')) { state.assetCalls.push('prepare'); state.assetArgs = args; return await new Promise(resolve => { state.resolvePreparation = resolve; }); }
      if (command.endsWith('cancel_voice')) { state.assetCalls.push(['cancel', args.ownerId]); return await new Promise(resolve => { state.resolveCancellation = resolve; }); }
      if (command.endsWith('discard_retained_voice')) { state.assetCalls.push('discard'); state.savedAudio = null; return { ok: true }; }
      return previous(command, args);
    };
  });
  await page.goto('/'); await expect(page.locator('#dictate')).toHaveAccessibleName('Reintentar transcripción');
  expect(await page.evaluate(() => (globalThis as any).assetCalls)).toEqual([]);
  await page.locator('#dictate').click();
  await expect(page.locator('#voice-status')).toContainText('Necesitas internet');
  const args = await page.evaluate(() => (globalThis as any).assetArgs);
  expect(args.record).toEqual(await page.evaluate(() => (globalThis as any).savedAudio));
  expect(args.ownerId).not.toBe(args.record.owner);
  await expect(page.locator('#dictate')).toHaveAccessibleName('Cancelar preparación de voz');
  await page.locator('#dictate').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).assetCalls)).toContainEqual(['cancel', args.ownerId]);
  await expect(page.locator('#voice-status')).not.toContainText('micrófono');
  await page.evaluate(() => (globalThis as any).resolveCancellation({ok:true}));
  await page.evaluate(() => (globalThis as any).resolvePreparation({ok:true,available:true,status:'available',locale:'es-MX',assetsInstalled:true}));
  await expect(page.locator('#dictate')).toHaveAccessibleName('Reintentar transcripción');
  expect(await page.evaluate(() => (globalThis as any).savedAudio)).toEqual(args.record);
  expect(await page.evaluate(() => (globalThis as any).assetCalls.filter((x:any) => x === 'attach').length)).toBe(1);
  expect(await page.evaluate(() => (globalThis as any).assetCalls)).not.toContain('discard');
});

test('a ready retained recording remains recoverable after its capture owner was cancelled', async ({page}) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const record = { id:'12345678-1234-1234-1234-123456789012', owner:'abcdef03-abcd-4bcd-8bcd-abcdef012345', destination:'chat', locale:'es-MX', kind:'speech', createdAt:1, state:'ready', byteCount:10, sha256:'a'.repeat(64) };
    const text='Audio recuperado';
    const transcript={sessionId:record.id,source:'apple-speech-analyzer',locale:record.locale,durationSeconds:1,text,segments:[{text,startSeconds:0,endSeconds:1}]};
    state.cancelledOwners = [record.owner]; state.savedAudio=record; state.receipt=null; state.ownerCalls=[];
    state.__TAURI_INTERNALS__.invoke = async (command:string,args:any) => {
      if (command.endsWith('inspect_retained_voice')) return {ok:true,retainedAudio:state.savedAudio};
      if (command.endsWith('list_voice_receipts')) return {ok:true,receipts:state.receipt ? [state.receipt] : []};
      if (command.endsWith('get_voice_receipt')) return {ok:true,receipt:state.receipt};
      if (command.endsWith('check_voice')) return {available:true,status:'available',assetsInstalled:true,microphonePermission:'granted', ...(state.activeRecoveryOwner ? {sessionId:record.id,ownerId:state.activeRecoveryOwner,retainedAudio:record} : {})};
      if (command.endsWith('cancel_voice')) { if (args.ownerId === state.activeRecoveryOwner) state.activeRecoveryOwner=null; state.cancelledOwners.push(args.ownerId); return {ok:true}; }
      if (command.endsWith('release_retained_voice')) { state.receipt.releaseState='released'; state.savedAudio=null; return {ok:true,releaseState:'released'}; }
      if (command.endsWith('discard_voice_receipt')) { state.receipt=null; return {ok:true}; }
      if (command.endsWith('attach_retained_voice')) {
        const op=args.ownerId ?? args.record.owner; state.ownerCalls.push(['attach',op]);
        if (state.cancelledOwners.includes(op)) return {ok:false,error:'retention_unavailable'};
        state.activeRecoveryOwner=op; return {ok:true,retainedAudio:record,sessionId:record.id,ownerId:op};
      }
      if (command.endsWith('stop_voice')) {
        state.ownerCalls.push(['stop',args.operationOwnerId]);
        if (args.operationOwnerId !== state.activeRecoveryOwner || args.ownerId !== record.owner) return {ok:false,error:'invalid_voice_retention'};
        state.receipt={receipt:{schema:'capri-native-voice-receipt/v1',audio:record,transcript},releaseState:'retained'};
        return {ok:true,...transcript,retainedAudio:record};
      }
      return previous(command,args);
    };
  });
  await page.goto('/'); await expect(page.locator('#dictate')).toHaveAccessibleName('Reintentar transcripción');
  await page.locator('#dictate').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).ownerCalls.length)).toBeGreaterThan(0);
  const calls=await page.evaluate(() => (globalThis as any).ownerCalls);
  expect(calls[0][1]).not.toBe('abcdef03-abcd-4bcd-8bcd-abcdef012345');
  await expect(page.locator('#prompt')).toHaveValue('Audio recuperado');
  const final=await page.evaluate(() => (globalThis as any).ownerCalls); expect(final[1][1]).toBe(final[0][1]);
});
