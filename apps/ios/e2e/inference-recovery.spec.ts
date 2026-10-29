import { expect, test, openRecoveryHarness, type Page } from './fixtures.ts';

const turn = 'd3dba896-4b5c-4c1c-98c9-4e60238fe6b9';
const revision = 'a3dba896-4b5c-4c1c-98c9-4e60238fe6b9';
const response = 'Respuesta terminada antes de cerrar Capri.';

type FixtureRecord = { id: string; revision: string; startedAt: number; status: string; text: string };

async function setup(page: Page) {
  await page.addInitScript(() => {
    const state = globalThis as any;
    state.isTauri = true;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('results_list')) return { ok: true, items: JSON.parse(sessionStorage.getItem('fixture-journal') || '[]'), activeId: sessionStorage.getItem('fixture-active') };
      if (command.endsWith('cancel')) {
        const journal = JSON.parse(sessionStorage.getItem('fixture-journal') || '[]');
        const item = journal.find((candidate: any) => candidate.id === args?.turnId);
        if (item) { item.status = 'cancelled'; item.text = 'Respuesta cancelada.'; }
        sessionStorage.setItem('fixture-journal', JSON.stringify(journal)); sessionStorage.removeItem('fixture-active');
        return { ok: true };
      }
      if (command.endsWith('results_acknowledge')) {
        const { loadConversation } = await import('/src/conversation.ts' as string);
        const { conversationArchive } = await import('/src/conversation-archive.ts' as string);
        const conversation = await loadConversation();
        const entry = conversation.entries.find((item: any) => item.id === args.turnId);
        const archived = await conversationArchive.load(JSON.stringify(['iphone', 'iphone:main', args.turnId]));
        const events = JSON.parse(sessionStorage.getItem('fixture-events') || '[]');
        events.push({ action: 'ack', args, entry, archived });
        sessionStorage.setItem('fixture-events', JSON.stringify(events));
        const journal = JSON.parse(sessionStorage.getItem('fixture-journal') || '[]');
        sessionStorage.setItem('fixture-journal', JSON.stringify(journal.filter((item: any) => !(item.id === args.turnId && item.revision === args.revision))));
        return { ok: true };
      }
      if (command.endsWith('agent_step')) {
        const events = JSON.parse(sessionStorage.getItem('fixture-events') || '[]');
        events.push({ action: 'agent_step' }); sessionStorage.setItem('fixture-events', JSON.stringify(events));
        return { ok: true, decision: { kind: 'answer', text: 'Nueva respuesta', toolName: '', argumentsJSON: '{}' } };
      }
      return { ok: true };
    } };
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (names: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
      if (sessionStorage.getItem('fixture-block-writes') === 'yes' && mode === 'readwrite'
          && (this.name === 'capri-ios-conversation' || this.name === 'capri-ios-conversation-archive')) {
        throw new DOMException('Simulated disk write failure', 'QuotaExceededError');
      }
      return Reflect.apply(transaction, this, options ? [names, mode, options] : mode ? [names, mode] : [names]);
    };
  });
  await page.goto('/');
  await expect(page.locator('#send')).toBeEnabled();
}

async function seed(page: Page, record: FixtureRecord, cancelled = false) {
  await page.evaluate(async ({ record, cancelled }) => {
    const { saveConversation } = await import('/src/conversation.ts' as string);
    await saveConversation({ revision: 1000, draft: 'Borrador intacto', entries: [
      { id: 'original-user', role: 'user', text: 'Ayúdame con este trabajo.', engine: 'iphone', state: 'complete', at: 1233 },
      { id: record.id, role: 'assistant', text: cancelled ? 'Respuesta interrumpida.' : '', engine: 'iphone', state: 'pending', at: 1234,
        ...(cancelled ? { state: 'interrupted', localCancelled: true } : {}),
        activities: [{ id: 'receipt-1', kind: 'other', title: 'Trabajo guardado', status: 'done', detail: 'Recibo comprobado' }] },
    ] });
    sessionStorage.setItem('fixture-journal', JSON.stringify([record]));
    sessionStorage.setItem('fixture-events', '[]');
  }, { record, cancelled });
}

const answer: FixtureRecord = { id: turn, revision, startedAt: 1234, status: 'answer', text: response };

