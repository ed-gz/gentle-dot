import { expect, test } from './fixtures.ts';
import { nativeFixture } from './native-voice-fixture.ts';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aX0AAAAASUVORK5CYII=', 'base64');

test('un audio no inventa una miniatura y sigue teniendo su unica accion de quitar', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await page.locator('#chat-files').setInputFiles({ name: 'nota.m4a', mimeType: 'audio/mp4', buffer: Buffer.from('fake-audio') });
  await expect(page.locator('#composer img')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Quitar la foto del mensaje' })).toHaveCount(0);
  const remove = page.getByRole('button', { name: 'Quitar el material del mensaje' });
  await expect(remove).toHaveCount(1);
  await expect(page.locator('#attachment-context')).toContainText('nota.m4a');
  await remove.click();
  await expect(remove).toHaveCount(0);
  // Desvincular no borra: el trabajo sigue en la bandeja de este iPhone.
  expect(await page.evaluate(async () => (await (await import('/src/work-inbox.ts' as string)).listWork()).length)).toBe(1);
});

test('sending with a photo attached keeps the work and names it to the engine', async ({ page }) => {
  await nativeFixture(page);
  await page.goto('/');
  await page.locator('#chat-camera').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: image });
  await expect(page.locator('#composer img')).toBeVisible();
  const id = await page.evaluate(async () => (await (await import('/src/work-inbox.ts' as string)).listWork())[0].id);
  await page.locator('#prompt').fill('Que hacemos con esta foto?');
  await page.locator('#send').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).nativePrompts.length)).toBe(1);
  expect(await page.evaluate(() => (globalThis as any).nativePrompts[0])).toContain(id);
  // The message does not consume the material: it remains stored on the phone.
  expect(await page.evaluate(async (workId: string) => Boolean(await (await import('/src/work-inbox.ts' as string)).readWork(workId)), id)).toBe(true);
});

test('la foto se ve, amplía y desvincula sin borrar el trabajo', async ({ page }) => {

  await nativeFixture(page);
  await page.addInitScript(() => {
    const active = new Set<string>();
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); active.add(url); return url; };
    URL.revokeObjectURL = url => { active.delete(url); revoke(url); };
    (globalThis as any).activeObjectURLs = active;
  });
  await page.goto('/');
  await page.locator('#chat-camera').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: image });
  const thumbnail = page.locator('#composer img');
  await expect(thumbnail).toBeVisible();
  expect(await thumbnail.evaluate(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (el as HTMLImageElement).src.startsWith('blob:'); })).toBe(true);
  const remove = page.getByRole('button', { name: 'Quitar la foto del mensaje' });
  await expect(remove).toHaveCount(1);
  await thumbnail.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.getByRole('button')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.locator('#chat-camera').setInputFiles({ name: 'otra.png', mimeType: 'image/png', buffer: image });
  await expect(thumbnail).toBeVisible();
  await remove.click();
  await expect(thumbnail).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (globalThis as any).activeObjectURLs.size)).toBe(0);
  expect(await page.evaluate(async () => (await (await import('/src/work-inbox.ts' as string)).listWork()).length)).toBe(2);
});
