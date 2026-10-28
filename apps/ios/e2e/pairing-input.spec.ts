import { expect, test, type Page } from './fixtures.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const link = `gentledot://pair?${new URLSearchParams({ url: 'https://laptop.example.ts.net', code: 'a'.repeat(32), name: 'Mi laptop' })}`;
async function fixture(page: Page, options: { codes?: string[]; hold?: boolean; native?: boolean } = {}) {
  await page.route('**/pairing-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><form id="fixture"><h2>Vincular laptop</h2><label>Invitación<input id="invitation"></label><button type="submit">Vincular iPhone</button></form></body></html>' }));
  await page.goto('/pairing-fixture');
  await page.evaluate(async ({ codes, hold, native }) => {
    const state = globalThis as any; state.isTauri = native; state.qrCommands = []; state.pairSubmits = 0;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      state.qrCommands.push(command);
      if (command.endsWith('|pairing_scan_cancel')) return { ok: true };
      if (command.endsWith('|pairing_scan')) {
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
  }, { codes: options.codes ?? [link], hold: options.hold ?? false, native: options.native ?? true });
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
