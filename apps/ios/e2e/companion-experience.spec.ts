import { expect, test } from './fixtures.ts';

async function expectReadableComposer(page: import('@playwright/test').Page) {
  const boxes = await page.evaluate(() => {
    const read = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const input = document.querySelector<HTMLTextAreaElement>('#prompt')!;
    const prompt = read('#prompt'); const css = getComputedStyle(input);
    const line = Number.parseFloat(css.lineHeight);
    const top = prompt.top + Number.parseFloat(css.borderTopWidth) + Number.parseFloat(css.paddingTop);
    const controls = ['#camera', '#dictate', '#send'].map(read); const send = read('#send');
    return { copyBottom: read('.presence-copy').bottom, threadTop: read('#conversation-scroll').top,
      promptInner: input.clientHeight - Number.parseFloat(css.paddingTop) - Number.parseFloat(css.paddingBottom),
      line, lineTop: top, lineBottom: top + line,
      actionsOverlapText: controls.some(action => action.left < prompt.right && action.right > prompt.left && action.top < top + line && action.bottom > top),
      sendTop: send.top, sendBottom: send.bottom, screenBottom: innerHeight,
      sendCenterVisible: !!document.elementFromPoint(send.left + send.width / 2, send.top + send.height / 2)?.closest('#send'),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(boxes.horizontalOverflow).toBe(false);
  expect(boxes.copyBottom).toBeLessThanOrEqual(boxes.threadTop + 1);
  expect(boxes.promptInner).toBeGreaterThanOrEqual(boxes.line - 1);
  expect(boxes.actionsOverlapText).toBe(false);
  expect(boxes.sendTop).toBeGreaterThanOrEqual(0);
  expect(boxes.sendBottom).toBeLessThanOrEqual(boxes.screenBottom + 1);
  expect(boxes.sendCenterVisible).toBe(true);
}

async function personalBuild(page: import('@playwright/test').Page, waitForReady = true,
  artworkGate?: { wait: Promise<void>; requested(): void }) {
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
  await page.route('**/personal-art/capri-full.png', async route => {
    packagedReads++; artworkGate?.requested();
    if (artworkGate) await artworkGate.wait;
    return route.fulfill({ contentType: 'image/png', body: Buffer.from(asset.b64, 'base64') });
  });
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command.endsWith('results_list')) return { ok: true, items: [] };
      if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('list_voice_receipts')) return { ok: true, receipts: [] };
      if (command.endsWith('inspect_retained_voice')) return { ok: true };
      if (command.endsWith('check_voice')) return { ok: true, available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('agent_step')) return { ok: true, decision: { kind: 'answer', text: 'Voy contigo.\n\n- Primera tarea\n- Segunda tarea', toolName: '', argumentsJSON: '{}' } };
      return { ok: true };
    } };
  });
  await page.reload();
  if (waitForReady) {
    await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready', 'true', { timeout: 15000 });
    // Artwork initialization and IndexedDB restoration run independently. The
    // rig being ready does not mean the conversation can accept a message yet.
    await expect(page.locator('#history-loading')).toBeHidden({ timeout: 20000 });
    await expect(page.locator('#send')).toBeEnabled({ timeout: 20000 });
  }
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
  await page.mouse.down(); await page.mouse.move(before!.x + before!.width / 2 + direction * 70, before!.y + before!.height / 2, { steps: 8 });
  const held = await rig.boundingBox();
  const available = direction > 0 ? area!.x + area!.width - before!.x - before!.width - 4 : before!.x - area!.x - 4;
  expect(Math.abs(held!.x - before!.x)).toBeCloseTo(Math.min(70, Math.max(0, available)), 0);
  await page.mouse.up(); await page.clock.runFor(100);
  const after = await rig.boundingBox();
  const safe = await page.evaluate(() => {
    const rig = document.querySelector<HTMLElement>('#rig-handle')!.getBoundingClientRect();
    const blocked: object[] = [];
    const intersects = (box: DOMRect) => box.width > 0 && box.height > 0 && rig.left < box.right + 5
      && rig.right + 5 > box.left && rig.top < box.bottom + 5 && rig.bottom + 5 > box.top;
    for (const container of [document.querySelector<HTMLElement>('#panel-chat')!, document.querySelector<HTMLElement>('.masthead')!]) {
      for (const control of container.querySelectorAll('button, input, textarea, select, summary, img, video, [role="button"]')) {
        if (!control.closest('[hidden], #stage')) for (const box of control.getClientRects()) {
          if (intersects(box)) blocked.push({ kind: 'control', tag: control.tagName, id: control.id, box: box.toJSON() });
        }
      }
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode;
        if (!text.textContent?.trim() || text.parentElement?.closest('[hidden], #stage, script, style')) continue;
        const range = document.createRange(); range.selectNodeContents(text);
        for (const box of range.getClientRects()) if (intersects(box)) blocked.push({ kind: 'text', box: box.toJSON() });
      }
    }
    return { rig: rig.toJSON(), blocked };
  });
  expect(safe.blocked, `La posición al soltar debe respetar el texto y los controles: ${JSON.stringify(safe)}`).toEqual([]);
  // Geometry refresh must respect the same manual pause as the PC roam director.
  await page.clock.runFor(1300);
  expect((await rig.boundingBox())!.x).toBeCloseTo(after!.x, 0);
  await rig.focus(); await page.keyboard.press('ArrowLeft');
  expect((await rig.boundingBox())!.x).toBeLessThan(after!.x - 10);
  const keyed = await rig.boundingBox(); await page.clock.runFor(1300);
  expect((await rig.boundingBox())!.x).toBeCloseTo(keyed!.x, 0);
  await page.reload(); await expect(rig).toHaveAttribute('data-ready', 'true', { timeout: 15000 });
});

