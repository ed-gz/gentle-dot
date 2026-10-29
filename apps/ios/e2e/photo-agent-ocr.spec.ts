import { expect, test } from './fixtures.ts';

test('a captured photo is stored, discoverable by the agent and passed to Vision with its original bytes', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true; state.stepNumber = 0; state.reads = [];
    const decision = (kind: string, toolName: string, args: unknown, text = '') => ({ ok: true, decision: { kind, toolName, argumentsJSON: JSON.stringify(args), text } });
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('results_list') || command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('agent_step')) {
        const prompt = args.prompt as string; state.reads.push(prompt);
        switch (++state.stepNumber) {
          case 1:
            if (!prompt.includes(`"attachedWork":"${state.workId}"`)) return decision('answer', '', {}, 'No recibí el adjunto.');
            return decision('tool', 'tool_describe', { name: 'file_list' });
          case 2: return decision('tool', 'file_list', { workId: state.workId });
          case 3:
            if (!prompt.includes(state.fileId) || !prompt.includes('error.png')) return decision('answer', '', {}, 'No encontré el archivo.');
            return decision('tool', 'tool_describe', { name: 'file_ocr' });
          case 4: return decision('tool', 'file_ocr', { workId: state.workId, fileId: state.fileId });
          default:
            return decision('answer', '', {}, prompt.includes('E-503') ? 'La imagen dice E-503.' : 'No pude leer el documento.');
        }
      }
      if (command.endsWith('recognize_document')) {
        const request = args.request;
        const bytes = Uint8Array.from(atob(request.base64), char => char.charCodeAt(0));
        state.visionRequest = { name: request.fileName, mime: request.mimeType, bytes: [...bytes] };
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
        return { ok: true, engine: 'apple-vision', coordinateSystem: 'normalized-bottom-left',
          source: { name: request.fileName, mimeType: request.mimeType, size: bytes.length, sha256 },
          text: 'E-503', warnings: ['Contrasta el OCR.'], pages: [{ page: 1, pixelWidth: 200, pixelHeight: 100,
            text: 'E-503', observations: [{ kind: 'text', text: 'E-503', confidence: 0.9, bounds: { x: 0.1, y: 0.2, width: 0.4, height: 0.2 } }] }] };
      }
      return { ok: true };
    } };
  });
  await page.goto('/');
  const bytes = Buffer.from('fixture photo bytes');
  await page.locator('#chat-camera').setInputFiles({ name: 'error.png', mimeType: 'image/png', buffer: bytes });
  await expect(page.locator('#view-material')).toBeEnabled();
  const metadata = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts' as string);
    const item = (await inbox.listWork())[0];
    (globalThis as any).workId = item.id; (globalThis as any).fileId = item.files[0].id;
    return { id: item.id, file: item.files[0] };
  });
  expect(metadata.file.name).toBe('error.png');
  await page.locator('#prompt').fill('Lee el código de esta foto'); await page.locator('#send').click();
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText('La imagen dice E-503.');
  expect(await page.evaluate(() => (globalThis as any).visionRequest)).toEqual({ name: 'error.png', mime: 'image/png', bytes: [...bytes] });
  await page.reload(); await expect(page.locator('#view-material')).toBeEnabled();
  await page.locator('#view-material').click(); await expect(page.locator('#work-list')).toContainText('error.png');
});

test('sending waits until the selected photo is saved and attached', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true; state.steps = 0;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('agent_step')) { state.steps++; return { ok: true, decision: { kind: 'answer', text: 'Listo', toolName: '', argumentsJSON: '{}' } }; }
      if (command.endsWith('results_list') || command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      return { ok: true };
    } };
  });
  await page.goto('/'); await expect(page.locator('#send')).toBeEnabled();
  await page.evaluate(() => {
    const state = globalThis as any; const original = indexedDB.open.bind(indexedDB);
    indexedDB.open = (name, version) => {
      const request = original(name, version);
      if (name === 'capri-ios-work-inbox' && !state.workOpenHeld) {
        let callback: ((event: Event) => void) | null = null;
        Object.defineProperty(request, 'onsuccess', { configurable: true, get: () => callback, set: value => { callback = value; } });
        request.addEventListener('success', event => {
          state.workOpenHeld = true;
          state.releaseWork = () => callback?.call(request, event);
        });
      }
      return request;
    };
  });
  await page.locator('#prompt').fill('Lee la foto');
  await page.locator('#chat-camera').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: Buffer.from('imagen') });
  await expect.poll(() => page.evaluate(() => (globalThis as any).workOpenHeld)).toBe(true);
  await expect(page.locator('#send')).toBeDisabled();
  await expect(page.locator('#camera')).toBeDisabled();
  await expect(page.locator('#attach')).toBeDisabled();
  await expect(page.locator('#attachment-context')).toHaveText('Guardando material…');
  await page.locator('#composer').evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(await page.evaluate(() => (globalThis as any).steps)).toBe(0);
  await expect(page.locator('#prompt')).toHaveValue('Lee la foto');
  await page.evaluate(() => (globalThis as any).releaseWork());
  await expect(page.locator('#view-material')).toBeEnabled();
  await expect(page.locator('#send')).toBeEnabled();
});

test('a failed photo save keeps the draft and original file available for an explicit retry', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('results_list') || command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      return { ok: true };
    } };
  });
  await page.goto('/'); await expect(page.locator('#send')).toBeEnabled();
  await page.evaluate(() => {
    const original = indexedDB.open.bind(indexedDB); let fail = true;
    indexedDB.open = (name, version) => {
      if (name === 'capri-ios-work-inbox' && fail) { fail = false; throw new Error('Almacenamiento de prueba'); }
      return original(name, version);
    };
  });
  await page.locator('#prompt').fill('Lee esta evidencia');
  const bytes = Buffer.from('foto original conservada');
  await page.locator('#chat-camera').setInputFiles({ name: 'evidencia.png', mimeType: 'image/png', buffer: bytes });
  await expect(page.locator('#chat-notice')).toContainText('No se adjuntó el archivo.');
  await expect(page.locator('#prompt')).toHaveValue('Lee esta evidencia');
  await expect(page.locator('#send')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Reintentar adjunto' })).toBeVisible();
  await page.getByRole('button', { name: 'Reintentar adjunto' }).click();
  await expect(page.locator('#view-material')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Reintentar adjunto' })).toBeHidden();
  await expect(page.locator('#chat-notice')).toBeEmpty();
  const restored = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts' as string); const work = (await inbox.listWork())[0];
    return [...new Uint8Array(await (await inbox.readWorkFile(work.id, work.files[0].id))!.arrayBuffer())];
  });
  expect(restored).toEqual([...bytes]);
});
