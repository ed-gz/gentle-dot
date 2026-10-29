import { expect, test, type Page } from './fixtures.ts';

async function prepare(page: Page, reduce = false) {
  test.slow();
  if (reduce) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const png = await page.evaluate(() => {
    const canvas=document.createElement('canvas'); canvas.width=240; canvas.height=420;
    const ctx=canvas.getContext('2d')!; ctx.fillStyle='#ff408e'; ctx.fillRect(60,10,120,170); ctx.fillStyle='#baff67'; ctx.fillRect(85,180,70,220);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#art').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready','true',{timeout:30000});
  await expect(page.locator('#history-loading')).toBeHidden({timeout:20000});
  await page.locator('#settings-character > summary').click();
  await page.getByText('Gestos y presencia',{exact:true}).click();
}

test('presence plays the shared exit and arrival while controls stay interactive', async ({page}) => {
  await page.clock.install(); await prepare(page);
  const rig=page.locator('#rig-handle'), stage=page.locator('#stage'), button=page.locator('#appear');
  await button.click();
  await expect(rig).toHaveAttribute('data-presence','exiting');
  await expect(stage).toBeVisible(); await expect(rig).toBeDisabled();
  expect(await rig.evaluate(el=>getComputedStyle(el).pointerEvents)).toBe('none');
  await page.clock.runFor(80); await expect(rig).toHaveAttribute('data-pose','teleport');
  await page.clock.runFor(1500);
  await expect(stage).toBeHidden(); await expect(rig).toHaveAttribute('data-presence','hidden');
  await button.click();
  await expect(rig).toHaveAttribute('data-presence','entering');
  await expect(stage).toBeVisible(); await expect(rig).toBeDisabled();
  await page.clock.runFor(80); await expect(rig).toHaveAttribute('data-pose','teleport');
  await page.clock.runFor(1500);
  await expect(rig).toHaveAttribute('data-presence','visible'); await expect(rig).toBeEnabled();
  await page.locator('[data-panel="chat"]').click();
  await page.clock.runFor(300);
  await expect(page.locator('[data-capri-theater]')).toHaveCount(0);
});

test('rapid reversals settle at the last requested state', async ({page}) => {
  await page.clock.install(); await prepare(page);
  const rig=page.locator('#rig-handle'), button=page.locator('#appear');
  await button.click(); await page.clock.runFor(50);
  await button.click(); await expect(rig).toHaveAttribute('data-presence','entering');
  await page.clock.runFor(50); await button.click();
  await expect(rig).toHaveAttribute('data-presence','exiting');
  await page.clock.runFor(1500);
  await expect(page.locator('#stage')).toBeHidden(); await expect(button).toHaveText('Aparecer');
});

test('reduced motion switches presence immediately without teleport effects', async ({page}) => {
  await prepare(page,true);
  const rig=page.locator('#rig-handle'), stage=page.locator('#stage'), button=page.locator('#appear');
  await button.click(); await expect(stage).toBeHidden(); await expect(rig).toHaveAttribute('data-presence','hidden');
  await button.click(); await expect(stage).toBeVisible(); await expect(rig).toHaveAttribute('data-presence','visible');
  await expect(rig).toBeEnabled();
});

test('backgrounding settles the requested visibility and foreground resumes correctly', async ({page}) => {
  await page.clock.install(); await prepare(page);
  const rig=page.locator('#rig-handle'), stage=page.locator('#stage'), button=page.locator('#appear');
  await button.click(); await expect(rig).toHaveAttribute('data-presence','exiting');
  await page.evaluate(() => { Object.defineProperty(document,'hidden',{configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(stage).toBeHidden(); await expect(rig).toHaveAttribute('data-presence','hidden');
  await page.evaluate(() => { Object.defineProperty(document,'hidden',{configurable:true,value:false}); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(100); await expect(stage).toBeHidden();
  await button.click(); await expect(rig).toHaveAttribute('data-presence','entering');
  await page.evaluate(() => { Object.defineProperty(document,'hidden',{configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(rig).toHaveAttribute('data-presence','visible');
  await page.evaluate(() => { Object.defineProperty(document,'hidden',{configurable:true,value:false}); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(150); await expect(stage).toBeVisible(); await expect(rig).toBeEnabled();
});
