import { expect, test, type Page } from './fixtures.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const link = `gentledot://pair?${new URLSearchParams({ url: 'https://laptop.example.ts.net', code: 'a'.repeat(32), name: 'Mi laptop' })}`;
async function fixture(page: Page, options: { codes?: string[]; hold?: boolean; native?: boolean; liveError?: string; cancelFails?: number; cancelHold?: boolean } = {}) {
  await page.route('**/pairing-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><form id="fixture"><h2>Vincular laptop</h2><label>Invitación<input id="invitation"></label><button type="submit">Vincular iPhone</button></form></body></html>' }));
  await page.goto('/pairing-fixture');
  await page.evaluate(async ({ codes, hold, native, liveError, cancelFails, cancelHold }) => {
    const state = globalThis as any; state.isTauri = native; state.qrCommands = []; state.pairSubmits = 0;
    state.cancelCalls = 0;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('results_list')) return { ok: true, items: [] };
      state.qrCommands.push(command);
      if (command.endsWith('|pairing_scan_cancel')) {
        state.cancelCalls++;
        if (state.cancelCalls <= cancelFails) return { ok: false, message: 'Cierre no confirmado.' };
        if (cancelHold) return new Promise(resolve => { state.finishCancel = () => resolve({ ok: true }); });
        return { ok: true };
      }
      if (command.endsWith('|pairing_scan')) {
        if (liveError) return { ok: false, error: 'unavailable', message: liveError };
        const result = { ok: true, value: codes[0], cancelled: false };
        if (hold) return new Promise(resolve => { state.finishQR = () => resolve(result); });
        return result;
      }
      if (command.endsWith('|cancel_pairing_code')) return { ok: true };
      if (!command.endsWith('|scan_pairing_code')) throw Error('Unexpected native command');
      const request = args.request, bytes = Uint8Array.from(atob(request.base64), char => char.charCodeAt(0));
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      const result = { ok: true, engine: 'apple-vision', source: { name: request.fileName, mimeType: request.mimeType, size: bytes.length, sha256 }, codes };
      if (hold) return new Promise(resolve => { state.finishQR = () => resolve(result); });
      return result;
    } };
    const path = '/src/pairing-input.ts';
    const module = await import(path), form = document.querySelector<HTMLFormElement>('#fixture')!, input = document.querySelector<HTMLInputElement>('#invitation')!;
    state.qrMount = module.mountPairingInput(form, input); module.mountPairingInput(form, input);
    form.addEventListener('submit', event => { event.preventDefault(); state.pairSubmits++; });
  }, { codes: options.codes ?? [link], hold: options.hold ?? false, native: options.native ?? true, liveError: options.liveError, cancelFails: options.cancelFails ?? 0, cancelHold: options.cancelHold ?? false });
}

test('photo QR fills one validated invitation, shows its host and requires separate human submission', async ({ page }) => {
  await fixture(page);
  expect(await page.locator('.pairing-scan').count()).toBe(1);
  await expect(page.getByLabel('Foto guardada para leer QR')).not.toHaveAttribute('capture');
  await page.getByLabel('Foto guardada para leer QR').setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('#invitation')).toHaveValue(link);
  await expect(page.locator('.pairing-scan-status')).toContainText('https://laptop.example.ts.net');
  expect(await page.evaluate(() => (globalThis as any).pairSubmits)).toBe(0);
  expect(await page.evaluate(() => (globalThis as any).qrCommands)).toEqual(['plugin:perception|scan_pairing_code']);
  await page.getByRole('button', { name: 'Vincular iPhone', exact: true }).click();
  expect(await page.evaluate(() => (globalThis as any).pairSubmits)).toBe(1);
});

test('unrelated QR content never navigates, fills credentials or submits a pairing', async ({ page }) => {
  await fixture(page, { codes: ['https://evil.example/approve?yes=true', 'javascript:alert(1)'] });
  await page.locator('#invitation').fill('conservar borrador');
  await page.getByLabel('Foto guardada para leer QR').setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.pairing-scan-status')).toContainText('no es una invitación');
  await expect(page.locator('#invitation')).toHaveValue('conservar borrador');
  expect(page.url()).toContain('/pairing-fixture'); expect(await page.evaluate(() => (globalThis as any).pairSubmits)).toBe(0);
});

