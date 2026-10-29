import { expect, test } from './fixtures.ts';

const endpoint = 'wss://laptop.example.ts.net/ws';
const origin = 'https://laptop.example.ts.net';
const pairedToken = 'paired_fixture_token_1234567890ABCDEFG';
const manualToken = 'manual_fixture_token';
const invitation = `gentledot://pair?url=${encodeURIComponent(origin)}&code=${'x'.repeat(32)}&name=Gentle+Dot`;

async function fixture(page: import('@playwright/test').Page, options: { rejectManual?: boolean; rejectPairAfterManual?: boolean; offlinePair?: boolean; noLegacy?: boolean; bothLegacy?: boolean; failActive?: boolean; holdPair?: boolean; failPair?: boolean } = {}) {
  const hellos: string[] = [];
  await page.routeWebSocket(endpoint, ws => {
    let seq = 0;
    ws.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello') {
        hellos.push(message.token);
        if (options.rejectManual && message.token === manualToken) { ws.close({ code: 4401, reason: 'fixture' }); return; }
        if (options.rejectPairAfterManual && message.token === pairedToken && hellos.includes(manualToken)) { ws.close({ code: 4401, reason: 'fixture' }); return; }
        if (options.offlinePair && message.token === pairedToken && (options.noLegacy || hellos.includes(manualToken))) { ws.close({ code: 1001, reason: 'fixture offline' }); return; }
        ws.send(JSON.stringify({ seq: seq++, type: 'ready', agentState: 'idle', conversationId: 'fixture' }));
      }
      if (message.type === 'get_history') ws.send(JSON.stringify({ seq: seq++, type: 'history', conversationId: 'fixture', messages: [] }));
    });
  });
  await page.addInitScript(({ endpoint, origin, pairedToken, manualToken, invitation, bothLegacy, failActive, noLegacy, holdPair, failPair }) => {
    const state = globalThis as any;
    state.isTauri = true; state.failActive = failActive; state.pairCalls = 0;
    const key = 'fixture-keychain';
    if (!localStorage.getItem(key)) {
      const initial: Record<string, string> = {};
      if (!noLegacy) initial[`daemon-pairing:${origin}`] = JSON.stringify({ url: endpoint, token: pairedToken, deviceId: 'phone-a', name: 'Capri' });
      if (bothLegacy) initial[`daemon-manual:${origin}`] = manualToken;
      localStorage.setItem(key, JSON.stringify(initial));
      localStorage.setItem('capri.ios.settings.v1', JSON.stringify({ url: endpoint, motion: 'reduced' }));
    }
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('|secret_get')) {
        const values = JSON.parse(localStorage.getItem(key)!); const value = values[`${args.request.scope}:${args.request.account}`];
        return value === undefined ? { ok: true } : { ok: true, value };
      }
      if (command.endsWith('|secret_set')) {
        const values = JSON.parse(localStorage.getItem(key)!);
        if (state.loseNextCAS && args.request.account === 'capri.selected-connection.v1') {
          state.loseNextCAS=false;
          state.releaseLostCAS=()=>{const current=JSON.parse(localStorage.getItem(key)!);const k=`daemon-manual:${args.request.account}`;if((current[k] ?? null)!==(args.request.expected ?? null))return false;current[k]=args.request.value;localStorage.setItem(key,JSON.stringify(current));return true;};
          throw new Error('synthetic callback loss before native execution');
        }
        if (args.request.account === 'capri.selected-connection.v1' && args.request.compare !== true) return {ok:false,error:'invalid_request'};
        if (args.request.account === 'capri.selected-connection.v1' && (values[`daemon-manual:${args.request.account}`] ?? null) !== (args.request.expected ?? null)) return {ok:true,persisted:false};
        if (args.request.account === 'capri.selected-connection.v1' && JSON.parse(args.request.value).state === 'active' && state.failActive && args.request.expected && JSON.parse(args.request.expected).state === 'pending')
          return { ok: false, error: 'storage' };
        values[`${args.request.scope}:${args.request.account}`] = args.request.value;
        localStorage.setItem(key, JSON.stringify(values)); return { ok: true, persisted: true };
      }
      if (command.endsWith('|pairing_scan')) return { ok: true, cancelled: false, value: invitation };
      if (command.endsWith('|pair_device')) {
        state.pairCalls++;
        const connection = { url: endpoint, token: pairedToken, deviceId: 'phone-a', name: 'Capri' };
        if (failPair) return {ok:false,error:'network'};
        const values = JSON.parse(localStorage.getItem(key)!); values[`daemon-pairing:attempt:${args.request.attemptId}`] = JSON.stringify(connection);
        localStorage.setItem(key, JSON.stringify(values));
        if (holdPair) return await new Promise(resolve => { state.finishPair = () => resolve({ok:true,persisted:true,connection}); });
        return { ok: true, persisted: true, connection };
      }
      if (command.endsWith('results_list') || command.endsWith('|share_list') || command.endsWith('|documents_list')) return { ok: true, items: [] };
      if (command.endsWith('check_availability')) return { available: false, status: 'model_not_ready', supportsSpanish: false };
      return { ok: true };
    } };
  }, { endpoint, origin, pairedToken, manualToken, invitation, ...options });
  await page.goto('/');
  return hellos;
}
async function settings(page: import('@playwright/test').Page) {
  await page.locator('[data-panel="settings"]').click();
  await page.getByText('Conexión manual', { exact: true }).click();
}
async function manual(page: import('@playwright/test').Page) {
  await page.locator('#url').fill(endpoint); await page.locator('#token').fill(manualToken);
  await page.locator('#connection button[type="submit"]').click();
}

