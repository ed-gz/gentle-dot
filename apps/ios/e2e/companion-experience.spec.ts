import { expect, test } from './fixtures.ts';

async function expectReadableComposer(page: import('@playwright/test').Page) {
  const boxes = await page.evaluate(() => {
    const read = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const input = document.querySelector<HTMLTextAreaElement>('#prompt')!;
    const prompt = read('#prompt'); const css = getComputedStyle(input);
    const line = Number.parseFloat(css.lineHeight);
    const top = prompt.top + Number.parseFloat(css.borderTopWidth) + Number.parseFloat(css.paddingTop);
    const actions = read('.composer-actions'); const send = read('#send');
    return { copyBottom: read('.presence-copy').bottom, threadTop: read('#conversation-scroll').top,
      promptInner: input.clientHeight - Number.parseFloat(css.paddingTop) - Number.parseFloat(css.paddingBottom),
      line, lineTop: top, lineBottom: top + line, actionsTop: actions.top,
      actionsOverlapTextColumn: actions.left < prompt.right && actions.right > prompt.left,
      sendTop: send.top, sendBottom: send.bottom, screenBottom: innerHeight,
      sendCenterVisible: !!document.elementFromPoint(send.left + send.width / 2, send.top + send.height / 2)?.closest('#send'),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(boxes.horizontalOverflow).toBe(false);
  expect(boxes.copyBottom).toBeLessThanOrEqual(boxes.threadTop + 1);
  expect(boxes.promptInner).toBeGreaterThanOrEqual(boxes.line - 1);
  if (boxes.actionsOverlapTextColumn) expect(boxes.lineBottom).toBeLessThanOrEqual(boxes.actionsTop + 1);
  expect(boxes.sendTop).toBeGreaterThanOrEqual(0);
  expect(boxes.sendBottom).toBeLessThanOrEqual(boxes.screenBottom + 1);
  expect(boxes.sendCenterVisible).toBe(true);
}

async function personalBuild(page: import('@playwright/test').Page) {
  // Deliberately synthetic bytes. The personal character is never committed as a fixture.
  await page.goto('/');
  const asset = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 240; c.height = 420;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ff408e'; ctx.fillRect(60, 10, 120, 170); ctx.fillStyle = '#baff67'; ctx.fillRect(85, 180, 70, 220);
    const b64 = c.toDataURL().split(',')[1]!;
    const bytes = Uint8Array.from(atob(b64), char => char.charCodeAt(0));
    return { b64, size: bytes.length, sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('') };
  });
  await page.route('**/personal-art/manifest.json', route => route.fulfill({ json: { schemaVersion: 1, file: 'capri-full.png', sha256: asset.sha256, size: asset.size, width: 240, height: 420 } }));
  let packagedReads = 0;
  await page.route('**/personal-art/capri-full.png', route => { packagedReads++; return route.fulfill({ contentType: 'image/png', body: Buffer.from(asset.b64, 'base64') }); });
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command.endsWith('results_list')) return { ok: true, items: [] };
      if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('agent_step')) return { ok: true, decision: { kind: 'answer', text: 'Voy contigo.\n\n- Primera tarea\n- Segunda tarea', toolName: '', argumentsJSON: '{}' } };
      return { ok: true };
    } };
  });
  await page.reload();
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready', 'true', { timeout: 15000 });
  return { packagedReads: () => packagedReads };
}

test('personal package starts with the shared animated rig and real draggable travel space', async ({ page }) => {
  test.slow(); // Real shared WebGL shaders also run on CI software renderers.
  await page.clock.install();
  await personalBuild(page);
  await expect(page.locator('#art-placeholder')).toBeHidden();
  expect(await page.evaluate(async () => (await (await import('/src/local-state.ts' as string)).loadArtwork()) === undefined)).toBe(true);
  const canvas = page.locator('#capri');
  const first = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL())).not.toBe(first);
  const rig = page.locator('#rig-handle'); const before = await rig.boundingBox();
  const area = await page.locator('#stage').boundingBox();
  const direction = area!.x + area!.width - before!.x - before!.width >= 70 ? 1 : -1;
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down(); await page.mouse.move(before!.x + before!.width / 2 + direction * 70, before!.y + before!.height / 2, { steps: 8 }); await page.mouse.up();
  const after = await rig.boundingBox(); expect(Math.abs(after!.x - before!.x)).toBeGreaterThan(40);
  // Geometry refresh must respect the same manual pause as the PC roam director.
  await page.clock.runFor(1300);
  expect((await rig.boundingBox())!.x).toBeCloseTo(after!.x, 0);
  await rig.focus(); await page.keyboard.press('ArrowLeft');
  expect((await rig.boundingBox())!.x).toBeLessThan(after!.x - 10);
  const keyed = await rig.boundingBox(); await page.clock.runFor(1300);
  expect((await rig.boundingBox())!.x).toBeCloseTo(keyed!.x, 0);
  await page.reload(); await expect(rig).toHaveAttribute('data-ready', 'true', { timeout: 15000 });
});

