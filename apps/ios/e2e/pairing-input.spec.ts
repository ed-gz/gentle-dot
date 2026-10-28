import { expect, test, type Page } from '@playwright/test';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const link = `gentledot://pair?${new URLSearchParams({ url: 'https://laptop.example.ts.net', code: 'a'.repeat(32), name: 'Mi laptop' })}`;
async function fixture(page: Page, options: { codes?: string[]; hold?: boolean; native?: boolean } = {}) {
  await page.route('**/pairing-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><form id="fixture"><h2>Vincular laptop</h2><label>Invitación<input id="invitation"></label><button type="submit">Vincular iPhone</button></form></body></html>' }));
  await page.goto('/pairing-fixture');
  await page.evaluate(async ({ codes, hold, native }) => {
    const state = globalThis as any; state.isTauri = native; state.qrCommands = []; state.pairSubmits = 0;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      state.qrCommands.push(command);
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

test('camera/photo QR fills one validated invitation, shows its host and requires separate human submission', async ({ page }) => {
  await fixture(page);
  expect(await page.locator('.pairing-scan').count()).toBe(1);
  await expect(page.getByLabel('Foto de cámara para leer QR')).toHaveAttribute('capture', 'environment');
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
  await page.getByLabel('Foto de cámara para leer QR').setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => typeof (globalThis as any).finishQR === 'function');
  await page.getByRole('button', { name: 'Vincular iPhone', exact: true }).click();
  expect(await page.evaluate(() => (globalThis as any).pairSubmits)).toBe(0);
  await page.getByRole('button', { name: 'Cancelar lectura' }).click();
  await page.evaluate(() => (globalThis as any).finishQR());
  await expect(page.locator('.pairing-scan')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#invitation')).toHaveValue('');
  await expect(page.locator('.pairing-scan-status')).toContainText('cancelada');
  expect(await page.evaluate(() => (globalThis as any).qrCommands)).toContain('plugin:perception|cancel_pairing_code');
});

test('edited invitation wins over a late scan and browser preview keeps paste available', async ({ page }) => {
  await fixture(page, { hold: true });
  await page.getByLabel('Foto guardada para leer QR').setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => typeof (globalThis as any).finishQR === 'function');
  await page.locator('#invitation').fill('mi enlace escrito'); await page.evaluate(() => (globalThis as any).finishQR());
  await expect(page.locator('.pairing-scan')).toHaveAttribute('aria-busy', 'false'); await expect(page.locator('#invitation')).toHaveValue('mi enlace escrito');
  await fixture(page, { native: false });
  await expect(page.getByRole('button', { name: 'Fotografiar QR' })).toBeDisabled();
  await expect(page.locator('#invitation')).toBeEnabled();
  await expect(page.locator('.pairing-scan-status')).toContainText('pegar la invitación');
});
