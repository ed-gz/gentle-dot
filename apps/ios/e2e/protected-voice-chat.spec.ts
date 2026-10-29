import { expect, test, type Page } from './fixtures.ts';

async function native(page: Page, text: string, loseStop = false) {
  await page.addInitScript(({ text, loseStop }) => {
    const g = globalThis as any; g.isTauri = true; const key = 'protected-voice-fixture';
    const load = () => JSON.parse(sessionStorage.getItem(key) || '{"record":null,"receipt":null,"lossUsed":false}');
    const save = (v: any) => sessionStorage.setItem(key, JSON.stringify(v));
    g.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any = {}) => {
      const state = load();
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('results_list') || command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('check_voice')) return { ok: true, available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted', ...(state.record && state.activeOwner && !state.discardPending ? { sessionId: state.record.id, ownerId: state.activeOwner, retainedAudio: state.record, recoveryPending: true } : {}) };
      if (command.endsWith('inspect_retained_voice')) return state.discardPending ? { ok: true, discardPending: state.record } : { ok: true, retainedAudio: state.record };
      if (command.endsWith('list_voice_receipts')) return { ok: true, receipts: state.receipt ? [state.receipt] : [] };
      if (command.endsWith('get_voice_receipt')) return { ok: true, receipt: state.receipt?.receipt.audio.id.toLowerCase() === args.sessionId.toLowerCase() ? state.receipt : null };
      if (command.endsWith('start_voice')) {
        const id = 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345';
        if (state.record) throw new Error('occupied');
        state.record = { id, owner: args.ownerId, destination: args.retainDestination, locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'capturing' }; state.activeOwner = args.ownerId; save(state);
        return { ok: true, sessionId: id, maxDurationSeconds: 90, retainedAudio: state.record };
      }
      if (command.endsWith('stop_voice')) {
        if (state.previewPendingOnce && !state.previewUsed) { state.previewUsed = true; save(state); return { ok: false, error: 'preview_pending', sessionId: args.sessionId, message: 'Audio pendiente.' }; }
        state.record = { ...state.record, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) };
        const transcript = { sessionId: args.sessionId, text, segments: [{ text, startSeconds: 0, endSeconds: 1 }], durationSeconds: 1, locale: 'es-MX', source: 'apple-speech-analyzer' };
        state.receipt = { receipt: { schema: 'capri-native-voice-receipt/v1', audio: state.record, transcript }, releaseState: 'retained' };
        if (loseStop && !state.lossUsed) { state.lossUsed = true; save(state); throw new Error('callback lost'); }
        save(state); return { ok: true, ...transcript, retainedAudio: state.record };
      }
      if (command.endsWith('cancel_voice')) { if (args.ownerId === state.activeOwner) { state.activeOwner = null; save(state); } return { ok: true }; }
      if (command.endsWith('release_retained_voice')) { if (state.failRelease) return { ok: false, error: 'receipt_unavailable' }; if (JSON.stringify(args.receipt) !== JSON.stringify(state.receipt?.receipt)) throw new Error('identity'); state.receipt.releaseState = 'released'; state.lastRelease = true; state.record = null; save(state); return { ok: true, releaseState: 'released' }; }
      if (command.endsWith('discard_voice_receipt')) { if (JSON.stringify(args.receipt) !== JSON.stringify(state.receipt?.receipt) || state.receipt.releaseState !== 'released') throw new Error('identity'); state.receipt = null; state.cleaned = true; save(state); return { ok: true }; }
      if (command.endsWith('discard_retained_voice')) { state.record = null; state.discardPending = false; save(state); return { ok: true }; }
      return { ok: true };
    } };
  }, { text, loseStop });
}

test('short dictation commits text and identity, releases audio, and does not reinsert after reload', async ({ page }) => {
  await native(page, 'Dictado breve'); await page.goto('/'); await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#prompt').fill('Escrito antes'); await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado'); await page.locator('#dictate').click();
  await expect(page.locator('#prompt')).toHaveValue('Escrito antes\nDictado breve');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('protected-voice-fixture')!).lastRelease)).toBe(true);
  await page.reload(); await expect(page.locator('#prompt')).toHaveValue('Escrito antes\nDictado breve');
  await expect(page.getByRole('button', { name: 'Revisar dictado' })).toBeHidden();
});

