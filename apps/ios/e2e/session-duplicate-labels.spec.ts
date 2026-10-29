import { expect, test } from './fixtures.ts';

test('sessions with the same title expose their real previews and open their own histories', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as any;
    state.isTauri = true;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('https_request')) {
        const action = args.request.body ? JSON.parse(args.request.body) : undefined;
        const sessions = ['Alfa', 'Beta', 'Sin conexión'].map((name, index) => ({
          paneId: `pane-${index}`, sessionId: `session-${index}`, label: 'Capri', provider: 'herdr', cwd: '/workspace/proyecto',
          lastMessage: `Respuesta ${name}`, state: 'working', connected: index !== 2, managed: true, capabilities: { inspect: true, prompt: true },
        }));
        const reply = action?.action === 'inspect' ? {
          sessionId: action.sessionId, status: 'working', messages: [{ id: 'message', role: 'assistant', content: [{ type: 'text', text: `Historial ${action.sessionId}` }] }],
        } : { available: true, sessions, approvals: [], policies: [], events: [] };
        return { ok: true, status: 200, headers: {}, body: JSON.stringify(reply) };
      }
      if (command.endsWith('check_availability')) return { available: false, status: 'model_not_ready', supportsSpanish: false };
      if (command.endsWith('results_list') || command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      return { ok: true };
    } };
  });
  await page.goto('/');
  await page.evaluate(async () => {
    document.querySelector<HTMLElement>('#panel-chat')!.hidden = true;
    document.querySelector<HTMLElement>('#panel-agents')!.hidden = false;
    const { mountLaptopView } = await import('/src/laptop-view.tsx' as string);
    mountLaptopView(document.querySelector('#laptop-root')!, () => {}, () => {})
      .update({ connection: { url: 'wss://laptop.example/ws', token: 'fixture' }, active: true });
  });
  const alpha = page.getByRole('button', { name: /Capri.*1 de 3 en la lista con este nombre.*proyecto.*Respuesta Alfa/ });
  const beta = page.getByRole('button', { name: /Capri.*2 de 3 en la lista con este nombre.*proyecto.*Respuesta Beta/ });
  const offline = page.getByRole('button', { name: /Capri.*3 de 3 en la lista con este nombre.*proyecto.*Respuesta Sin conexión/ });
  await expect(alpha).toBeVisible(); await expect(beta).toBeVisible();
  await expect(offline).toBeVisible();
  await expect(alpha).toContainText('1 de 3 en la lista con este nombre');
  await expect(beta).toContainText('2 de 3 en la lista con este nombre');
  for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await expect(alpha).toBeVisible(); await expect(beta).toBeVisible();
  }
  await alpha.click(); await expect(page.getByText('Historial session-0')).toBeVisible();
  await page.getByRole('button', { name: 'Todos los agentes' }).click();
  await beta.click(); await expect(page.getByText('Historial session-1')).toBeVisible();
});