test('cancellation blocks a late result and pending scan blocks form submission', async ({ page }) => {
  await fixture(page, { hold: true });
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click();
  await page.waitForFunction(() => typeof (globalThis as any).finishQR === 'function');
  await expect(page.locator('#fixture button[type=submit]')).toBeDisabled();
  await page.evaluate(() => document.querySelector('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })));
  expect(await page.evaluate(() => (globalThis as any).pairSubmits)).toBe(0);
  await page.getByRole('button', { name: 'Cancelar lectura' }).click();
  await page.evaluate(() => (globalThis as any).finishQR());
  await expect(page.locator('.pairing-scan')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#invitation')).toHaveValue('');
  await expect(page.locator('.pairing-scan-status')).toContainText('cancelada');
  expect(await page.evaluate(() => (globalThis as any).qrCommands)).toContain('plugin:device-bridge|pairing_scan_cancel');
});

test('confirmed cancellation unlocks a scanner even if its original callback never arrives', async ({ page }) => {
  await fixture(page, { hold: true });
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click();
  await page.waitForFunction(() => typeof (globalThis as any).finishQR === 'function');
  await page.evaluate(() => { (globalThis as any).finishOldQR = (globalThis as any).finishQR; });
  await page.getByRole('button', { name: 'Cancelar lectura' }).click();
  await expect(page.getByRole('button', { name: 'Escanear QR', exact: true })).toBeEnabled();
  await expect(page.locator('#invitation')).toHaveValue('');
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click();
  await page.waitForFunction(() => (globalThis as any).finishQR !== (globalThis as any).finishOldQR);
  await page.evaluate(() => (globalThis as any).finishOldQR());
  await expect(page.locator('.pairing-scan')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#invitation')).toHaveValue('');
  await page.evaluate(() => (globalThis as any).finishQR());
  await expect(page.locator('#invitation')).toHaveValue(link);
  expect(await page.evaluate(() => (globalThis as any).pairSubmits)).toBe(0);
});

test('an unconfirmed scanner close blocks rescans and repeated taps until retry succeeds', async ({ page }) => {
  await fixture(page, { hold: true, cancelFails: 1, cancelHold: true });
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click();
  await page.waitForFunction(() => typeof (globalThis as any).finishQR === 'function');
  await page.getByRole('button', { name: 'Cancelar lectura' }).click();
  await expect(page.locator('.pairing-scan-status')).toContainText('No pude confirmar');
  await expect(page.getByRole('button', { name: 'Escanear QR', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Reintentar cierre' }).click();
  await page.waitForFunction(() => typeof (globalThis as any).finishCancel === 'function');
  await expect(page.getByRole('button', { name: 'Escanear QR', exact: true })).toBeDisabled();
  await page.evaluate(() => { document.querySelector<HTMLButtonElement>('#pairing-camera')!.click(); document.querySelector<HTMLButtonElement>('.pairing-scan-controls button:last-child')!.click(); });
  expect(await page.evaluate(() => (globalThis as any).cancelCalls)).toBe(2);
  await page.evaluate(() => (globalThis as any).finishCancel());
  await expect(page.getByRole('button', { name: 'Escanear QR', exact: true })).toBeEnabled();
  await expect(page.locator('#invitation')).toHaveValue('');
  expect(await page.evaluate(() => (globalThis as any).qrCommands.filter((command: string) => command.endsWith('|pairing_scan')).length)).toBe(1);
});

test('a cancellation callback that never arrives keeps the scanner fenced and explains the delay', async ({ page }) => {
  await fixture(page, { hold: true, cancelHold: true });
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click();
  await page.waitForFunction(() => typeof (globalThis as any).finishQR === 'function');
  await page.getByRole('button', { name: 'Cancelar lectura' }).click();
  await page.waitForFunction(() => typeof (globalThis as any).finishCancel === 'function');
  await expect(page.locator('.pairing-scan-status')).toContainText('No se ha confirmado el cierre', { timeout: 6000 });
  await expect(page.getByRole('button', { name: 'Escanear QR', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancelar lectura' })).toBeDisabled();
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('#pairing-camera')!.click());
  expect(await page.evaluate(() => (globalThis as any).qrCommands.filter((command: string) => command.endsWith('|pairing_scan')).length)).toBe(1);
  await page.evaluate(() => (globalThis as any).finishCancel());
  await expect(page.getByRole('button', { name: 'Escanear QR', exact: true })).toBeEnabled();
});

test('camera permission obscuring the web view does not cancel the native scanner', async ({ page }) => {
  await fixture(page, { hold: true });
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click();
  await page.waitForFunction(() => typeof (globalThis as any).finishQR === 'function');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await page.evaluate(() => (globalThis as any).qrCommands)).not.toContain('plugin:device-bridge|pairing_scan_cancel');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    (globalThis as any).finishQR();
  });
  await expect(page.locator('#invitation')).toHaveValue(link);
  await expect(page.getByRole('button', { name: 'Vincular iPhone', exact: true })).toBeEnabled();
});

test('a photo scan still cancels when the web view is hidden', async ({ page }) => {
  await fixture(page, { hold: true });
  await page.getByLabel('Foto guardada para leer QR').setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => typeof (globalThis as any).finishQR === 'function');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    (globalThis as any).finishQR();
  });
  await expect(page.locator('#invitation')).toHaveValue('');
  expect(await page.evaluate(() => (globalThis as any).qrCommands)).toContain('plugin:perception|cancel_pairing_code');
});

test('edited invitation wins over a late scan and browser preview keeps paste available', async ({ page }) => {
  await fixture(page, { hold: true });
  await page.getByLabel('Foto guardada para leer QR').setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => typeof (globalThis as any).finishQR === 'function');
  await page.locator('#invitation').fill('mi enlace escrito'); await page.evaluate(() => (globalThis as any).finishQR());
  await expect(page.locator('.pairing-scan')).toHaveAttribute('aria-busy', 'false'); await expect(page.locator('#invitation')).toHaveValue('mi enlace escrito');
  await fixture(page, { native: false });
  await expect(page.getByRole('button', { name: 'Escanear QR' })).toBeDisabled();
  await expect(page.locator('#invitation')).toBeEnabled();
  await expect(page.locator('.pairing-scan-status')).toContainText('pegar la invitación');
});


test('live native scanner shows a validated host without photographing, opening URLs or pairing automatically', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click();
  await expect(page.locator('#invitation')).toHaveValue(link);
  await expect(page.locator('.pairing-scan-status')).toContainText('Mi laptop');
  await expect(page.locator('.pairing-scan-status')).toContainText('https://laptop.example.ts.net');
  expect(await page.evaluate(() => (globalThis as any).qrCommands)).toEqual(['plugin:device-bridge|pairing_scan']);
  expect(await page.evaluate(() => (globalThis as any).pairSubmits)).toBe(0);
  await expect(page.getByRole('button', { name: 'Vincular iPhone', exact: true })).toBeFocused();
  await page.evaluate(() => (globalThis as any).qrMount.setSubmitting(true));
  await expect(page.getByRole('button', { name: 'Escanear QR', exact: true })).toBeDisabled();
  await expect(page.locator('#invitation')).toBeDisabled();
  await page.evaluate(() => (globalThis as any).qrMount.setSubmitting(false));
  await page.getByRole('button', { name: 'Vincular iPhone', exact: true }).click();
  expect(await page.evaluate(() => (globalThis as any).pairSubmits)).toBe(1);
});

test('a scanner interrupted by backgrounding reports why without treating it as a user cancellation', async ({ page }) => {
  await fixture(page, { liveError: 'El escáner se detuvo al salir de Capri. Vuelve a intentar o elige una foto del QR.' });
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click();
  await expect(page.locator('.pairing-scan-status')).toContainText('se detuvo al salir de Capri');
  await expect(page.locator('.pairing-scan-status')).not.toContainText('Lectura cancelada');
  await expect(page.getByRole('button', { name: 'Escanear QR', exact: true })).toBeEnabled();
  await expect(page.locator('#invitation')).toHaveValue('');
  expect(await page.evaluate(() => (globalThis as any).pairSubmits)).toBe(0);
});

test('a camera restriction is shown without claiming the user denied permission', async ({ page }) => {
  await fixture(page, { liveError: 'La cámara está autorizada, pero el escáner no está disponible. Revisa las restricciones de Cámara del iPhone o elige una foto del QR.' });
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click();
  await expect(page.locator('.pairing-scan-status')).toContainText('cámara está autorizada');
  await expect(page.locator('.pairing-scan-status')).toContainText('restricciones');
  await expect(page.locator('.pairing-scan-status')).not.toContainText('Permite Cámara');
  await expect(page.getByRole('button', { name: 'Elegir foto del QR' })).toBeEnabled();
  expect(await page.evaluate(() => (globalThis as any).pairSubmits)).toBe(0);
});

test('native camera result for an unrelated URL cannot become a candidate', async ({ page }) => {
  await fixture(page, { codes: ['https://evil.example/approve'] });
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click();
  await expect(page.locator('.pairing-scan-status')).toContainText('gentledot://pair');
  await expect(page.locator('#invitation')).toHaveValue('');
  await expect(page.locator('#fixture button[type=submit]')).toBeDisabled();
  expect(page.url()).toContain('/pairing-fixture');
});

test('installed settings lead with the camera and keep pasted codes secondary until requested', async ({ page }) => {
  await page.addInitScript(link => {
    const state = globalThis as any; state.isTauri = true; state.pairCalls = 0;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command.endsWith('results_list')) return { ok: true, items: [] };
      if (command.endsWith('|pairing_scan')) return { ok: true, cancelled: false, value: link };
      if (command.endsWith('|pair_device')) { state.pairCalls++; throw Error('No pairing expected'); }
      if (command.endsWith('|share_list') || command.endsWith('|documents_list')) return { ok: true, items: [] };
      return { ok: true };
    } };
  }, link);
  await page.goto('/'); await page.locator('[data-panel="settings"]').click();
  await expect(page.locator('#panel-settings h2').first()).toHaveText('Tu laptop');
  await expect(page.locator('#pairing-invitation')).toBeHidden();
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click();
  await expect(page.locator('.pairing-scan-status')).toContainText('Mi laptop');
  await expect(page.locator('#pairing-invitation')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Vincular iPhone', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (globalThis as any).pairCalls)).toBe(0);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  const bounds = await page.locator('#pairing-camera').boundingBox();
  expect(bounds!.width).toBeGreaterThanOrEqual(44); expect(bounds!.height).toBeGreaterThanOrEqual(44);
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  await page.getByText('Pegar una invitación', { exact: true }).click();
  await expect(page.locator('#pairing-invitation')).toBeVisible();
});

