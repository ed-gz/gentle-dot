import { expect, test } from './fixtures.ts';

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
      if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('agent_step')) {
        state.nativePrompts.push(args.prompt);
        if (delayed) return await new Promise(resolve => { state.finishNative = resolve; });
        return { ok: true, decision: state.nativeDecisions.shift() ?? { kind: 'answer', text: 'Respuesta local de prueba <b>literal</b>.', toolName: '', argumentsJSON: '{}' } };
      }
      return { ok: true };
    } };
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
  await page.locator('[data-panel="inbox"]').click();
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
  await expect(page.locator('.chat-card[data-role="user"]')).toHaveCount(2);
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

test('voice fixture prepares assets on microphone tap and appends dictation without sending', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any;
    const previous = state.__TAURI_INTERNALS__.invoke;
    let prepared = false;
    state.voiceActions = [];
    const availability = () => ({ ok: true, available: prepared, status: prepared ? 'available' : 'assets_required', assetsInstalled: prepared, locale: 'es-MX', microphonePermission: 'granted' });
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return availability();
      if (command.endsWith('prepare_voice')) { state.voiceActions.push('prepare'); prepared = true; return availability(); }
      if (command.endsWith('start_voice')) { state.voiceActions.push('start'); return { ok: true, sessionId: '01234567-89ab-cdef-0123-456789abcdef', maxDurationSeconds: 90 }; }
      if (command.endsWith('stop_voice')) {
        state.voiceActions.push('stop');
        return { ok: true, sessionId: args.sessionId, text: 'Añade evidencia del error.', locale: 'es-MX', durationSeconds: 2,
          source: 'apple-speech-analyzer', segments: [{ text: 'Añade evidencia del error.', startSeconds: 0.1, endSeconds: 1.8 }] };
      }
      return previous(command, args);
    };
  });
  await page.goto('/');
  await page.locator('#prompt').fill('Borrador existente.');
  await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  await expect(page.locator('#voice-status')).toContainText('Grabando');
  expect(await page.evaluate(() => (globalThis as any).voiceActions)).toEqual(['prepare', 'start']);
  await page.locator('#dictate').click();
  await expect(page.locator('#prompt')).toHaveValue('Borrador existente.\nAñade evidencia del error.');
  await expect(page.locator('#voice-status')).toContainText('Puedes corregirla antes de enviar.');
  await expect(page.locator('.chat-card[data-role="user"]')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as any).nativePrompts)).toEqual([]);
  expect(await page.evaluate(() => (globalThis as any).voiceActions)).toEqual(['prepare', 'start', 'stop']);
});

test('provisional live dictation stays separate from the draft until one final result', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    let recording = false;
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    state.voicePartial = 'Primera hipótesis';
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true,
        microphonePermission: 'granted', ...(recording ? { recording: true, sessionId: id, partial: state.voicePartial } : {}) };
      if (command.endsWith('start_voice')) { recording = true; return { ok: true, sessionId: id, maxDurationSeconds: 90 }; }
      if (command.endsWith('stop_voice')) { recording = false; return { ok: true, sessionId: args.sessionId, text: 'Texto final.', locale: 'es-MX', durationSeconds: 2,
        source: 'apple-speech-analyzer', segments: [{ text: 'Texto final.', startSeconds: 0.1, endSeconds: 1.8 }] }; }
      return previous(command, args);
    };
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

test('interrupted native capture exits recording and reports the loss without a draft', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    state.interruptedVoice = false; state.voiceStops = 0;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true,
        microphonePermission: 'granted', ...(state.interruptedVoice ? { recording: false, readyToTranscribe: true, sessionId: id, previewIssue: 'Audio interrumpido.' } : {}) };
      if (command.endsWith('start_voice')) { state.interruptedVoice = true; return { ok: true, sessionId: id, maxDurationSeconds: 90 }; }
      if (command.endsWith('stop_voice')) { state.voiceStops++; return { ok: false, message: 'Audio interrumpido.' }; }
      return previous(command, args);
    };
  });
  await page.goto('/'); await page.locator('#prompt').fill('Conservado'); await page.locator('#dictate').click();
  await expect(page.locator('#voice-status')).toContainText('Audio interrumpido');
  await expect(page.locator('#dictate')).toHaveAccessibleName('Dictar');
  await expect(page.locator('#prompt')).toHaveValue('Conservado');
  expect(await page.evaluate(() => (globalThis as any).voiceStops)).toBe(1);
});

