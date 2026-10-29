import { expect, test } from './fixtures.ts';

test('an imported attachment opens first and all saved material survives reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#view-material')).toBeHidden();
  const controls = await Promise.all(['#camera', '#dictate', '#prompt', '#send'].map(selector => page.locator(selector).boundingBox()));
  expect(controls.every(rect => rect && Math.abs(rect.y + rect.height - (controls[0]!.y + controls[0]!.height)) < 2)).toBe(true);
  await page.evaluate(async () => {
    const { createWork } = await import('/src/work-inbox.ts' as string);
    await createWork({ title: 'Otro material', kind: 'task', instruction: 'Conservar', files: [] });
  });
  await page.locator('#chat-camera').setInputFiles({ name: 'evidencia.png', mimeType: 'image/png', buffer: Buffer.from('imagen de prueba') });
  await expect(page.locator('#view-material')).toBeVisible();
  await page.locator('#view-material').click();
  await expect(page.locator('#panel-inbox')).toBeVisible();
  await expect(page.locator('#work-list')).toContainText('evidencia.png');
  await expect(page.locator('#work-list .work-item').first()).toContainText('evidencia.png');
  await expect(page.locator('#work-list')).toContainText('Otro material');
  await page.getByText('Archivos (1)', { exact: true }).click();
  await expect(page.getByRole('button', { name: /Descargar evidencia.png/ })).toBeVisible();
  await page.locator('[data-panel="chat"]').click();
  await page.reload();
  await expect(page.locator('#view-material')).toBeVisible();
  await page.locator('#view-material').click();
  await expect(page.locator('#work-list')).toContainText('evidencia.png');
  await expect(page.locator('#work-list .work-item').first()).toContainText('evidencia.png');
  await expect(page.locator('#work-list')).toContainText('Otro material');
});
