import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures.ts';

test.use({ ignoreHTTPSErrors: true });

test('iOS pages a real offline Pi branch through an isolated daemon and WebSocket', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  const dir = mkdtempSync(join(tmpdir(), 'capri-history-e2e-'));
  const child = fork(fileURLToPath(new URL('./support/isolated-history-daemon.mjs', import.meta.url)), [], {
    env: { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'), XDG_STATE_HOME: join(dir, 'state'), XDG_RUNTIME_DIR: dir,
      CAPRI_FIXTURE_DIR: dir, CAPRI_FIXTURE_ORIGIN: new URL(baseURL!).origin },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let diagnostics = ''; child.stderr?.on('data', data => { diagnostics += String(data).slice(0, 2000); });
  const requests: Record<string, unknown>[] = [], responses: Record<string, unknown>[] = [];
  page.on('websocket', socket => {
    socket.on('framesent', event => { try { const value = JSON.parse(String(event.payload)); if (value.type === 'get_earlier') requests.push(value); } catch {} });
    socket.on('framereceived', event => { try { const value = JSON.parse(String(event.payload)); if (value.type === 'earlier') responses.push(value); } catch {} });
  });
  try {
    const server = await new Promise<{ url: string; token: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Isolated daemon startup timed out.')), 30_000);
      child.once('message', value => { clearTimeout(timer); resolve(value as { url: string; token: string }); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Isolated daemon exited (${code}): ${diagnostics}`)); });
    });
    await page.goto('/'); await page.locator('[data-panel="settings"]').click();
    await page.getByText('Conexión manual', { exact: true }).click();
    await page.locator('#url').fill(server.url); await page.locator('#token').fill(server.token);
    await page.locator('#connection button[type="submit"]').click();
    await expect(page.locator('#status')).toHaveText('Vinculado a Gentle Dot');
    await page.locator('[data-panel="chat"]').click();
    await expect(page.getByText('Mensaje actual sintético', { exact: true })).toBeVisible();
    await expect(page.getByText('Rama abandonada sintética', { exact: true })).toHaveCount(0);
    await page.locator('#earlier-history').click();
    await expect(page.getByText('Mensaje raíz sintético', { exact: true })).toBeVisible();
    expect(requests).toHaveLength(1); expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ type: 'earlier', before: requests[0]!.before, requestId: requests[0]!.requestId,
      conversationId: requests[0]!.conversationId, branchVerified: true, hasEarlier: false });
    await expect(page.locator('#earlier-history')).toBeHidden();
    await expect(page.getByText('Rama abandonada sintética', { exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(async () => {
      const archive = await import('/src/conversation-archive.ts');
      return (await archive.conversationArchive.page({ limit: 100 })).entries.some(entry => entry.text === 'Mensaje raíz sintético');
    })).toBe(true);
    // The token is intentionally not persisted; reconnect with the same
    // synthetic credential and verify paging again without duplicating cards.
    await page.reload();
    await page.locator('[data-panel="settings"]').click(); await page.getByText('Conexión manual', { exact: true }).click();
    await page.locator('#token').fill(server.token); await page.locator('#connection button[type="submit"]').click();
    await expect(page.locator('#status')).toHaveText('Vinculado a Gentle Dot'); await page.locator('[data-panel="chat"]').click();
    await expect(page.getByText('Mensaje actual sintético', { exact: true })).toBeVisible();
    await page.locator('#earlier-history').click(); await expect(page.getByText('Mensaje raíz sintético', { exact: true })).toHaveCount(1);
    expect(requests).toHaveLength(2); expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId);
    await expect(page.getByText('Rama abandonada sintética', { exact: true })).toHaveCount(0);
    await page.reload();
    await expect.poll(() => page.evaluate(async () => {
      const archive = await import('/src/conversation-archive.ts');
      return (await archive.conversationArchive.page({ limit: 100 })).entries.some(entry => entry.text === 'Mensaje raíz sintético');
    })).toBe(true);
  } finally {
    if (child.connected) child.send('close');
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
