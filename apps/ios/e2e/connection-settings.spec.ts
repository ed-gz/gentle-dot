import { expect, test, type Page } from './fixtures.ts';

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => { const errors: string[] = []; pageErrors.set(page, errors); page.on('pageerror', error => errors.push(error.message)); });
test.afterEach(async ({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

async function fixture(page: Page, schemes = ['capri-auth']) {
  await page.addInitScript(({ schemes }) => {
    const state = globalThis as any;
    state.isTauri = true; state.settingsVault = new Map<string, string>(); state.settingsRequests = []; state.settingsURLs = []; state.settingsOpened = []; state.randomCounter = 0;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      const request = args?.request ?? {}, key = `${request.scope}:${request.account}`;
      if (command.endsWith('|secret_set')) { state.settingsVault.set(key, request.value); return { ok: true, persisted: true }; }
      if (command.endsWith('|secret_get')) return { ok: true, value: state.settingsVault.get(key) };
      if (command.endsWith('|secret_delete')) { state.settingsVault.delete(key); return { ok: true }; }
      if (command.endsWith('|registered_url_schemes')) return { ok: true, schemes };
      if (command.endsWith('|open_external_url')) { state.settingsOpened.push(request.url); return { ok: true }; }
      if (command.endsWith('|crypto_random')) return { ok: true, data: (++state.randomCounter % 2 ? 'v' : 's').repeat(43) };
      if (command.endsWith('|crypto_sha256')) return { ok: true, hex: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.data)))).map(byte => byte.toString(16).padStart(2, '0')).join('') };
      if (command.endsWith('|oauth_authorize')) {
        state.settingsURLs.push(request.authorizationUrl);
        const url = new URL(request.authorizationUrl);
        if (state.holdOAuth) return new Promise(resolve => { state.releaseOAuth = () => resolve({ ok: true, callbackUrl: `${url.searchParams.get('redirect_uri')}?code=fixture-code&state=${url.searchParams.get('state')}` }); });
        return { ok: true, callbackUrl: `${url.searchParams.get('redirect_uri')}?code=fixture-code&state=${url.searchParams.get('state')}` };
      }
      if (command.endsWith('|oauth_cancel')) { state.settingsCancelled = true; return { ok: true }; }
      if (command.endsWith('|https_request')) {
        state.settingsRequests.push(request);
        if (request.url.startsWith('https://custom.example/')) {
          const body = request.url.includes('oauth-protected-resource') ? { resource: 'https://custom.example/mcp', authorization_servers: ['https://custom.example/'], scopes_supported: ['read'] }
            : request.url.includes('oauth-authorization-server') ? { issuer: 'https://custom.example/', authorization_endpoint: 'https://custom.example/authorize', token_endpoint: 'https://custom.example/token', code_challenge_methods_supported: ['S256'], response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['none'] }
            : { access_token: 'fixture-custom-access', refresh_token: 'fixture-custom-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'read' };
          return request.url === 'https://custom.example/mcp' ? { ok: true, status: 401, headers: {}, body: '' }
            : { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
        }
        const body = request.url.includes('/login/device/code') ? { device_code: 'fixture-device-secret', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }
          : request.url.includes('github.com') ? { access_token: 'fixture-github-access', token_type: 'bearer', scope: 'read:user' }
          : request.url.includes('slack.com') ? { ok: true, authed_user: { access_token: 'fixture-slack-access', refresh_token: 'fixture-slack-refresh', token_type: 'user', expires_in: 43200, scope: 'channels:read,channels:history,users:read' } }
          : { access_token: 'fixture-google-access', refresh_token: 'fixture-google-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' };
        return { ok: true, status: 200, headers: {}, body: JSON.stringify(body) };
      }
      if (command.endsWith('|share_list') || command.endsWith('|documents_list')) return { ok: true, items: [] };
      return { ok: false, available: false, status: 'fixture_unavailable' };
    } };
  }, { schemes });
  await page.goto('/');
  await expect(page.locator('#provider-connection')).toBeAttached();
  await page.locator('[data-panel="settings"]').click(); await page.locator('#settings-services > summary').click();
  await page.locator('#connection-editor summary').click();
}

async function metadata(page: Page) { return page.evaluate(async () => { const path = '/src/external-connections.ts'; return (await import(path)).listConnections(); }); }