test('legacy ambiguity requires a choice and the selected manual credential is restored after restart', async ({ page }) => {
  const hellos = await fixture(page, { bothLegacy: true });
  await settings(page);
  await expect(page.locator('#status')).toContainText('dos accesos');
  expect(hellos).toEqual([]);
  await manual(page);
  await expect(page.locator('#status')).toContainText('Acceso guardado');
  expect(hellos).toEqual([manualToken]);
  await page.reload();
  await expect.poll(() => hellos.length).toBe(2);
  expect(hellos).toEqual([manualToken, manualToken]);
});

test('choosing QR pairing after manual selection restores its device credential', async ({ page }) => {
  const hellos = await fixture(page); await settings(page);
  await expect.poll(() => hellos.length).toBe(1); await manual(page);
  await expect(page.locator('#status')).toContainText('Acceso guardado');
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click();
  await page.getByRole('button', { name: 'Vincular iPhone', exact: true }).click();
  await expect(page.locator('#pairing-status')).toContainText('Acceso guardado');
  await page.reload();
  await expect.poll(() => hellos.length).toBe(4);
  expect(hellos).toEqual([pairedToken, manualToken, pairedToken, pairedToken]);
});

test('an interrupted pairing recovers the exact native attempt only after a human retry and handshake', async ({page}) => {
  const hellos=await fixture(page,{noLegacy:true,holdPair:true});await settings(page);await manual(page);
  await expect(page.locator('#status')).toContainText('Acceso guardado');
  await page.getByRole('button',{name:'Escanear QR',exact:true}).click();await page.getByRole('button',{name:'Vincular iPhone',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof (globalThis as any).finishPair)).toBe('function');
  expect(hellos).toEqual([manualToken]);
  await page.reload();await page.locator('[data-panel="settings"]').click();
  await expect(page.locator('#retry-pending-access')).toBeVisible();
  expect(hellos).toEqual([manualToken]);
  await page.locator('#retry-pending-access').click();
  await expect(page.locator('#pairing-status')).toContainText('Acceso guardado');
  expect(hellos).toEqual([manualToken,pairedToken]);
  await page.reload();await expect.poll(()=>hellos.length).toBe(3);expect(hellos[2]).toBe(pairedToken);
});

test('an uncertain pairing response preserves the attempt and does not redeem the invitation again', async ({page}) => {
  const hellos=await fixture(page,{noLegacy:true,failPair:true});await settings(page);await manual(page);
  await expect(page.locator('#status')).toContainText('Acceso guardado');
  await page.getByRole('button',{name:'Escanear QR',exact:true}).click();await page.getByRole('button',{name:'Vincular iPhone',exact:true}).click();
  await expect(page.locator('#retry-pending-access')).toBeVisible();
  await page.locator('#retry-pending-access').click();
  await expect(page.locator('#pairing-status')).toContainText('aún no tiene un acceso guardado');
  expect(await page.evaluate(()=>(globalThis as any).pairCalls)).toBe(1);expect(hellos).toEqual([manualToken]);
  await page.reload();await page.locator('[data-panel="settings"]').click();
  await expect(page.locator('#retry-pending-access')).toBeVisible();await expect(page.locator('#recover-previous-access')).toBeVisible();
  expect(hellos).toEqual([manualToken]);
});

test('a lost CAS callback blocks connection changes and disconnect fences the delayed write', async ({page}) => {
  const hellos=await fixture(page);await settings(page);await expect.poll(()=>hellos.length).toBe(1);
  await page.evaluate(()=>{(globalThis as any).loseNextCAS=true;});await manual(page);
  await expect(page.locator('#status')).toContainText('No se confirmó el guardado');
  await page.locator('#connection button[type="submit"]').click();
  await expect(page.locator('#status')).toContainText('Desconecta antes');
  await page.locator('#disconnect').click();await expect(page.locator('#status')).toHaveText('Sin conexión');
  expect(await page.evaluate(()=>(globalThis as any).releaseLostCAS())).toBe(false);
  await page.reload();await expect(page.locator('#status')).toHaveText('Sin conexión');
  expect(hellos).toEqual([pairedToken]);
});