test('conversation keeps composer and companion reachable in short viewport and enlarged text', async ({ page }) => {
  test.slow(); // Real shared WebGL shaders also run on CI software renderers.
  await personalBuild(page);
  await page.locator('#prompt').fill('Continuemos con las tareas.'); await page.locator('#send').click();
  await expect(page.locator('.chat-text ul li')).toHaveCount(2);
  for (const viewport of [{ width: 375, height: 667 }, { width: 390, height: 440 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    const composer = await page.locator('#composer').boundingBox();
    expect(composer!.y).toBeGreaterThan(0); expect(composer!.y + composer!.height).toBeLessThanOrEqual(viewport.height + 1);
    expect((await page.locator('#conversation-scroll').boundingBox())!.height).toBeGreaterThan(35);
    await expect(page.locator('#rig-handle')).toBeVisible();
  }
  for (const viewport of [{ width: 375, height: 667 }, { width: 667, height: 375 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.documentElement.style.fontSize = '200%');
    // The ResizeObserver may settle after the font and viewport style changes.
    await expect.poll(async () => page.locator('#prompt').evaluate(el => el.clientHeight)).toBeGreaterThanOrEqual(68);
    await expectReadableComposer(page);
    await page.locator('#prompt').focus();
    await expectReadableComposer(page);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  await page.locator('#rig-handle').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-pose', 'hop');
});

test('corrupt personal override falls back once to verified bundled art without deleting the local bytes', async ({ page }) => {
  test.slow();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const fixture = await personalBuild(page); const initial = fixture.packagedReads();
  await page.evaluate(async () => {
    const state = await import('/src/local-state.ts' as string);
    await state.saveArtwork(new Blob(['Corrupt saved PNG'], { type: 'image/png' }));
  });
  await page.reload();
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready', 'true', { timeout: 15000 });
  await expect(page.locator('#art-placeholder')).toBeHidden();
  expect(fixture.packagedReads()).toBe(initial + 1);
  expect(await page.evaluate(async () => (await (await import('/src/local-state.ts' as string)).loadArtwork())?.text())).toBe('Corrupt saved PNG');
  const frame = await page.locator('#capri').evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  await expect.poll(() => page.locator('#capri').evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).not.toBe(frame);
  expect(fixture.packagedReads()).toBe(initial + 1); // No retry loop while animation proceeds.
  expect(errors).toEqual([]);
});

test('PC teleport choreography reaches the conversation edge and a greeting does not disable roaming', async ({ page }) => {
  test.slow();
  // Install before the app creates performance.now-based roam deadlines.
  await page.clock.install();
  await personalBuild(page);
  await page.locator('#prompt').fill('Una respuesta para seguir leyendo.'); await page.locator('#send').click();
  await expect(page.locator('.chat-card')).toHaveCount(2);
  await page.locator('#rig-handle').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-pose', 'hop');
  await expect(page.locator('#roam')).toHaveAttribute('aria-pressed', 'true');
  await page.clock.fastForward(19000); await page.clock.runFor(1100);
  const first = await page.locator('#rig-handle').boundingBox();
  await page.clock.fastForward(19000); await page.clock.runFor(1100);
  const next = await page.locator('#rig-handle').boundingBox();
  await test.info().attach('roam-positions', { body: JSON.stringify({ first, next }), contentType: 'application/json' });
  // Adjacent safe perches may share a ledge. Verify real travel in either axis,
  // and separately require presence well beyond the old header scene.
  expect(Math.hypot(next!.x - first!.x, next!.y - first!.y)).toBeGreaterThan(100);
  const headerScene = await page.locator('.companion-presence').boundingBox();
  expect(Math.max(first!.y, next!.y)).toBeGreaterThan(headerScene!.y + headerScene!.height + 100);
  const stage = await page.locator('#stage').boundingBox();
  for (const box of [first!, next!]) {
    expect(box.x).toBeGreaterThanOrEqual(stage!.x);
    expect(box.y).toBeGreaterThanOrEqual(stage!.y);
    expect(box.y + box.height).toBeLessThanOrEqual(stage!.y + stage!.height + 1);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const still = await page.locator('#rig-handle').boundingBox();
  await page.clock.fastForward(40000);
  expect(await page.locator('#rig-handle').boundingBox()).toEqual(still);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    const bridge = (globalThis as any).__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = (command: string, args: unknown) => command.endsWith('agent_step') ? new Promise(() => {}) : invoke(command, args);
  });
  await page.locator('#prompt').fill('Sigo pensando mientras me saludas.'); await page.locator('#send').click();
  await page.locator('#rig-handle').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-pose', 'hop');
  await page.clock.fastForward(3000); await page.clock.runFor(1100);
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-pose', 'gaze');
  await expect(page.locator('#stop')).toBeVisible();
});
