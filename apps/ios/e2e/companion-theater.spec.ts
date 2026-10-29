import { expect, test } from './fixtures.ts';

async function mount(page: import('@playwright/test').Page) {
  await page.clock.install();
  await page.goto('/');
  await page.evaluate(async () => {
    const module = await import('/src/companion-theater.tsx' as string);
    const state = globalThis as any;
    state.theaterAllowed = true; state.theaterGestures = []; state.theaterFinished = [];
    state.theater = module.createCompanionTheater({
      canPlay: () => state.theaterAllowed,
      onGesture: (name: string) => state.theaterGestures.push(name),
      onFinish: (reason: string) => state.theaterFinished.push(reason),
    });
  });
}

test('PC intro beats animate the in-app rig cues and never block a touch', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'theater-control-fixture'; button.textContent = 'Control';
    Object.assign(button.style, { position: 'fixed', left: '12px', top: '12px', zIndex: '50' });
    button.addEventListener('click', () => { button.dataset.clicked = 'yes'; });
    document.body.append(button);
  });
  expect(await page.evaluate(() => (globalThis as any).theater.startIntro())).toBe(true);
  await page.clock.runFor(1200);
  await expect(page.locator('[data-capri-theater="intro"]')).toHaveAttribute('data-beat', 'haul');
  expect(await page.evaluate(() => (globalThis as any).theaterGestures)).toContain('estirarse');
  const arm = await page.locator('.capri-theater-left').getAttribute('transform');
  await page.clock.runFor(150);
  expect(await page.locator('.capri-theater-left').getAttribute('transform')).not.toBe(arm);
  await page.locator('#theater-control-fixture').click();
  await expect(page.locator('#theater-control-fixture')).toHaveAttribute('data-clicked', 'yes');
  await expect(page.locator('[data-capri-theater]')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as any).theater.active())).toBeUndefined();
  expect(await page.evaluate(() => (globalThis as any).theaterFinished)).toEqual(['interrupted']);
});

test('intro uses the shared timing, finishes, and only replays on request', async ({ page }) => {
  await mount(page);
  expect(await page.evaluate(() => (globalThis as any).theater.startIntro())).toBe(true);
  await page.clock.runFor(3800);
  await expect(page.locator('[data-capri-theater="intro"]')).toHaveAttribute('data-beat', 'wave');
  expect(await page.evaluate(() => (globalThis as any).theaterGestures)).toContain('saludar');
  await page.clock.runFor(4300);
  await expect(page.locator('[data-capri-theater]')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as any).theaterFinished)).toEqual(['complete']);
  expect(await page.evaluate(() => (globalThis as any).theater.startIntro())).toBe(false);
  expect(await page.evaluate(() => (globalThis as any).theater.startIntro(true))).toBe(true);
  await page.evaluate(() => (globalThis as any).theater.destroy());
  await expect(page.locator('[data-capri-theater]')).toHaveCount(0);
});

test('PC possession runs only in a safe visible app and respects reduced motion', async ({ page }) => {
  await mount(page);
  expect(await page.evaluate(() => (globalThis as any).theater.startPossession())).toBe(true);
  await page.clock.runFor(200);
  await expect(page.locator('[data-capri-theater="possession"] [data-capri-possession]')).toHaveCount(1);
  await page.evaluate(() => (globalThis as any).theaterAllowed = false);
  await page.clock.runFor(50);
  await expect(page.locator('[data-capri-theater]')).toHaveCount(0);
  await page.evaluate(() => (globalThis as any).theaterAllowed = true);
  expect(await page.evaluate(() => (globalThis as any).theater.startPossession())).toBe(false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => (globalThis as any).theater.startIntro(true))).toBe(false);
  await expect(page.locator('[data-capri-theater]')).toHaveCount(0);
});

test('backgrounding or resizing ends the theater immediately', async ({ page }) => {
  await mount(page);
  expect(await page.evaluate(() => (globalThis as any).theater.startIntro())).toBe(true);
  await page.clock.runFor(100);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('[data-capri-theater]')).toHaveCount(0);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
  expect(await page.evaluate(() => (globalThis as any).theater.startIntro(true))).toBe(true);
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('[data-capri-theater]')).toHaveCount(0);
});

test('pagehide stops theater and blocks late replay until a visible pageshow', async ({ page }) => {
  await mount(page);
  expect(await page.evaluate(() => (globalThis as any).theater.startIntro())).toBe(true);
  await page.clock.runFor(100);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(page.locator('[data-capri-theater]')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as any).theater.startIntro(true))).toBe(false);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })));
  expect(await page.evaluate(() => (globalThis as any).theater.startIntro(true))).toBe(false);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  expect(await page.evaluate(() => (globalThis as any).theater.startIntro(true))).toBe(false);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
  expect(await page.evaluate(() => (globalThis as any).theater.startIntro(true))).toBe(true);
});