test('a late provisional result cannot overwrite a completed dictation', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    let recording = false;
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('check_voice') && recording) return await new Promise(resolve => { state.finishOldPreview = resolve; });
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('start_voice')) { recording = true; return { ok: true, sessionId: id, maxDurationSeconds: 90 }; }
      if (command.endsWith('stop_voice')) { recording = false; return { ok: true, sessionId: args.sessionId, text: 'Final correcto.', locale: 'es-MX', durationSeconds: 2,
        source: 'apple-speech-analyzer', segments: [{ text: 'Final correcto.', startSeconds: 0.1, endSeconds: 1.8 }] }; }
      return previous(command, args);
    };
  });
  await page.goto('/'); await page.locator('#dictate').click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishOldPreview)).toBe('function');
  await page.locator('#dictate').click();
  await expect(page.locator('#prompt')).toHaveValue('Final correcto.');
  await page.evaluate(() => (globalThis as any).finishOldPreview({ available: true, status: 'available', assetsInstalled: true,
    recording: true, sessionId: '01234567-89ab-cdef-0123-456789abcdef', partial: 'resultado viejo' }));
  await expect(page.locator('#voice-status')).toContainText('Transcripción añadida');
  await expect(page.locator('#prompt')).toHaveValue('Final correcto.');
});

test('a temporary hidden web view during the microphone permission does not cancel the pending capture', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    state.voiceActions = [];
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'undetermined' };
      if (command.endsWith('start_voice')) { state.voiceActions.push('start'); return await new Promise(resolve => { state.finishPermission = resolve; }); }
      if (command.endsWith('cancel_voice')) state.voiceActions.push('cancel');
      if (command.endsWith('stop_voice')) return { ok: true, sessionId: args.sessionId, text: 'Transcripción de prueba.', locale: 'es-MX', durationSeconds: 2,
        source: 'apple-speech-analyzer', segments: [{ text: 'Transcripción de prueba.', startSeconds: 0.1, endSeconds: 1.8 }] };
      return previous(command, args);
    };
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
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
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
    };
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
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'undetermined' };
      if (command.endsWith('start_voice')) {
        if (++starts === 1) return await new Promise(resolve => { state.finishBackgroundedVoice = resolve; });
        return { ok: true, sessionId: '01234567-89ab-cdef-0123-456789abcdef', maxDurationSeconds: 90 };
      }
      return previous(command, args);
    };
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

test('a delayed old cancellation cannot stop a newer dictation', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    state.voiceOwners = []; state.cancelledCurrent = false;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('start_voice')) {
        state.activeVoiceOwner = args.ownerId; state.voiceOwners.push(args.ownerId);
        return { ok: true, sessionId: '01234567-89ab-cdef-0123-456789abcdef', maxDurationSeconds: 90 };
      }
      if (command.endsWith('cancel_voice')) {
        const captured = args.ownerId;
        await new Promise(resolve => { state.releaseOldCancel = resolve; });
        if (state.activeVoiceOwner === captured) state.cancelledCurrent = true;
        return { ok: true };
      }
      return previous(command, args);
    };
  });
  await page.goto('/'); await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  await page.locator('[data-panel="settings"]').click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).releaseOldCancel)).toBe('function');
  await page.locator('[data-panel="chat"]').click(); await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  await page.evaluate(() => (globalThis as any).releaseOldCancel());
  expect(await page.evaluate(() => (globalThis as any).cancelledCurrent)).toBe(false);
  const ids = await page.evaluate(() => (globalThis as any).voiceOwners);
  expect(ids).toHaveLength(2); expect(ids[0]).toMatch(/^[a-f0-9-]{36}$/i); expect(ids[1]).not.toBe(ids[0]);
});

test('an interrupted recording does not leave a false recording indicator', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('start_voice')) return { ok: true, sessionId: '01234567-89ab-cdef-0123-456789abcdef', maxDurationSeconds: 90 };
      return previous(command, args);
    };
  });
  await page.goto('/');
  await page.locator('#dictate').click();
  await expect(page.locator('#voice-status')).toContainText('Grabando');
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
  await expect(page.locator('#status')).toHaveText('Vinculado a Gentle Dot');
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
  await expect(page.locator('.chat-card[data-role="user"]')).toHaveCount(userCount);
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
  await page.locator('#art').setInputFiles({ name: 'capri-test.png', mimeType: 'image/png', buffer: Buffer.from(png!, 'base64') });
  await expect(page.locator('#settings-status')).toHaveText('Arte guardado en este dispositivo.');
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