test('restart restores one completed answer and ACK observes both committed stores', async ({ page }) => {
  await setup(page); await seed(page, answer); await page.reload();
  await expect(page.locator('#cards')).toContainText(response);
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-events') || '[]').length)).toBe(1);
  const state = await page.evaluate(() => ({ events: JSON.parse(sessionStorage.getItem('fixture-events') || '[]'), journal: sessionStorage.getItem('fixture-journal') }));
  expect(state.events).toHaveLength(1);
  expect(state.events[0]).toMatchObject({ action: 'ack', args: { turnId: turn, revision }, entry: { id: turn, state: 'complete', text: response }, archived: { id: turn, state: 'complete', text: response } });
  expect(state.events[0].entry.activities[0].detail).toBe('Recibo comprobado');
  expect(JSON.parse(state.journal!)).toEqual([]);
  await page.reload(); await expect(page.locator('#cards')).toContainText(response);
  expect(await page.locator('.chat-card').filter({ hasText: response }).count()).toBe(1);
  expect(await page.locator('#prompt')).toHaveValue('Borrador intacto');
});

test('failed persistence keeps the native copy and sends no ACK', async ({ page }) => {
  await setup(page); await seed(page, answer);
  await page.evaluate(() => sessionStorage.setItem('fixture-block-writes', 'yes'));
  await page.reload();
  await expect(page.locator('#retry-conversation')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-events') || '[]'))).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-journal') || '[]'))).toEqual([answer]);
  await expect(page.locator('#send')).toBeDisabled();
  await page.evaluate(() => sessionStorage.removeItem('fixture-block-writes'));
  await page.locator('#retry-conversation').click();
  await expect(page.locator('#cards')).toContainText(response);
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-journal') || '[]'))).toEqual([]);
  await expect(page.locator('#send')).toBeEnabled();
});

test('a changed durable archive prevents ACK until the exact answer is verified', async ({ page }) => {
  await setup(page); await seed(page, answer);
  await page.addInitScript(() => {
    const state = globalThis as any, originalInvoke = state.__TAURI_INTERNALS__.invoke;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command.endsWith('results_list') && !state.archiveVerificationPatched) {
        const { conversationArchive } = await import('/src/conversation-archive.ts' as string);
        const originalLoad = conversationArchive.load;
        state.restoreArchiveVerification = () => { conversationArchive.load = originalLoad; };
        conversationArchive.load = async (key: string) => {
          const result = await originalLoad(key);
          return result && result.id === 'd3dba896-4b5c-4c1c-98c9-4e60238fe6b9' ? { ...result, text: 'Otra respuesta' } : result;
        };
        state.archiveVerificationPatched = true;
      }
      return originalInvoke(command, args);
    };
  });
  await page.reload();
  await expect(page.locator('#retry-conversation')).toBeVisible();
  await expect(page.locator('#chat-notice')).toContainText('copia nativa se conserva');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-events') || '[]'))).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-journal') || '[]'))).toEqual([answer]);
  await page.evaluate(() => (globalThis as any).restoreArchiveVerification());
  await page.locator('#retry-conversation').click();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-journal') || '[]'))).toEqual([]);
  const events = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-events') || '[]'));
  expect(events).toHaveLength(1);
  expect(events[0].args).toEqual({ turnId: turn, revision });
  expect(events[0].archived.text).toBe(response);
});

test('a failed initial checkpoint keeps the instruction and never starts the model', async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => {
    const { conversationArchive } = await import('/src/conversation-archive.ts' as string);
    conversationArchive.upsert = async () => { throw new Error('Cuota simulada'); };
  });
  await page.locator('#prompt').fill('Conserva esta instrucción antes de inferir.');
  await page.locator('#send').click();
  await expect(page.locator('#cards')).toContainText('Conserva esta instrucción antes de inferir.');
  await expect(page.locator('#cards')).toContainText('no inicié el modelo local');
  await expect(page.locator('#send')).toBeDisabled();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-events') || '[]'))).toEqual([]);
  await expect.poll(async () => page.evaluate(async () => (await (await import('/src/conversation.ts' as string)).loadConversation()).entries.some((item: { text: string }) => item.text === 'Conserva esta instrucción antes de inferir.'))).toBe(true);
});

test('explicit cancellation wins over a late native answer after restarting', async ({ page }) => {
  await setup(page); await seed(page, answer, true); await page.reload();
  await expect(page.locator('#cards')).toContainText('Respuesta interrumpida.');
  await expect(page.locator('#cards')).not.toContainText(response);
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-events') || '[]').length)).toBe(1);
  const event = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-events') || '[]')[0]);
  expect(event.entry.localCancelled).toBe(true); expect(event.archived.localCancelled).toBe(true);
  await page.reload(); await expect(page.locator('#cards')).not.toContainText(response);
});

