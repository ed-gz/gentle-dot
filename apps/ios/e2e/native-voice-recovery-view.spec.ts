import { expect, test } from './fixtures.ts';

async function fixture(page: import('@playwright/test').Page, size = 20, state: 'retained' | 'released' = 'released') {
  await page.goto('/');
  await page.evaluate(async ({ size, state }) => {
    const { mountNativeVoiceRecovery } = await import('/src/native-voice-recovery-view.ts');
    const id = 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345', text = 'x'.repeat(size);
    const receipt = { schema: 'capri-native-voice-receipt/v1', audio: { id, owner: 'abcdef02-abcd-4bcd-8bcd-abcdef012345', destination: 'chat', locale: 'es-MX', kind: 'speech', createdAt: 1, state: 'ready', byteCount: 10, sha256: 'a'.repeat(64) },
      transcript: { sessionId: id, text, segments: [{ text, startSeconds: 0, endSeconds: 1 }], durationSeconds: 1, locale: 'es-MX', source: 'apple-speech-analyzer' } };
    const globals = globalThis as any;
    globals.voiceFixture = { item: { receipt, releaseState: state }, appended: [], releases: 0, discards: 0, failRelease: false, confirm: true };
    const root = document.createElement('section'); root.id = 'native-voice-fixture'; document.body.append(root);
    globals.voiceRecovery = mountNativeVoiceRecovery(root, { store: {
      list: async () => globals.voiceFixture.item ? [structuredClone(globals.voiceFixture.item)] : [],
      get: async () => globals.voiceFixture.item ? structuredClone(globals.voiceFixture.item) : undefined,
      release: async () => { if (globals.voiceFixture.failRelease) throw new Error('fail'); globals.voiceFixture.releases++; globals.voiceFixture.item.releaseState = 'released'; },
      discard: async () => { globals.voiceFixture.discards++; globals.voiceFixture.item = undefined; },
    }, isDelivered: async () => false, append: (r: any) => { globals.voiceFixture.appended.push(r.transcript.text); }, confirmRelease: () => globals.voiceFixture.confirm, confirmDiscard: () => globals.voiceFixture.confirm });
    await globals.voiceRecovery.refresh();
  }, { size, state });
  return page.locator('#native-voice-fixture');
}

test('a long transcript remains complete and selectable without attempting to insert', async ({ page }) => {
  const root = await fixture(page, 12000); await root.locator('summary').click();
  await expect(root.locator('.voice-receipt-text')).toHaveText('x'.repeat(12000));
  await expect(root.getByRole('button', { name: 'Añadir al mensaje' })).toBeDisabled();
  await expect(root.getByRole('status')).toContainText('Selecciona y copia fragmentos');
  expect(await page.evaluate(() => (globalThis as any).voiceFixture.appended)).toEqual([]);
});

test('a retained audio is released only on its explicit action; failures remain retryable', async ({ page }) => {
  const root = await fixture(page, 20, 'retained'); await root.locator('summary').click();
  const release = root.getByRole('button', { name: 'Eliminar audio' });
  await expect(root.getByRole('button', { name: 'Eliminar copia' })).toBeDisabled();
  await page.evaluate(() => { (globalThis as any).voiceFixture.confirm = false; });
  await release.click();
  expect(await page.evaluate(() => (globalThis as any).voiceFixture.releases)).toBe(0);
  await expect(release).toBeEnabled();
  await page.evaluate(() => { (globalThis as any).voiceFixture.confirm = true; });
  await page.evaluate(() => { (globalThis as any).voiceFixture.failRelease = true; });
  await release.click(); await expect(root.getByRole('status')).toContainText('No pude confirmar'); await expect(release).toBeEnabled();
  await page.evaluate(() => { (globalThis as any).voiceFixture.failRelease = false; });
  await release.click(); await root.locator('summary').click();
  await expect(root.getByRole('button', { name: 'Eliminar copia' })).toBeEnabled();
  expect(await page.evaluate(() => (globalThis as any).voiceFixture.releases)).toBe(1);
});

test('changed receipts never insert or delete, and insertion needs an explicit gesture', async ({ page }) => {
  const root = await fixture(page); await root.locator('summary').click();
  await page.evaluate(() => { (globalThis as any).voiceFixture.item.receipt.transcript.text = 'otro'; });
  await root.getByRole('button', { name: 'Añadir al mensaje' }).click();
  await expect(root.getByRole('status')).toContainText('No pude añadirlo');
  await root.getByRole('button', { name: 'Eliminar copia' }).click();
  expect(await page.evaluate(() => ({ appended: (globalThis as any).voiceFixture.appended, discards: (globalThis as any).voiceFixture.discards }))).toEqual({ appended: [], discards: 0 });
});