test('pagehide fences the chat microphone once and preserves the retained recording', async ({ page }) => {
  await native(page, 'Sin enviar'); await page.goto('/'); await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#dictate').click(); await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  await page.evaluate(() => { const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke; state.chatPagehideCancels = [];
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => { if (command.endsWith('cancel_voice')) state.chatPagehideCancels.push(args.ownerId); return previous(command, args); }; });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect.poll(() => page.evaluate(() => (globalThis as any).chatPagehideCancels.length)).toBe(1);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (globalThis as any).chatPagehideCancels.length)).toBe(1);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('protected-voice-fixture')!).record?.state)).toBe('capturing');
  await expect(page.locator('#prompt')).toHaveValue('');
});

test('an interrupted authorized discard can be retried without presenting audio as transcribable', async ({ page }) => {
  await native(page, 'Sin uso'); await page.goto('/');
  await page.evaluate(() => { const state = { record: { id: 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345', owner: 'abcdef02-abcd-4bcd-8bcd-abcdef012345', destination: 'chat', locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'capturing' }, receipt: null, lossUsed: false, discardPending: true }; sessionStorage.setItem('protected-voice-fixture', JSON.stringify(state)); });
  await page.reload();
  const retry = page.getByRole('button', { name: 'Reintentar eliminación' });
  await expect(retry).toBeVisible(); await expect(page.locator('#dictate')).not.toHaveAccessibleName('Reintentar transcripción');
  page.on('dialog', dialog => { void dialog.dismiss(); throw new Error('No second confirmation is needed'); });
  await retry.click(); await expect(page.locator('#voice-status')).toHaveText('Audio eliminado.');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('protected-voice-fixture')!).discardPending)).toBe(false);
});

test('a retryable live capture stays retryable after navigating away and back', async ({ page }) => {
  await native(page, 'Reintento correcto'); await page.goto('/'); await expect(page.locator('#send')).toBeEnabled();
  await page.evaluate(() => { const state = JSON.parse(sessionStorage.getItem('protected-voice-fixture') || '{"record":null,"receipt":null,"lossUsed":false}'); state.previewPendingOnce = true; sessionStorage.setItem('protected-voice-fixture', JSON.stringify(state)); });
  await page.locator('#dictate').click(); await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado'); await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Reintentar transcripción');
  await page.locator('[data-panel="settings"]').click(); await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Reintentar transcripción');
  await page.locator('#dictate').click(); await expect(page.locator('#prompt')).toHaveValue('Reintento correcto');
});

test('long dictation remains complete in contextual recovery without overwriting the draft', async ({ page }) => {
  await native(page, 'L'.repeat(12000)); await page.goto('/'); await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#prompt').fill('Texto anterior'); await page.locator('#dictate').click();
  await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado'); await page.locator('#dictate').click();
  await expect(page.getByRole('button', { name: 'Revisar dictado' })).toBeVisible();
  await expect(page.locator('#prompt')).toHaveValue('Texto anterior');
  await page.getByRole('button', { name: 'Revisar dictado' }).click(); await page.getByText('Dictado guardado').click();
  await expect(page.locator('.voice-receipt-text')).toHaveText('L'.repeat(12000));
  await expect(page.getByRole('button', { name: 'Añadir al mensaje' })).toBeDisabled();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('protected-voice-fixture')!).record?.state)).toBe('ready');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Eliminar audio' }).click();
  const manual = await page.evaluate(() => JSON.parse(sessionStorage.getItem('protected-voice-fixture')!));
  expect(manual.record).toBeNull(); expect(manual.receipt.receipt.transcript.text).toHaveLength(12000);
});

test('a lost completion callback recovers the exact transcript without retranscribing', async ({ page }) => {
  await native(page, 'Texto recuperado', true); await page.goto('/'); await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#dictate').click(); await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  await page.locator('#dictate').click(); await expect(page.locator('#dictate')).toHaveAccessibleName('Reintentar transcripción');
  await page.locator('#dictate').click(); await expect(page.locator('#prompt')).toHaveValue('Texto recuperado');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('protected-voice-fixture')!).lastRelease)).toBe(true);
});