test('rejected manual token restores the previous paired connection', async ({ page }) => {
  const hellos = await fixture(page, { rejectManual: true }); await settings(page);
  await expect.poll(() => hellos.length).toBe(1); await manual(page);
  await expect.poll(() => hellos.length).toBe(3);
  expect(hellos).toEqual([pairedToken, manualToken, pairedToken]);
  await page.reload(); await expect.poll(() => hellos.length).toBe(4);
  expect(hellos.at(-1)).toBe(pairedToken);
});

test('QR accepted by the host is not selected if its socket rejects authentication', async ({ page }) => {
  const hellos = await fixture(page, { rejectPairAfterManual: true }); await settings(page);
  await expect.poll(() => hellos.length).toBe(1); await manual(page);
  await expect(page.locator('#status')).toContainText('Acceso guardado');
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click();
  await page.getByRole('button', { name: 'Vincular iPhone', exact: true }).click();
  await expect(page.locator('#pairing-status')).toContainText('No se confirmó');
  const recover = page.locator('#recover-previous-access'); await expect(recover).toBeVisible();
  await recover.click(); await expect(page.locator('#pairing-status')).toContainText('Acceso anterior recuperado');
  await page.reload(); await expect.poll(() => hellos.at(-1)).toBe(manualToken);
});

for (const noLegacy of [true, false]) {
  test(`temporary QR socket failure never schedules an untracked candidate reconnect (${noLegacy ? 'no previous access' : 'with previous access'})`, async ({ page }) => {
    const hellos = await fixture(page, { offlinePair: true, noLegacy }); await settings(page);
    if (!noLegacy) { await expect.poll(() => hellos.length).toBe(1); await manual(page); await expect(page.locator('#status')).toContainText('Acceso guardado'); }
    await page.getByRole('button', { name: 'Escanear QR', exact: true }).click();
    await page.getByRole('button', { name: 'Vincular iPhone', exact: true }).click();
    await expect(page.locator('#pairing-status')).toContainText('No se confirmó');
    await expect.poll(() => hellos.length).toBe(noLegacy ? 1 : 4);
    const count = hellos.length; await page.waitForTimeout(1200); expect(hellos.length).toBe(count);
    if (!noLegacy) expect(hellos.at(-1)).toBe(manualToken);
  });
}

test('failed active Keychain write is explicit, preserves prior access, and can be retried', async ({ page }) => {
  const hellos = await fixture(page, { failActive: true }); await settings(page);
  await expect.poll(() => hellos.length).toBe(1); await manual(page);
  const retry = page.locator('#retry-manual-save'); await expect(retry).toBeVisible();
  await expect(page.locator('#status')).toContainText('no pude guardar');
  await page.evaluate(() => { (globalThis as any).failActive = false; });
  await retry.click(); await expect(retry).toBeHidden();
  await expect(page.locator('#status')).toContainText('Acceso guardado');
  await page.reload(); await expect.poll(() => hellos.length).toBe(3);
  expect(hellos).toEqual([pairedToken, manualToken, manualToken]);
});

test('a failed save survives restart without auto-selecting the wrong credential and can recover the prior pairing', async ({ page }) => {
  const hellos = await fixture(page, { failActive: true }); await settings(page);
  await expect.poll(() => hellos.length).toBe(1); await manual(page);
  await expect(page.locator('#retry-manual-save')).toBeVisible();
  await page.reload(); await page.locator('[data-panel="settings"]').click();
  const recover = page.locator('#recover-previous-access'); await expect(recover).toBeVisible();
  expect(hellos).toEqual([pairedToken, manualToken]);
  await page.evaluate(() => { (globalThis as any).failActive = false; });
  await recover.click(); await expect.poll(() => hellos.length).toBe(3);
  expect(hellos.at(-1)).toBe(pairedToken);
  await expect(page.locator('#pairing-status')).toContainText('Acceso anterior recuperado');
});

test('an active Keychain selection restores the correct host even if settings are missing or stale', async ({ page }) => {
  const hellos = await fixture(page); await settings(page);
  await expect.poll(() => hellos.length).toBe(1); await manual(page);
  await expect(page.locator('#status')).toContainText('Acceso guardado');
  await page.evaluate(() => localStorage.setItem('capri.ios.settings.v1', JSON.stringify({ url: 'wss://old.example.ts.net/ws', motion: 'reduced' })));
  await page.reload(); await expect.poll(() => hellos.length).toBe(3);
  await page.locator('[data-panel="settings"]').click();
  await expect(page.locator('#url')).toHaveValue(endpoint);
  await page.evaluate(() => localStorage.removeItem('capri.ios.settings.v1'));
  await page.reload(); await expect.poll(() => hellos.length).toBe(4);
  expect(hellos).toEqual([pairedToken, manualToken, manualToken, manualToken]);
});

test('disconnect stays disconnected after restart even when older credentials remain', async ({ page }) => {
  const hellos = await fixture(page); await settings(page);
  await expect.poll(() => hellos.length).toBe(1);
  await page.locator('#disconnect').click(); await expect(page.locator('#status')).toHaveText('Sin conexión');
  await page.reload(); await page.waitForTimeout(500);
  expect(hellos).toEqual([pairedToken]);
});