test('an interrupted tool step is shown without invoking the model or replaying the tool', async ({ page }) => {
  await setup(page); await seed(page, { ...answer, status: 'interrupted', text: '' }); await page.reload();
  await expect(page.locator('#cards')).toContainText('no repetí ninguna operación');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-events') || '[]').length)).toBe(1);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-events') || '[]').map((event: any) => event.action))).toEqual(['ack']);
});

test('a still-running inference can be stopped after the WebView restarts', async ({ page }) => {
  await setup(page); await seed(page, { ...answer, status: 'pending', text: '' });
  await page.evaluate(id => sessionStorage.setItem('fixture-active', id), turn);
  await page.reload();
  await expect(page.locator('#stop')).toBeVisible();
  await expect(page.locator('#send')).toBeDisabled();
  await page.locator('#stop').click();
  await expect(page.locator('#cards')).toContainText('Respuesta interrumpida.');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-journal') || '[]'))).toEqual([]);
  await expect(page.locator('#send')).toBeEnabled();
  const events = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-events') || '[]'));
  expect(events.map((item: any) => item.action)).toEqual(['ack']);
  expect(events[0].entry.localCancelled).toBe(true); expect(events[0].archived.localCancelled).toBe(true);
});

test('a recovered answer locates its original turn outside the visible 120-message window', async ({ page }) => {
  await setup(page);
  await page.evaluate(async ({ turn, answer }) => {
    const { saveConversation } = await import('/src/conversation.ts' as string);
    const { conversationArchive } = await import('/src/conversation-archive.ts' as string);
    await conversationArchive.upsert([{ id: turn, role: 'assistant', text: '', engine: 'iphone', state: 'pending', at: 1234 }]);
    await saveConversation({ revision: 1000, draft: '', entries: Array.from({ length: 120 }, (_, index) => ({
      id: `later-${index}`, role: 'user', text: `Mensaje ${index}`, engine: 'iphone', state: 'complete', at: 2000 + index,
    })) });
    sessionStorage.setItem('fixture-journal', JSON.stringify([answer])); sessionStorage.setItem('fixture-events', '[]');
  }, { turn, answer });
  await page.reload();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-events') || '[]').length), { timeout: 15000 }).toBe(1);
  await expect(page.locator('#cards')).toContainText('Recuperé una respuesta anterior. Puedes consultarla en tus datos guardados.');
  const event = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-events') || '[]')[0]);
  expect(event.entry).toBeUndefined();
  expect(event.archived).toMatchObject({ id: turn, state: 'complete', text: response });
  expect(await page.locator('.chat-card').count()).toBe(120);
  await expect(page.locator('#rescue-history')).toBeVisible();
  await page.locator('#rescue-history').click();
  await page.getByText('Consultar mensajes anteriores', { exact: true }).click();
  await page.locator('#memory-query').fill(response);
  await page.locator('#memory-search button[type="submit"]').click();
  await expect(page.locator('#memory-entries')).toContainText(response);
});

test('a cancellation persisted only in the archive prevents a late answer from reappearing', async ({ page }) => {
  await setup(page);
  await page.evaluate(async ({ turn, answer }) => {
    const { saveConversation } = await import('/src/conversation.ts' as string);
    const { conversationArchive } = await import('/src/conversation-archive.ts' as string);
    await conversationArchive.upsert([{ id: turn, role: 'assistant', text: 'Respuesta interrumpida.',
      engine: 'iphone', state: 'interrupted', at: 1234, localCancelled: true }]);
    await saveConversation({ revision: 1000, draft: '', entries: Array.from({ length: 120 }, (_, index) => ({
      id: `later-${index}`, role: 'user', text: `Mensaje ${index}`, engine: 'iphone', state: 'complete', at: 2000 + index,
    })) });
    sessionStorage.setItem('fixture-journal', JSON.stringify([answer])); sessionStorage.setItem('fixture-events', '[]');
  }, { turn, answer });
  await page.reload();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-events') || '[]').length)).toBe(1);
  const event = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture-events') || '[]')[0]);
  expect(event.entry).toBeUndefined();
  expect(event.archived).toMatchObject({ id: turn, state: 'interrupted', text: 'Respuesta interrumpida.', localCancelled: true });
  await expect(page.locator('#cards')).not.toContainText(response);
  await page.reload();
  await expect(page.locator('#cards')).not.toContainText(response);
});
