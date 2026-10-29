import { expect, test } from './fixtures.ts';

test('pagehide fences new character frames until pageshow', async ({ page }) => {
  test.slow();
  await page.addInitScript(() => {
    const proto = WebGLRenderingContext.prototype, draw = proto.drawArrays;
    (globalThis as any).capriLifecycleDraws = 0;
    proto.drawArrays = function (...args: Parameters<WebGLRenderingContext['drawArrays']>) {
      if (this.canvas instanceof HTMLCanvasElement && this.canvas.id === 'capri') (globalThis as any).capriLifecycleDraws++;
      return draw.apply(this, args);
    };
  });
  await page.goto('/');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 420;
    canvas.getContext('2d')!.fillRect(30, 10, 180, 400); return canvas.toDataURL().split(',')[1]!;
  });
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#art').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  const count = () => page.evaluate(() => (globalThis as any).capriLifecycleDraws as number);
  await expect.poll(count, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  const hidden = await count();
  // An asynchronous intent, a late event, or a resize may request a redraw
  // after pagehide but before WebKit sends a visibilitychange.
  await page.evaluate(() => { document.getElementById('greet')!.click(); window.dispatchEvent(new Event('resize')); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(400);
  expect(await count()).toBe(hidden);
  // A cached page can reappear while the document is still hidden. Wait for
  // the real foreground transition before submitting another frame.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await page.waitForTimeout(250); expect(await count()).toBe(hidden);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(count, { timeout: 15_000 }).toBeGreaterThan(hidden);
  await page.waitForTimeout(300);
  const reduced = await count(); await page.waitForTimeout(400); expect(await count()).toBe(reduced);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(count, { timeout: 15_000 }).toBeGreaterThan(reduced);
  // pageshow can arrive first while already visible, followed by a duplicate
  // visibility event. That second event must not cancel the resumed frame.
  const beforeDuplicate = await count();
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(count, { timeout: 15_000 }).toBeGreaterThan(beforeDuplicate);
});

test('a WebGL context restored during pagehide rebuilds only after foreground', async ({ page }) => {
  test.slow();
  await page.addInitScript(() => {
    const proto = WebGLRenderingContext.prototype, create = proto.createProgram;
    (globalThis as any).capriPrograms = 0;
    proto.createProgram = function () { (globalThis as any).capriPrograms++; return create.call(this); };
  });
  await page.goto('/');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 420;
    canvas.getContext('2d')!.fillRect(30, 10, 180, 400); return canvas.toDataURL().split(',')[1]!;
  });
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#art').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  const rig = page.locator('#rig-handle');
  await expect(rig).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  const supported = await page.locator('#capri').evaluate((canvas: HTMLCanvasElement) => {
    const gl = canvas.getContext('webgl'); const extension = gl?.getExtension('WEBGL_lose_context');
    if (!extension) return false;
    const state = globalThis as any; state.capriContextLoss = extension; state.capriContextRestored = false;
    canvas.addEventListener('webglcontextrestored', () => { state.capriContextRestored = true; });
    return true;
  });
  test.skip(!supported, 'This browser does not expose WEBGL_lose_context.');
  const programs = await page.evaluate(() => (globalThis as any).capriPrograms);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    (globalThis as any).capriContextLoss.loseContext();
  });
  await expect(rig).toHaveAttribute('data-ready', 'false');
  await page.evaluate(() => (globalThis as any).capriContextLoss.restoreContext());
  await expect.poll(() => page.evaluate(() => (globalThis as any).capriContextRestored), { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => (globalThis as any).capriPrograms)).toBe(programs);
  await expect(rig).toHaveAttribute('data-ready', 'false');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(rig).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  expect(await page.evaluate(() => (globalThis as any).capriPrograms)).toBeGreaterThan(programs);
});