test('restart after a lost callback presents the saved transcript once for explicit recovery', async ({ page }) => {
  await native(page, 'Texto guardado tras cierre', true); await page.goto('/'); await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#dictate').click(); await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado');
  await page.locator('#dictate').click(); await expect(page.locator('#dictate')).toHaveAccessibleName('Reintentar transcripción');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Revisar dictado' })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('protected-voice-fixture')!).record?.state)).toBe('ready');
  await page.getByRole('button', { name: 'Revisar dictado' }).click(); await page.getByText('Dictado guardado').click();
  await page.getByRole('button', { name: 'Añadir al mensaje' }).click();
  await expect(page.locator('#prompt')).toHaveValue('Texto guardado tras cierre');
  await page.reload(); await expect(page.locator('#prompt')).toHaveValue('Texto guardado tras cierre');
  await expect(page.getByRole('button', { name: 'Revisar dictado' })).toBeHidden();
});

test('a failed voice checkpoint resumes with its delivery marker after reopening', async ({ page }) => {
  await native(page, 'Dictado protegido'); await page.goto('/'); await expect(page.locator('#send')).toBeEnabled();
  await page.evaluate(async () => { (await import('/src/conversation-archive.ts')).conversationArchive.upsert = async () => { throw new Error('Cuota simulada'); }; });
  await page.locator('#dictate').click(); await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado'); await page.locator('#dictate').click();
  await expect(page.getByRole('button', { name: 'Revisar dictado' })).toBeVisible();
  const reservation = await page.evaluate(async () => (await (await import('/src/conversation-journal.ts')).createConversationJournal().pending()));
  expect(reservation?.voiceDelivery?.transcript).toBe('Dictado protegido');
  const retained = await page.evaluate(() => JSON.parse(sessionStorage.getItem('protected-voice-fixture')!));
  expect(retained.record.state).toBe('ready'); expect(retained.receipt.releaseState).toBe('retained'); expect(retained.lastRelease).toBeUndefined();
  await page.reload();
  await expect(page.locator('#prompt')).toHaveValue('Dictado protegido');
  await expect(page.getByRole('button', { name: 'Revisar dictado' })).toBeHidden();
  await expect.poll(async () => page.evaluate(async () => (await (await import('/src/conversation-journal.ts')).createConversationJournal().pending()) === undefined)).toBe(true);
});

test('a delivered transcript with unconfirmed audio release remains reviewable without a duplicate insert', async ({ page }) => {
  await native(page, 'Dictado guardado'); await page.goto('/'); await expect(page.locator('#send')).toBeEnabled();
  await page.evaluate(() => { const state = JSON.parse(sessionStorage.getItem('protected-voice-fixture') || '{"record":null,"receipt":null,"lossUsed":false}'); state.failRelease = true; sessionStorage.setItem('protected-voice-fixture', JSON.stringify(state)); });
  await page.locator('#dictate').click(); await expect(page.locator('#dictate')).toHaveAccessibleName('Terminar dictado'); await page.locator('#dictate').click();
  await expect(page.locator('#prompt')).toHaveValue('Dictado guardado');
  await expect(page.getByRole('button', { name: 'Revisar dictado' })).toBeVisible();
  await page.getByRole('button', { name: 'Revisar dictado' }).click(); await page.locator('summary').filter({ hasText: 'Dictado guardado' }).click();
  await expect(page.getByRole('button', { name: 'Añadir al mensaje' })).toBeHidden();
  await page.evaluate(() => { const state = JSON.parse(sessionStorage.getItem('protected-voice-fixture')!); state.failRelease = false; sessionStorage.setItem('protected-voice-fixture', JSON.stringify(state)); });
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Eliminar audio' }).click();
  await expect(page.getByRole('button', { name: 'Revisar dictado' })).toBeHidden();
  await page.locator('[data-panel="chat"]').click(); await expect(page.locator('#prompt')).toHaveValue('Dictado guardado');
});