test('new controls remain reachable when Capri was manually placed and motion is reduced', async ({ page }) => {
  test.slow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await personalBuild(page);
  await page.locator('#prompt').fill('Continuemos con las tareas.');
  await page.locator('#send').click();
  await expect(page.locator('.chat-text ul li')).toHaveCount(2);
  const rig = page.locator('#rig-handle');
  await expect(rig).toBeVisible();
  await rig.focus();
  await page.keyboard.press('ArrowLeft');
  await page.evaluate(() => {
    const rig = document.querySelector<HTMLElement>('#rig-handle')!.getBoundingClientRect();
    const control = document.createElement('button');
    control.id = 'new-control-fixture'; control.textContent = 'Abrir';
    Object.assign(control.style, { position: 'fixed', left: `${rig.left + rig.width / 2 - 22}px`, top: `${rig.top + rig.height / 2 - 22}px`, width: '44px', height: '44px' });
    control.addEventListener('click', () => { control.dataset.clicked = 'true'; });
    document.querySelector('#cards')!.append(control);
  });
  const control = page.locator('#new-control-fixture');
  await expect.poll(() => control.evaluate(el => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el;
  })).toBe(true);
  await control.click();
  await expect(control).toHaveAttribute('data-clicked', 'true');
});

test('Capri uses the shared entrance in the app and yields immediately to interaction', async ({ page }) => {
  test.slow();
  await page.clock.install();
  // Observe the finite startup entrance immediately after navigation rather
  // than waiting for unrelated model availability and missing the effect.
  await personalBuild(page, false);
  const theater = page.locator('[data-capri-theater="intro"]');
  await expect(theater).toHaveCount(1, { timeout: 30000 });
  await page.clock.runFor(1200);
  await expect(theater).toHaveAttribute('data-beat', 'haul');
  await page.locator('#prompt').click();
  await expect(theater).toHaveCount(0);
  await expect(page.locator('#prompt')).toBeFocused();
});

test('a delayed character never starts its entrance after someone already uses the app', async ({ page }) => {
  test.slow();
  await page.clock.install();
  let release!: () => void, requested!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { requested = resolve; });
  await personalBuild(page, false, { wait, requested });
  await started;
  await page.locator('#prompt').click();
  await page.locator('#prompt').blur();
  release();
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  await page.clock.runFor(1000);
  await expect(page.locator('[data-capri-theater]')).toHaveCount(0);
});

test('programmatic submission ends the startup entrance before conversation appears', async ({ page }) => {
  test.slow();
  await page.clock.install();
  await personalBuild(page, false);
  const theater = page.locator('[data-capri-theater="intro"]');
  await expect(theater).toHaveCount(1, { timeout: 30000 });
  await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>('#prompt')!;
    input.value = 'Continuemos';
    document.querySelector<HTMLFormElement>('#composer')!.requestSubmit();
  });
  await expect(theater).toHaveCount(0);
});