test('provider form stores PAT only in Keychain and binds edits to the visible revision', async ({ page }) => {
  await fixture(page);
  await page.locator('#connection-provider').selectOption('github');
  await expect(page.locator('#connection-client-id')).toBeHidden();
  await expect(page.locator('#connection-endpoint')).toBeHidden();
  await page.locator('#connection-label').fill('Mi GitHub');
  await page.locator('#connection-secret').fill('fixture-personal-token');
  await page.locator('#connection-save').click();
  await expect(page.locator('#connections-status')).toContainText('Configuración guardada');
  const stored = await metadata(page); expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ provider: 'github', endpoint: 'https://api.github.com/', revision: 1 });
  expect(JSON.stringify(stored)).not.toContain('fixture-personal-token');
  expect(await page.locator('body').innerText()).not.toContain('fixture-personal-token');
  const secret = await page.evaluate(() => [...(globalThis as any).settingsVault.values()]);
  expect(secret).toHaveLength(1); expect(secret[0]).toContain('fixture-personal-token');
  await page.getByRole('button', { name: 'Editar acceso' }).click();
  await expect(page.locator('#connection-secret')).toHaveValue('');
  await page.locator('#connection-label').fill('Mi cambio');
  await page.evaluate(async current => { const path = '/src/external-connections.ts'; await (await import(path)).saveConnection({ ...current, label: 'Otra ventana' }, undefined, current.revision); }, stored[0]);
  await page.locator('#connection-save').click();
  await expect(page.locator('#connections-status')).toContainText('La conexión cambió');
  expect((await metadata(page))[0].label).toBe('Otra ventana');
});

test('an additional MCP service authorizes a public native client and keeps access out of metadata', async ({ page }) => {
  await fixture(page, ['capri-auth', 'dev.gentledot.capri.auth']);
  await page.locator('#connection-provider').selectOption('mcp');
  await page.locator('#connection-label').fill('Mi servicio adicional');
  await page.locator('#connection-endpoint').fill('https://custom.example/mcp');
  await page.locator('#connection-method').selectOption('oauth');
  await page.locator('#connection-client-id').fill('public-capri');
  await expect(page.locator('#connection-permissions')).toBeHidden();
  await expect(page.locator('#connection-scopes')).toBeVisible();
  await page.locator('#connection-save').click();
  await expect(page.locator('#connections-status')).toContainText('Autorización guardada');
  const stored = await metadata(page);
  expect(stored[0]).toMatchObject({ kind: 'mcp', endpoint: 'https://custom.example/mcp', revision: 1 });
  expect(JSON.stringify(stored)).not.toContain('fixture-custom');
  expect(await page.locator('body').innerText()).not.toContain('fixture-custom');
  const secret = await page.evaluate(() => [...(globalThis as any).settingsVault.values()]);
  expect(JSON.parse(secret[0]).mcpOAuth.resource).toBe('https://custom.example/mcp');
});

test('Slack consent uses minimum read scopes and persists refresh credentials without exposing them', async ({ page }) => {
  await fixture(page);
  await page.locator('#connection-provider').selectOption('slack');
  await page.locator('#connection-label').fill('Mi Slack');
  await page.locator('#connection-client-id').fill('123.456');
  await expect(page.locator('#connection-secret')).toBeHidden();
  await page.locator('#connection-save').click();
  await expect(page.locator('#connections-status')).toContainText('Autorización guardada');
  const auth = await page.evaluate(() => ({ urls: (globalThis as any).settingsURLs, requests: (globalThis as any).settingsRequests, vault: [...(globalThis as any).settingsVault.values()] }));
  const url = new URL(auth.urls[0]); expect(url.searchParams.get('scope')).toBe('');
  expect(url.searchParams.get('user_scope')!.split(',').sort()).toEqual(['channels:history', 'channels:read', 'users:read']);
  expect(url.searchParams.get('user_scope')).not.toContain('chat:write');
  expect(auth.requests[0].body).not.toContain('client_secret');
  expect(auth.vault[0]).toContain('fixture-slack-refresh');
  expect(JSON.stringify(await metadata(page))).not.toContain('fixture-slack');
  expect(await page.locator('body').innerText()).not.toContain('fixture-slack');
});

test('Gmail blocks unregistered callback before browser consent and accepts a configured iOS callback', async ({ page }) => {
  await fixture(page, ['capri-auth', 'com.googleusercontent.apps.123-configured']);
  await page.locator('#connection-provider').selectOption('gmail');
  await page.locator('#connection-label').fill('Mi correo');
  await page.locator('#connection-client-id').fill('123-missing.apps.googleusercontent.com');
  await page.locator('#connection-save').click();
  await expect(page.locator('#connections-status')).toContainText('CAPRI_GOOGLE_CLIENT_ID');
  expect(await page.evaluate(() => (globalThis as any).settingsURLs)).toEqual([]);
  expect(await metadata(page)).toEqual([]);
  await page.locator('#connection-client-id').fill('123-configured.apps.googleusercontent.com');
  await page.locator('#connection-permissions').selectOption('write');
  await page.locator('#connection-save').click();
  await expect(page.locator('#connections-status')).toContainText('Autorización guardada');
  const url = new URL(await page.evaluate(() => (globalThis as any).settingsURLs[0]));
  expect(url.searchParams.get('redirect_uri')).toBe('com.googleusercontent.apps.123-configured:/oauth2redirect/google');
  expect(url.searchParams.get('scope')).toContain('gmail.send');
});

