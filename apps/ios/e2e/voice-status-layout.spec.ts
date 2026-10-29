import { expect, test } from './fixtures.ts';

test('a voice error does not cover a recovery action with long history and simulated keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/'); await expect(page.locator('#history-loading')).toBeHidden();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
    const scroll = document.querySelector('#conversation-scroll')!;
    for (let i = 0; i < 30; i++) { const p = document.createElement('p'); p.textContent = `Mensaje anterior ${i}`; scroll.prepend(p); }
    const status = document.querySelector<HTMLElement>('#voice-status')!; status.textContent = 'No pude revisar el audio guardado. Se conserva para revisión.';
    const button = document.createElement('button'); button.id = 'recovery-fixture'; button.textContent = 'Rescatar datos';
    button.addEventListener('click', () => { button.dataset.clicked = 'true'; }); scroll.append(button);
  });
  await page.locator('#prompt').focus();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperties(viewport, { height: { configurable: true, value: 360 }, pageTop: { configurable: true, value: 0 }, scale: { configurable: true, value: 1 } });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'true');
  const layout = await page.evaluate(() => {
    const status = document.querySelector('#voice-status')!.getBoundingClientRect();
    const input = document.querySelector('#prompt')!.getBoundingClientRect();
    const box = (s: string) => { const b = document.querySelector(s)!.getBoundingClientRect(); return [b.top,b.bottom,b.height]; };
    return { statusBottom: status.bottom, inputBottom: input.bottom, statusTop: status.top, panel: box('#panel-chat'), main: box('main'), composer:box('#composer'), presence:box('.companion-presence'), scroll:box('#conversation-scroll') };
  });
  expect(layout.statusBottom).toBeLessThanOrEqual(361);
  expect(layout.inputBottom).toBeLessThanOrEqual(layout.statusTop);
  const rescue = page.locator('#recovery-fixture'); await rescue.scrollIntoViewIfNeeded();
  await expect.poll(() => rescue.evaluate(el => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button') === el; })).toBe(true);
  await rescue.click();
  await expect(rescue).toHaveAttribute('data-clicked', 'true');
});
