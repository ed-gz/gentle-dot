import { expect, test } from './fixtures.ts';

test('iPhone session list separates offline terminals and preserves assistant text before tool results', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as any;
    state.isTauri = true;
    const sessions = Array.from({ length: 6 }, (_, i) => ({
      paneId: `pane-${i}`, terminalId: `terminal-${i}`, workspaceId: 'workspace',
      ...(i === 5 ? {} : { sessionId: `session-${i}` }), provider: 'herdr',
      label: `Proyecto ${i + 1}`, cwd: `/workspace/proyecto-${i + 1}`,
      state: i < 2 || i === 5 ? 'working' : 'idle', connected: i !== 5, managed: i !== 5,
      capabilities: { inspect: i !== 5, prompt: i !== 5, abort: i !== 5, approvals: false },
    }));
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, wrapper: any) => {
      if (command.endsWith('https_request')) {
        const body = wrapper?.request?.body ? JSON.parse(wrapper.request.body) : undefined;
        const data = !body ? { available: true, sessions, approvals: [], policies: [], events: [] } : {
          sessionId: body.sessionId, status: 'working', question: null, deliveries: [],
          metadata: { version: 1, source: 'live', model: { id: 'fixture-model', name: 'Modelo de prueba', provider: 'fixture' }, profile: { name: 'Perfil de prueba', source: 'session' }, tools: { active: ['gentle_review'], available: 1 }, mcp: [{ name: 'fixture-mcp', status: 'available', tools: 1 }] },
          messages: [
            { id: 'a1', role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'Estoy revisando el error.' }] },
            { id: 't1', role: 'tool', content: [{ type: 'text', text: 'Detalle de herramienta uno.' }] },
            { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'Encontré la causa y sigo trabajando.' }] },
            { id: 't2', role: 'tool', content: [{ type: 'text', text: 'Detalle de herramienta dos.' }] },
          ], history: { supported: true, hasEarlier: false },
        };
        return { ok: true, status: 200, headers: {}, body: JSON.stringify(data) };
      }
      if (command.endsWith('check_voice')) return { ok: true, available: false, status: 'os_unsupported' };
      if (command.endsWith('check_availability')) return { available: false, status: 'model_not_ready', supportsSpanish: false };
      if (command.endsWith('results_list') || command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      return { ok: true };
    } };
  });
  await page.goto('/');
  await page.evaluate(async () => {
    document.querySelector<HTMLElement>('#panel-chat')!.hidden = true;
    document.querySelector<HTMLElement>('#panel-agents')!.hidden = false;
    const view = await import('/src/laptop-view.tsx' as string);
    const laptop = view.mountLaptopView(document.querySelector('#laptop-root'), () => {}, () => {});
    laptop.update({ connection: { url: 'wss://laptop.example/ws', token: 'fixture' }, active: true });
  });
  await expect(page.locator('.agent-session')).toHaveCount(6);
  await expect(page.locator('.capri-session-group').filter({ hasText: 'En curso' }).locator('.agent-session')).toHaveCount(2);
  await expect(page.locator('.capri-session-group').filter({ hasText: 'Disponibles' }).locator('.agent-session')).toHaveCount(3);
  await expect(page.locator('.capri-session-group').filter({ hasText: 'Sin conexión' }).locator('.agent-session')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Proyecto 6 · Sin conexión' })).toBeVisible();
  await page.getByRole('button', { name: 'Proyecto 1 · Trabajando' }).click();
  await expect(page.locator('.capri-session-metadata')).toHaveText('Modelo de prueba · Perfil de prueba · gentle_review activa');
  await page.getByRole('button', { name: 'Detalles y actividad' }).click();
  await page.getByRole('button', { name: /Ver información de la sesión/ }).click();
  await page.getByText('Detalles técnicos').click();
  await page.getByText('Conexiones MCP').click();
  await expect(page.getByText('fixture-mcp')).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar detalles' }).click();
  await expect(page.getByText('Estoy revisando el error.')).toBeVisible();
  await expect(page.getByText('Encontré la causa y sigo trabajando.')).toBeVisible();
  await expect(page.getByText('Detalle de herramienta uno.')).toBeHidden();
  const order = await page.locator('.session-turn > article, .session-turn > details').allTextContents();
  expect(order).toEqual([expect.stringContaining('Estoy revisando el error.'), expect.stringContaining('Detalle de herramienta uno.'),
    expect.stringContaining('Encontré la causa y sigo trabajando.'), expect.stringContaining('Detalle de herramienta dos.')]);
  for (const viewport of [{ width: 375, height: 812 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const box = await page.locator('.agent-conversation').boundingBox();
    expect(box).not.toBeNull(); expect(box!.width).toBeGreaterThan(viewport.width * .75);
  }
});