test('Capri remains visible across sections without occupying the controls or narrowing chat', async ({ page }) => {
  test.slow();
  await personalBuild(page);
  await page.locator('#prompt').fill('Continuemos con las tareas.');
  await page.locator('#send').click();
  await expect(page.locator('.chat-text ul li')).toHaveCount(2);
  await expect(page.locator('.companion-shelf')).toHaveCount(0);
  expect(await page.locator('#cards').evaluate(el => getComputedStyle(el).paddingRight)).toBe('0px');
  for (const size of [{ width: 375, height: 812 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    for (const panel of ['agents', 'settings', 'chat']) {
      await page.locator(`[data-panel="${panel}"]`).click();
      await expect(page.locator('#rig-handle')).toBeVisible();
      await expect.poll(async () => page.evaluate(() => {
        const rig = document.querySelector<HTMLElement>('#rig-handle')!.getBoundingClientRect();
        return rig.width >= 44 && rig.height >= 44 && rig.left >= 0 && rig.right <= innerWidth && rig.top >= 0 && rig.bottom <= innerHeight;
      })).toBe(true);
      const rig = await page.locator('#rig-handle').boundingBox();
      expect(rig!.width).toBeGreaterThanOrEqual(44);
      expect(rig!.height).toBeGreaterThanOrEqual(44);
      if (size.width === 375 && panel === 'settings') {
        const canvas = page.locator('#capri');
        const first = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL());
        await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL())).not.toBe(first);
      }
    }
  }
});

test('a filled settings panel keeps Capri visible in the navigation dock without blocking controls', async ({ page }) => {
  test.slow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await personalBuild(page);
  await page.locator('[data-panel="settings"]').click();
  await expect(page.locator('#rig-handle')).toBeVisible();
  await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('#panel-settings')!;
    const rect = panel.getBoundingClientRect();
    const control = document.createElement('button'); control.id = 'occupied-panel-fixture'; control.textContent = 'Control';
    Object.assign(control.style, { position: 'fixed', top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px`, zIndex: '0' });
    panel.append(control); panel.scrollTop = 60;
  });
  await expect.poll(() => page.evaluate(() => {
    const rig = document.querySelector<HTMLElement>('#rig-handle')!.getBoundingClientRect();
    const dock = document.querySelector<HTMLElement>('#companion-dock')!.getBoundingClientRect();
    return rig.top >= dock.top - 1 && rig.bottom <= dock.bottom + 1 && rig.left >= dock.left && rig.right <= dock.right;
  })).toBe(true);
  const control = page.locator('#occupied-panel-fixture');
  await expect.poll(() => control.evaluate(el => {
    const r = el.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el;
  })).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
});

test('the companion layer hides only when explicitly hidden or its graphics context is lost', async ({ page }) => {
  test.slow();
  await personalBuild(page);
  await page.locator('[data-panel="settings"]').click();
  await expect(page.locator('.companion-shelf')).toHaveCount(0);
  await page.locator('#settings-character > summary').click();
  await page.getByText('Gestos y presencia', { exact: true }).click();
  await page.locator('#appear').click();
  await expect(page.locator('#stage')).toBeHidden();
  await page.locator('#appear').click();
  await expect(page.locator('#rig-handle')).toBeVisible();
  await page.locator('#capri').evaluate(canvas => canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })));
  await expect(page.locator('#stage')).toBeHidden();
});

test('conversation keeps composer and companion reachable in short viewport and enlarged text', async ({ page }) => {
  test.slow(); // Real shared WebGL shaders also run on CI software renderers.
  await personalBuild(page);
  await page.locator('#prompt').fill('Continuemos con las tareas.'); await page.locator('#send').click();
  await expect(page.locator('.chat-text ul li')).toHaveCount(2);
  for (const viewport of [{ width: 375, height: 667 }, { width: 390, height: 440 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    // A resize event can lag behind the new viewport; even its old, taller
    // value must not put the composer below the screen in that interval.
    await page.evaluate(() => document.documentElement.style.setProperty('--app-height', '900px'));
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

test('a local answer arriving during a greeting does not cut off the human gesture', async ({ page }) => {
  test.slow();
  await page.clock.install();
  await personalBuild(page);
  await page.evaluate(() => {
    const state = globalThis as any, bridge = state.__TAURI_INTERNALS__, original = bridge.invoke;
    bridge.invoke = (command: string, args: unknown) => command.endsWith('agent_step')
      ? new Promise(resolve => { state.resolveGreetingTestStep = resolve; }) : original(command, args);
  });
  await page.locator('#prompt').fill('Termina mientras saludas.'); await page.locator('#send').click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).resolveGreetingTestStep)).toBe('function');
  await page.locator('#rig-handle').focus(); await page.keyboard.press('Enter');
  await page.clock.runFor(150);
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-pose', 'hop');
  await page.evaluate(() => (globalThis as any).resolveGreetingTestStep({ ok: true, decision: {
    kind: 'answer', text: 'Respuesta durante el saludo.', toolName: '', argumentsJSON: '{}',
  } }));
  await expect(page.locator('.chat-text').last()).toContainText('Respuesta durante el saludo.');
  await page.clock.runFor(150);
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-pose', 'hop');
  await page.clock.runFor(2800);
  await expect(page.locator('#rig-handle')).not.toHaveAttribute('data-pose', 'hop');
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