test('GitHub device code opens only after human tap and cancellation prevents credential storage', async ({ page }) => {
  await fixture(page);
  await page.locator('#connection-provider').selectOption('github');
  await page.locator('#connection-method').selectOption('oauth');
  await page.locator('#connection-label').fill('GitHub con código');
  await page.locator('#connection-client-id').fill('fixture-client-id');
  await page.locator('#connection-private').selectOption('private');
  await expect(page.locator('#connection-permissions')).toHaveValue('write');
  await expect(page.locator('#connection-permissions option[value="read"]')).toHaveJSProperty('disabled', true);
  await expect(page.locator('#connection-auth-hint')).toContainText('GitHub concede lectura y escritura');
  await page.locator('#connection-save').click();
  await expect(page.locator('#connection-device-code')).toHaveText('ABCD-EFGH');
  const request = await page.evaluate(() => (globalThis as any).settingsRequests[0]);
  expect(new URLSearchParams(request.body).get('scope')).toBe('read:user repo');
  expect(await page.evaluate(() => (globalThis as any).settingsOpened)).toEqual([]);
  await page.locator('#connection-device-open').click();
  expect(await page.evaluate(() => (globalThis as any).settingsOpened)).toEqual(['https://github.com/login/device']);
  await page.locator('#connection-auth-cancel').click();
  await expect(page.locator('#connections-status')).toContainText('Autorización cancelada');
  expect(await metadata(page)).toEqual([]);
  await expect(page.locator('#connection-device-code')).toHaveText('');
});

test('cancelled OAuth discards a late native callback and does not exchange its code', async ({ page }) => {
  await fixture(page); await page.evaluate(() => { (globalThis as any).holdOAuth = true; });
  await page.locator('#connection-provider').selectOption('slack');
  await page.locator('#connection-label').fill('Slack pendiente');
  await page.locator('#connection-client-id').fill('123.456');
  await page.locator('#connection-save').click();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).releaseOAuth)).toBe('function');
  await page.locator('#connection-auth-cancel').click();
  await page.evaluate(() => (globalThis as any).releaseOAuth());
  await expect(page.locator('#connections-status')).toContainText('Autorización cancelada');
  expect(await page.evaluate(() => (globalThis as any).settingsCancelled)).toBe(true);
  expect(await page.evaluate(() => (globalThis as any).settingsRequests)).toEqual([]);
  expect(await metadata(page)).toEqual([]);
});

test('Odoo reveals legacy requirements and removal names the connection before deleting its keychain entry', async ({ page }) => {
  await fixture(page);
  await page.locator('#connection-provider').selectOption('odoo');
  await expect(page.locator('#connection-uid')).toBeHidden();
  await page.locator('#connection-odoo-mode').selectOption('legacy');
  await expect(page.locator('#connection-uid')).toBeVisible();
  await page.locator('#connection-label').fill('Odoo personal');
  await page.locator('#connection-endpoint').fill('https://odoo.example');
  await page.locator('#connection-secret').fill('fixture-odoo-key');
  await page.locator('#connection-database').fill('company_db');
  await page.locator('#connection-uid').fill('17');
  await page.locator('#connection-save').click();
  await expect(page.locator('#connections-status')).toContainText('Configuración guardada');
  expect((await metadata(page))[0]).toMatchObject({ provider: 'odoo', apiMode: 'legacy', database: 'company_db', uid: 17 });
  await page.getByRole('button', { name: 'Quitar conexión' }).click();
  await expect(page.locator('#connections-list .review-card')).toContainText('Quitar Odoo personal');
  expect(await metadata(page)).toHaveLength(1);
  await page.getByRole('button', { name: 'Confirmar eliminación' }).click();
  await expect(page.locator('#connections-status')).toContainText('retirada');
  expect(await metadata(page)).toEqual([]);
  expect(await page.evaluate(() => (globalThis as any).settingsVault.size)).toBe(0);
});

test('provider settings fit small and landscape screens with large text and reduced motion', async ({ page }, testInfo) => {
  await fixture(page); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#connection-provider').selectOption('gmail');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  for (const viewport of [{ width: 375, height: 812 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const id of ['#connection-provider', '#connection-label', '#connection-client-id', '#connection-permissions', '#connection-save']) {
      const box = await page.locator(id).boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await page.locator('#connection-settings').screenshot({ path: testInfo.outputPath(`connections-${viewport.width}.png`) });
  }
});
