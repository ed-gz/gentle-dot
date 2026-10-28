import { httpsRequest, nativeRandom, nativeSHA256, oauthAuthorize, oauthCancel, type HTTPSRequest, type HTTPSResponse } from './device-bridge.ts';
import { validateCredentialBundle, type ProviderCredentialBundle } from './external-connections.ts';

export type OAuthProvider = 'github' | 'slack' | 'gmail';
export type ProviderOAuthConfig = { provider: OAuthProvider; clientId: string; scopes: string[]; redirectUri?: string };
export type DeviceAuthorization = { userCode: string; verificationUri: string; expiresAt: number };
export interface ProviderOAuthDependencies {
  request(request: HTTPSRequest): Promise<HTTPSResponse>;
  random(bytes: number): Promise<string>;
  sha256(text: string): Promise<string>;
  authorize(url: string, scheme: string): Promise<string>;
  cancel(): Promise<void>;
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}
const endpoints = {
  github: { authorize: 'https://github.com/login/device/code', token: 'https://github.com/login/oauth/access_token' },
  slack: { authorize: 'https://slack.com/oauth/v2/authorize', token: 'https://slack.com/api/oauth.v2.access' },
  gmail: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token' },
} as const;
export const PROVIDER_API_ENDPOINTS = { github: 'https://api.github.com/', slack: 'https://slack.com/api/', gmail: 'https://gmail.googleapis.com/' } as const;
const scopes: Record<OAuthProvider, Set<string>> = {
  github: new Set(['read:user', 'repo', 'public_repo', 'read:org', 'offline_access']),
  slack: new Set(['channels:read', 'groups:read', 'im:read', 'mpim:read', 'channels:history', 'groups:history', 'im:history', 'mpim:history', 'users:read', 'search:read', 'chat:write']),
  gmail: new Set(['openid', 'email', 'profile', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify']),
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function safeString(value: unknown, max = 12000): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('El proveedor devolvió una credencial o identificador inválido.');
  return value;
}
function seconds(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error('El proveedor devolvió una vigencia inválida.');
  return value as number;
}
function validateClientConfig(input: ProviderOAuthConfig): ProviderOAuthConfig {
  if (!input || !['github', 'slack', 'gmail'].includes(input.provider)) throw new Error('Proveedor OAuth no compatible.');
  const clientId = safeString(input.clientId, 200);
  const result: ProviderOAuthConfig = { provider: input.provider, clientId, scopes: input.scopes };
  if (input.provider === 'github') {
    if (!/^[A-Za-z0-9_.-]{8,100}$/.test(clientId) || input.redirectUri !== undefined) throw new Error('GitHub usa device flow con client ID público, sin redirect ni client secret.');
    return result;
  }
  const redirect = new URL(safeString(input.redirectUri, 2048));
  if (redirect.username || redirect.password || redirect.search || redirect.hash) throw new Error('El callback no admite credenciales, parámetros ni fragmentos.');
  if (input.provider === 'slack') {
    if (!/^\d+\.\d+$/.test(clientId) || redirect.protocol !== 'capri-auth:' || redirect.hostname !== 'oauth' || redirect.pathname !== '/slack') throw new Error('Slack requiere un cliente PKCE público y el callback capri-auth://oauth/slack.');
  } else {
    if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)
      || redirect.protocol !== clientId.split('.').reverse().join('.') + ':'
      || redirect.hostname || !redirect.pathname.startsWith('/') || redirect.pathname.startsWith('//')) throw new Error('Google requiere un client ID de iOS y su esquema invertido registrado en esta app.');
  }
  result.redirectUri = redirect.href;
  return result;
}
export function validateOAuthConfig(input: ProviderOAuthConfig): ProviderOAuthConfig {
  const config = validateClientConfig(input);
  if (!Array.isArray(config.scopes) || !config.scopes.length || config.scopes.length > 20 || config.scopes.some(scope => !scopes[config.provider].has(scope))) throw new Error('Solicita únicamente scopes compatibles con este cliente público.');
  return { ...config, scopes: [...new Set(config.scopes)].sort() };
}
/** Never accept a code from another path, state, duplicate parameter or fragment. */
export function oauthCallbackCode(callback: string, redirectUri: string, expectedState: string): string {
  const received = new URL(callback), expected = new URL(redirectUri);
  if (callback.length > 16384 || received.protocol !== expected.protocol || received.hostname !== expected.hostname
    || received.port !== expected.port || received.pathname !== expected.pathname || received.username || received.password || received.hash
    || received.searchParams.getAll('state').length !== 1 || received.searchParams.get('state') !== expectedState) throw new Error('La autorización no corresponde a la solicitud iniciada en Capri.');
  if (received.searchParams.has('error')) throw new Error('La autorización fue rechazada o cancelada por el proveedor.');
  if (received.searchParams.getAll('code').length !== 1) throw new Error('No se recibió un código único de autorización.');
  return safeString(received.searchParams.get('code'), 4000);
}
function grantedScopes(value: unknown, previous: string[]): string[] {
  if (value === undefined) return previous;
  if (typeof value !== 'string' || value.length > 12000) throw new Error('El proveedor devolvió scopes inválidos.');
  const result = [...new Set(value.split(/[,\s]+/).filter(Boolean))];
  if (result.length > 50 || result.some(scope => scope.length > 300 || /[\u0000-\u0020\u007f]/.test(scope))) throw new Error('El proveedor devolvió scopes inválidos.');
  return result;
}
function credentials(config: ProviderOAuthConfig, body: Record<string, unknown>, now: number, previous?: ProviderCredentialBundle): ProviderCredentialBundle {
  let source = body;
  if (config.provider === 'slack') {
    if (body.ok !== true) throw new Error('Slack no concedió la autorización. Comprueba PKCE, scopes y configuración de la app.');
    source = object(body.authed_user) ? body.authed_user : body;
    if (source.token_type !== 'user') throw new Error('El cliente público de Capri sólo acepta tokens de usuario de Slack.');
  } else if (typeof source.token_type !== 'string' || source.token_type.toLowerCase() !== 'bearer') throw new Error('El proveedor no devolvió un token Bearer compatible.');
  if (source.error !== undefined) throw new Error('El proveedor rechazó la credencial. Vuelve a autorizar la cuenta.');
  const refreshToken = source.refresh_token === undefined ? previous?.refreshToken : safeString(source.refresh_token);
  if (previous?.expiresAt !== undefined && source.expires_in === undefined) throw new Error('El proveedor no informó la vigencia de la credencial renovada.');
  if (config.provider === 'github' && previous && source.refresh_token === undefined) throw new Error('GitHub no devolvió la credencial de renovación rotada.');
  if (config.provider === 'slack' && (!refreshToken || source.expires_in === undefined || (previous && source.refresh_token === undefined))) throw new Error('Slack no devolvió sus nuevas credenciales rotatorias.');
  return validateCredentialBundle({
    provider: config.provider, clientId: config.clientId, ...(config.redirectUri ? { redirectUri: config.redirectUri } : {}),
    accessToken: safeString(source.access_token), ...(refreshToken ? { refreshToken } : {}),
    ...(source.expires_in !== undefined ? { expiresAt: now + seconds(source.expires_in, 366 * 86400) * 1000 } : {}),
    scopes: grantedScopes(source.scope, previous?.scopes ?? config.scopes), obtainedAt: now, refreshState: 'ready',
  });
}
const defaults: ProviderOAuthDependencies = {
  request: httpsRequest, random: nativeRandom, sha256: nativeSHA256, authorize: oauthAuthorize, cancel: oauthCancel, now: Date.now,
  sleep(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const cancel = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, milliseconds);
      signal.addEventListener('abort', cancel, { once: true });
    });
  },
};

