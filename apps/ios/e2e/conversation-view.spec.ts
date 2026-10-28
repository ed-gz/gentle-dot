import { expect, test } from './fixtures.ts';

async function fixture(page: import('@playwright/test').Page, documentScroll = false) {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__conversation-view_fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body{margin:0;font:16px/1.5 sans-serif} [hidden]{display:none!important} #viewport{${documentScroll ? '' : 'height:320px;overflow:auto;'}width:360px;max-width:100%;overflow-anchor:none} .chat-card{padding:12px;min-height:84px;border-bottom:1px solid} .chat-text{white-space:pre-wrap} pre{white-space:pre-wrap;max-height:160px;overflow:auto} button{min-height:44px} #composer{height:80px}
    </style></head><body><div id="viewport"><div id="cards" role="log" aria-live="polite"></div></div><button id="new" hidden></button><p id="empty">Aquí contigo.</p><textarea id="composer" aria-label="Mensaje"></textarea></body></html>` }));
  await page.goto('/__conversation-view_fixture');
  await page.evaluate(async documentScroll => {
    const w = window as any; const { createConversationView } = await import('/src/conversation-view.ts' as string);
    w.entry = (id: string, extra = {}) => ({ id, role: 'assistant', text: `Respuesta ${id}\nLínea de evidencia\nTexto adicional para lectura.`, engine: 'iphone', state: 'complete', at: 1, ...extra });
    w.messages = Array.from({ length: 12 }, (_, i) => w.entry(String(i)));
    w.view = createConversationView({ container: document.querySelector('#cards'), empty: document.querySelector('#empty'),
      scroller: documentScroll ? window : document.querySelector('#viewport'), newMessages: document.querySelector('#new') });
    w.view.render(w.messages);
  }, documentScroll);
  return errors;
}

test('updates preserve activity nodes, expanded result, focus and unchanged message DOM', async ({ page }) => {
  const errors = await fixture(page);
  await page.evaluate(() => {
    const w = window as any;
    w.messages = [w.entry('active', { state: 'pending', text: 'Leyendo', activities: [{ id: 'a', kind: 'read', title: 'Leer documento', status: 'running', detail: 'Evidencia completa' }] })];
    w.view.render(w.messages);
  });
  await page.locator('.tool-trace > summary').click();
  await page.getByText('Ver resultado', { exact: true }).click();
  await page.locator('.tool-trace pre').focus();
  await page.evaluate(() => {
    const w = window as any; w.originalCard = document.querySelector('.chat-card'); w.originalResult = document.querySelector('.tool-trace pre');
    w.messages[0].text = 'Leyendo un poco más'; w.messages[0].activities[0].status = 'done';
    w.messages[0].activities.push({ id: 'b', kind: 'search', title: 'Buscar evidencia', status: 'running' });
    w.view.render(w.messages);
  });
  await expect(page.locator('.tool-trace')).toHaveAttribute('open', '');
  await expect(page.locator('[data-activity-id="a"] details')).toHaveAttribute('open', '');
  expect(await page.evaluate(() => document.activeElement === (window as any).originalResult && document.querySelector('.chat-card') === (window as any).originalCard)).toBe(true);
  await expect(page.locator('[data-activity-id="a"]')).toContainText('Completado');
  expect(errors).toEqual([]);
});

test('collapsed activity identifies current work and failures without claiming unfinished work is complete', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const w = window as any;
    w.messages = [w.entry('active', { state: 'pending', text: '', activities: [
      { id: 'a', kind: 'read', title: 'Leer documento', status: 'running' },
      { id: 'b', kind: 'search', title: 'Buscar evidencia', status: 'running' },
      { id: 'c', kind: 'other', title: 'Consultar servidor', status: 'failed' },
    ] })];
    w.view.render(w.messages);
  });
  const trace = page.locator('.tool-trace');
  const summary = trace.locator(':scope > summary');
  await expect(trace).not.toHaveAttribute('open', '');
  await expect(summary).toHaveText('3 acciones · En curso: Buscar evidencia · 2 en curso · 1 interrumpida o fallida');
  await summary.focus();
  await page.evaluate(() => {
    const w = window as any;
    w.messages[0].activities[0].status = 'done'; w.messages[0].activities[1].status = 'done';
    w.view.render(w.messages);
  });
  await expect(summary).toHaveText('3 acciones · 1 interrumpida o fallida');
  await expect(summary).toBeFocused();
  await page.evaluate(() => { const w = window as any; w.messages[0].activities[2].status = 'done'; w.view.render(w.messages); });
  await expect(summary).toHaveText('3 acciones · Completadas');
});

test('follows new output only at the end and offers a contextual jump while reading earlier messages', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const w = window as any; w.messages.push(w.entry('12')); w.view.render(w.messages); });
  expect(await page.locator('#viewport').evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
  await page.locator('#viewport').evaluate(el => { el.scrollTop = 100; });
  const before = await page.locator('#viewport').evaluate(el => el.scrollTop);
  await page.evaluate(() => { const w = window as any; w.messages.push(w.entry('13', { state: 'pending' })); w.view.render(w.messages); w.messages[13].text += '\nNueva evidencia'; w.view.render(w.messages); });
  expect(await page.locator('#viewport').evaluate(el => el.scrollTop)).toBe(before);
  await expect(page.locator('#new')).toHaveText('Nueva respuesta · Ir al final');
  await page.locator('#new').click();
  await expect(page.locator('#new')).toBeHidden();
  expect(await page.locator('#viewport').evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
  await expect(page.locator('.chat-card').last()).toBeFocused();
});

test('prepending recovered history preserves the visible reading anchor without calling it a new reply', async ({ page }) => {
  await fixture(page);
  await page.locator('#viewport').evaluate(el => { el.scrollTop = 420; });
  const before = await page.locator('[data-id="3"]').evaluate(el => el.getBoundingClientRect().top);
  await page.evaluate(() => { const w = window as any; w.messages.unshift(w.entry('old')); w.view.render(w.messages); });
  const after = await page.locator('[data-id="3"]').evaluate(el => el.getBoundingClientRect().top);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
  await expect(page.locator('#new')).toBeHidden();
  await expect(page.locator('.chat-card').first()).toHaveAttribute('data-id', 'old');
});

test('reconciliation reorders by input IDs while keeping a focused existing result reachable', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const w = window as any;
    w.messages = ['one', 'two'].map(id => w.entry(id, { activities: [{ id: 'result', kind: 'read', title: id, status: 'done', detail: 'Prueba' }] }));
    w.view.render(w.messages);
  });
  await page.locator('[data-id="one"] .tool-trace > summary').click();
  await page.locator('[data-id="one"] [data-activity-id] summary').click();
  await page.locator('[data-id="one"] pre').focus();
  await page.evaluate(() => { const w = window as any; w.messages.reverse(); w.view.render(w.messages); });
  await expect(page.locator('.chat-card').first()).toHaveAttribute('data-id', 'two');
  await expect(page.locator('[data-id="one"] pre')).toBeFocused();
  await expect(page.locator('[data-id="one"] [data-activity-id] details')).toHaveAttribute('open', '');
});

test('assistant formatting is readable without interpreting HTML, loading images or activating model links', async ({ page }) => {
  const errors = await fixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const text = '# Acuerdos\n\n- **Confirmado**\n- *Propuesta*\n\n```sh\n<script>window.unsafe=true</script>\n```\n\n<img src=x onerror=alert(1)> [abrir](javascript:alert(1))';
    w.messages = [w.entry('assistant', { text }), w.entry('user', { role: 'user', text: '**Texto literal**' })]; w.view.render(w.messages);
  });
  await expect(page.locator('[data-id="assistant"] h3')).toHaveText('Acuerdos');
  await expect(page.locator('[data-id="assistant"] li')).toHaveCount(2);
  await expect(page.locator('[data-id="assistant"] strong')).toHaveText('Confirmado');
  await expect(page.locator('[data-id="assistant"] pre code')).toHaveText('<script>window.unsafe=true</script>');
  await expect(page.locator('#cards img, #cards script, #cards a')).toHaveCount(0);
  await expect(page.locator('[data-id="user"] .chat-text')).toHaveText('**Texto literal**');
  expect(await page.evaluate(() => (window as any).unsafe)).toBeUndefined(); expect(errors).toEqual([]);
});

test('document scrolling supports the same following policy and teardown removes the affordance listener', async ({ page }) => {
  await fixture(page, true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight - scrollY)).toBeLessThanOrEqual(1);
  await page.evaluate(() => window.scrollTo(0, 120));
  await page.evaluate(() => { const w = window as any; w.messages.push(w.entry('last')); w.view.render(w.messages); });
  await expect(page.locator('#new')).toBeVisible();
  const before = await page.evaluate(() => scrollY);
  await page.evaluate(() => { (window as any).view.destroy(); document.querySelector<HTMLButtonElement>('#new')!.click(); });
  expect(await page.evaluate(() => scrollY)).toBe(before);
});

test('human reviews use the same scroll policy without moving focus or treating a jump as approval', async ({ page }) => {
  await fixture(page);
  await page.locator('#viewport').evaluate(el => { el.scrollTop = 120; });
  await page.locator('#composer').focus();
  await page.evaluate(() => {
    const w = window as any; w.approved = false;
    const section = document.createElement('section'); section.id = 'review'; section.textContent = 'Revisar destinatario y contenido exacto';
    const control = document.createElement('button'); control.textContent = 'Aprobar operación'; control.onclick = () => { w.approved = true; }; section.append(control);
    w.view.updateExtra(section, () => document.querySelector('#viewport')!.append(section));
  });
  expect(await page.locator('#viewport').evaluate(el => el.scrollTop)).toBe(120);
  await expect(page.locator('#composer')).toBeFocused();
  await expect(page.locator('#new')).toHaveText('Nueva revisión · Ir al final');
  await page.locator('#new').click();
  await expect(page.locator('#review')).toBeFocused();
  expect(await page.evaluate(() => (window as any).approved)).toBe(false);
  await page.evaluate(() => {
    const w = window as any; const section = document.createElement('section'); section.textContent = 'Segunda revisión'; section.style.height = '180px';
    w.view.updateExtra(section, () => document.querySelector('#viewport')!.append(section));
  });
  expect(await page.locator('#viewport').evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
  await expect(page.locator('#new')).toBeHidden();
});