test('pairing tells the user to approve on the laptop while the host request is pending', async ({ page }) => {
  await page.addInitScript(link => {
    const state = globalThis as any; state.isTauri = true;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command.endsWith('|pairing_scan')) return { ok: true, cancelled: false, value: link };
      if (command.endsWith('|pair_device')) return new Promise(resolve => { state.finishPairing = () => resolve({ ok: false, status: 403 }); });
      if (command.endsWith('|share_list') || command.endsWith('|documents_list') || command.endsWith('results_list')) return { ok: true, items: [] };
      return { ok: true };
    } };
  }, link);
  await page.goto('/');
  await page.locator('[data-panel="settings"]').click();
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click();
  await page.getByRole('button', { name: 'Vincular iPhone', exact: true }).click();
  await expect(page.locator('#pairing-status')).toContainText('aprueba el acceso');
  await page.waitForFunction(() => typeof (globalThis as any).finishPairing === 'function');
  await page.evaluate(() => (globalThis as any).finishPairing());
  await expect(page.locator('#pairing-status')).toContainText('no aprobó');
});

test('a paired credential that could not be saved can be retried without redeeming the QR again', async ({ page }) => {
  await page.routeWebSocket('wss://laptop.example.ts.net/ws', ws => {
    let seq = 0;
    ws.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello') ws.send(JSON.stringify({ seq: seq++, type: 'ready', agentState: 'idle', conversationId: 'fixture' }));
      if (message.type === 'get_history') ws.send(JSON.stringify({ seq: seq++, type: 'history', conversationId: 'fixture', messages: [] }));
    });
  });
  await page.addInitScript(link => {
    const state = globalThis as any; state.isTauri = true; state.pairCalls = 0; state.saveCalls = 0; state.selectionMarker = undefined;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('|secret_get') && args.request.account === 'capri.selected-connection.v1') return { ok: true, value: state.selectionMarker };
      if (command.endsWith('|secret_set') && args.request.account === 'capri.selected-connection.v1') {
        const marker = JSON.parse(args.request.value);
        if (marker.state === 'pending' && marker.candidate) {
          state.saveCalls++;
          if (state.saveCalls === 1) return { ok: false, error: 'storage' };
          return new Promise(resolve => { state.finishSave = () => { state.selectionMarker = args.request.value; resolve({ ok: true }); }; });
        }
        state.selectionMarker = args.request.value; return { ok: true };
      }
      if (command.endsWith('|pairing_scan')) return { ok: true, cancelled: false, value: link };
      if (command.endsWith('|pair_device')) {
        state.pairCalls++;
        return { ok: true, persisted: false, connection: { url: 'wss://laptop.example.ts.net/ws', token: 'a'.repeat(64), deviceId: 'device-1', name: 'Capri iPhone' } };
      }
      if (command.endsWith('|share_list') || command.endsWith('|documents_list') || command.endsWith('results_list')) return { ok: true, items: [] };
      return { ok: true };
    } };
  }, link);
  await page.goto('/'); await page.locator('[data-panel="settings"]').click();
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click();
  await page.getByRole('button', { name: 'Vincular iPhone', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Volver a guardar acceso' });
  await expect(retry).toBeVisible();
  await retry.click();
  await page.waitForFunction(() => typeof (globalThis as any).finishSave === 'function');
  await page.evaluate(() => document.querySelector<HTMLFormElement>('#connection')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })));
  await expect(page.locator('#pairing-status')).toContainText('Espera');
  await page.evaluate(() => (globalThis as any).finishSave());
  await expect(page.locator('#pairing-status')).toContainText('Acceso guardado en Keychain');
  await expect(retry).toBeHidden();
  expect(await page.evaluate(() => [(globalThis as any).pairCalls, (globalThis as any).saveCalls])).toEqual([1, 2]);
});