/** UI authentication only. Do not register this object as an LLM tool or log its results. */
export function createProviderOAuth(overrides: Partial<ProviderOAuthDependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  let authenticating = false;
  async function post(url: string, values: Record<string, string>) {
    const response = await dependencies.request({ url, method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() });
    if (![200, 400, 401, 403].includes(response.status) || response.body.length > 65536) throw new Error('El proveedor no confirmó la autorización. No se reintentó el intercambio.');
    let body: unknown;
    try { body = JSON.parse(response.body); } catch { throw new Error('El proveedor devolvió una autorización inválida.'); }
    if (!object(body)) throw new Error('El proveedor devolvió una autorización inválida.');
    return body;
  }
  return {
    async authorize(input: ProviderOAuthConfig, signal: AbortSignal, presentDevice?: (authorization: DeviceAuthorization) => void | Promise<void>): Promise<ProviderCredentialBundle> {
      if (authenticating) throw new Error('Ya hay una autorización en curso.');
      const config = validateOAuthConfig(input); signal.throwIfAborted(); authenticating = true;
      let browserPending = false;
      const cancel = () => { if (browserPending) void dependencies.cancel().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        if (config.provider === 'github') {
          if (!presentDevice) throw new Error('Muestra el código de GitHub y su enlace oficial antes de continuar.');
          const device = await post(endpoints.github.authorize, { client_id: config.clientId, scope: config.scopes.join(' ') });
          signal.throwIfAborted();
          const deviceCode = safeString(device.device_code, 200), userCode = safeString(device.user_code, 30);
          if (device.verification_uri !== 'https://github.com/login/device') throw new Error('GitHub devolvió una dirección de autorización inesperada.');
          const expiresAt = dependencies.now() + seconds(device.expires_in, 3600) * 1000;
          let interval = seconds(device.interval, 60) * 1000;
          await presentDevice({ userCode, verificationUri: device.verification_uri, expiresAt });
          while (dependencies.now() < expiresAt) {
            signal.throwIfAborted();
            await dependencies.sleep(Math.min(interval, expiresAt - dependencies.now()), signal);
            signal.throwIfAborted();
            if (dependencies.now() >= expiresAt) break;
            const body = await post(endpoints.github.token, { client_id: config.clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
            signal.throwIfAborted();
            if (body.error === 'authorization_pending') continue;
            if (body.error === 'slow_down') { interval = Math.min(interval + 5000, 300000); continue; }
            if (body.error !== undefined) throw new Error('GitHub no autorizó el dispositivo. Repite la vinculación para obtener un código nuevo.');
            return credentials(config, body, dependencies.now());
          }
          throw new Error('El código de GitHub venció. Inicia una autorización nueva.');
        }
        const verifier = await dependencies.random(32), state = await dependencies.random(32);
        if (!/^[A-Za-z0-9_-]{43,128}$/.test(verifier) || !/^[A-Za-z0-9_-]{43,128}$/.test(state) || verifier === state) throw new Error('No se pudo generar una autorización segura.');
        const digest = await dependencies.sha256(verifier);
        if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('No se pudo preparar PKCE.');
        const challenge = btoa(String.fromCharCode(...digest.match(/../g)!.map(byte => Number.parseInt(byte, 16)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
        const authorization = new URL(endpoints[config.provider].authorize);
        authorization.searchParams.set('client_id', config.clientId);
        authorization.searchParams.set('redirect_uri', config.redirectUri!);
        authorization.searchParams.set('state', state);
        authorization.searchParams.set('code_challenge', challenge);
        authorization.searchParams.set('code_challenge_method', 'S256');
        if (config.provider === 'slack') {
          authorization.searchParams.set('scope', '');
          authorization.searchParams.set('user_scope', config.scopes.join(','));
        } else {
          authorization.searchParams.set('response_type', 'code');
          authorization.searchParams.set('scope', config.scopes.join(' '));
          authorization.searchParams.set('access_type', 'offline');
          authorization.searchParams.set('prompt', 'consent');
        }
        signal.throwIfAborted(); browserPending = true;
        const callback = await dependencies.authorize(authorization.href, new URL(config.redirectUri!).protocol.slice(0, -1));
        browserPending = false; signal.throwIfAborted();
        const code = oauthCallbackCode(callback, config.redirectUri!, state);
        const body = await post(endpoints[config.provider].token, { client_id: config.clientId, code, redirect_uri: config.redirectUri!, grant_type: 'authorization_code', code_verifier: verifier });
        signal.throwIfAborted();
        return credentials(config, body, dependencies.now());
      } finally {
        browserPending = false; authenticating = false;
        signal.removeEventListener('abort', cancel);
      }
    },
    /** Caller must durably reserve a single refresh before sending this request. No retries. */
    async refresh(previous: ProviderCredentialBundle): Promise<ProviderCredentialBundle> {
      const bundle = validateCredentialBundle(previous);
      if (!bundle.refreshToken || !bundle.clientId || !bundle.provider || bundle.provider === 'odoo') throw new Error('Esta cuenta requiere una nueva autorización.');
      // Providers may normalize or return grants from earlier consent. Refresh
      // never requests scopes, so retain that evidence without authorizing a
      // new scope or applying the initial-consent allowlist to existing grants.
      const config = validateClientConfig({ provider: bundle.provider, clientId: bundle.clientId, scopes: bundle.scopes ?? [],
        ...(bundle.redirectUri ? { redirectUri: bundle.redirectUri } : {}) });
      const body = await post(endpoints[config.provider].token, { client_id: config.clientId, grant_type: 'refresh_token', refresh_token: bundle.refreshToken });
      return credentials(config, body, dependencies.now(), bundle);
    },
  };
}
