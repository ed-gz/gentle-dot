import { expect, test } from './fixtures.ts';

test('actual agent activity stays readable, operable and bounded with large text and landscape', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#engine-status')).toContainText('esta vista no ejecuta');
  await page.evaluate(async () => {
    const { createConversationView } = await import('/src/conversation-view.ts' as string);
    const view = createConversationView({ container: document.querySelector<HTMLElement>('#cards')!, scroller: document.querySelector<HTMLElement>('#conversation-scroll')! });
    document.querySelector<HTMLElement>('#panel-chat')!.dataset.empty = 'false';
    document.querySelector<HTMLElement>('#engine-help')!.hidden = true;
    document.querySelector<HTMLElement>('#empty-conversation')!.hidden = true;
    view.render([
      { id: 'ux-user', role: 'user', engine: 'iphone', state: 'complete', at: 1, text: 'Revisa la sesión.' },
      { id: 'ux-assistant', role: 'assistant', engine: 'iphone', state: 'complete', at: 2, text: 'Ya encontré el trabajo.', activities: [
        { id: 'ux-done', kind: 'search', title: 'Consultando la sesión de la laptop', status: 'done', detail: 'Se encontró una sesión activa.' },
        { id: 'ux-running', kind: 'other', title: 'Preparando borrador de trabajo', status: 'running', detail: 'El borrador todavía está en preparación.' },
        { id: 'ux-failed', kind: 'other', title: 'Consulta interrumpida', status: 'failed', detail: 'No se confirmó la operación.' },
      ] },
    ]);
  });
  const trace = page.locator('.chat-card[data-role="assistant"] .tool-trace');
  const disclosure = trace.locator(':scope > summary');
  await expect(disclosure).toHaveText('3 acciones · En curso: Preparando borrador de trabajo · 1 interrumpida o fallida');
  await disclosure.click();
  await expect(trace.locator('li[data-status="done"]')).toContainText('Completado · Consultando');
  await expect(trace.locator('li[data-status="running"]')).toContainText('En curso · Preparando');
  await expect(trace.locator('li[data-status="failed"]')).toContainText('Interrumpido o fallido');
  const first = trace.locator('li[data-status="done"] details > summary');
  await first.click(); await expect(trace.locator('li[data-status="done"] pre')).toHaveText('Se encontró una sesión activa.');
  await first.focus(); await expect(first).toBeFocused();
  const target = await page.locator('.engine-details > summary').boundingBox();
  expect(target!.width).toBeGreaterThanOrEqual(44); expect(target!.height).toBeGreaterThanOrEqual(44);
  const colors = await trace.locator('li[data-status="done"] > span').evaluate(el => ({ font: parseFloat(getComputedStyle(el).fontSize), foreground: getComputedStyle(el).color, background: getComputedStyle(document.documentElement).backgroundColor }));
  const luminance = (color: string) => {
    const values = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(c => { const v = c / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
    return .2126 * values[0]! + .7152 * values[1]! + .0722 * values[2]!;
  };
  const levels = [luminance(colors.foreground), luminance(colors.background)].sort((a, b) => b - a);
  expect(colors.font).toBeGreaterThanOrEqual(16); expect((levels[0]! + .05) / (levels[1]! + .05)).toBeGreaterThanOrEqual(4.5);
  for (const viewport of [{ width: 375, height: 667 }, { width: 667, height: 375 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.documentElement.style.fontSize = '200%');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const summary = await disclosure.boundingBox();
    expect(summary!.width).toBeGreaterThanOrEqual(44); expect(summary!.height).toBeGreaterThanOrEqual(44);
    const engine = await page.locator('.engine-details > summary').boundingBox();
    expect(engine!.width).toBeGreaterThanOrEqual(44); expect(engine!.height).toBeGreaterThanOrEqual(44);
    await first.scrollIntoViewIfNeeded(); await first.focus(); await expect(first).toBeFocused();
    const focused = await first.boundingBox(); const scroller = await page.locator('#conversation-scroll').boundingBox();
    expect(focused!.y + focused!.height).toBeLessThanOrEqual(scroller!.y + scroller!.height + 1);
  }
});
