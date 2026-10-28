import { httpsRequest, nativeRandom, nativeSHA256, oauthAuthorize, oauthCancel, registeredURLSchemes, type HTTPSRequest } from './device-bridge.ts';
import { MCP_OAUTH_CALLBACK, validateCredentialBundle, type ProviderCredentialBundle } from './external-connections.ts';
import { oauthCallbackCode } from './provider-oauth.ts';
import { discoverMCPAuthorization, mcpScopes, type MCPAuthorizationServer } from './mcp-oauth-discovery.ts';

export type MCPOAuthConfig = { endpoint: string; clientId: string; scopes?: string[] };
const defaults = {
  request: httpsRequest, random: nativeRandom, sha256: nativeSHA256, authorize: oauthAuthorize,
  cancel: oauthCancel, schemes: registeredURLSchemes, now: Date.now,
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function clientID(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('Introduce el client ID público registrado para Capri en ese servicio.');
  return value;
}

/** Native public clients registered by the service; no confidential secret or embedded login. */
export function createMCPOAuth(overrides: Partial<typeof defaults> = {}) {
  const dependencies = { ...defaults, ...overrides };
  let authenticating = false;
  async function post(url: string, values: Record<string, string>): Promise<Record<string, unknown>> {
    const request: HTTPSRequest = { url, method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() };
    const response = await dependencies.request(request);
    if (response.status !== 200 || new TextEncoder().encode(response.body).length > 65536
      || response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new Error('El servicio no confirmó la autorización OAuth. No se repitió el intercambio.');
    let body: unknown;
    try { body = JSON.parse(response.body); } catch { throw new Error('La autorización OAuth no es válida.'); }
    if (!object(body) || body.error !== undefined || typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer') throw new Error('El servicio no concedió una credencial Bearer.');
    return body;
  }
  function credentials(body: Record<string, unknown>, base: Omit<ProviderCredentialBundle, 'accessToken'>, refresh = false): ProviderCredentialBundle {
    if (body.expires_in !== undefined && (!Number.isSafeInteger(body.expires_in) || Number(body.expires_in) < 1 || Number(body.expires_in) > 366 * 86400)) throw new Error('La vigencia OAuth no es válida.');
    if (refresh && (body.refresh_token === undefined || body.refresh_token === base.refreshToken || base.expiresAt !== undefined && body.expires_in === undefined)) throw new Error('El servicio no confirmó la rotación de acceso. Autoriza la cuenta de nuevo.');
    if (body.scope !== undefined && typeof body.scope !== 'string') throw new Error('Los permisos concedidos no son válidos.');
    return validateCredentialBundle({ ...base, accessToken: body.access_token as string,
      refreshToken: body.refresh_token as string | undefined,
      expiresAt: body.expires_in === undefined ? undefined : dependencies.now() + Number(body.expires_in) * 1000,
      scopes: body.scope === undefined ? base.scopes : mcpScopes(body.scope ? (body.scope as string).split(' ') : []),
      obtainedAt: dependencies.now(), refreshState: 'ready' });
  }
  return {
    async authorize(input: MCPOAuthConfig, signal: AbortSignal): Promise<ProviderCredentialBundle> {
      if (authenticating) throw new Error('Ya hay una autorización MCP en curso.');
      const clientId = clientID(input.clientId), requestedScopes = input.scopes === undefined ? undefined : mcpScopes(input.scopes);
      signal.throwIfAborted(); authenticating = true;
      let browserPending = false;
      const cancel = () => { if (browserPending) void dependencies.cancel().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const scheme = new URL(MCP_OAUTH_CALLBACK).protocol.slice(0, -1);
        if (!(await dependencies.schemes()).map(value => value.toLowerCase()).includes(scheme)) throw new Error('Esta IPA no incluye el retorno OAuth MCP. Instala una versión que registre dev.gentledot.capri.auth.');
        const server: MCPAuthorizationServer = await discoverMCPAuthorization(input.endpoint, signal, dependencies.request);
        const scopes = requestedScopes ?? server.scopes;
        const verifier = await dependencies.random(32), state = await dependencies.random(32);
        if (!/^[A-Za-z0-9_-]{43,128}$/.test(verifier) || !/^[A-Za-z0-9_-]{43,128}$/.test(state) || verifier === state) throw new Error('No se pudo preparar una autorización segura.');
        const digest = await dependencies.sha256(verifier);
        if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('No se pudo preparar PKCE.');
        const challenge = btoa(String.fromCharCode(...digest.match(/../g)!.map(byte => Number.parseInt(byte, 16)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
        const authorization = new URL(server.authorizationEndpoint);
        for (const [key, value] of Object.entries({ client_id: clientId, response_type: 'code', redirect_uri: MCP_OAUTH_CALLBACK,
          state, code_challenge: challenge, code_challenge_method: 'S256', resource: server.resource })) authorization.searchParams.set(key, value);
        authorization.searchParams.delete('scope');
        if (scopes.length) authorization.searchParams.set('scope', scopes.join(' '));
        signal.throwIfAborted(); browserPending = true;
        const callback = await dependencies.authorize(authorization.href, scheme);
        browserPending = false; signal.throwIfAborted();
        const code = oauthCallbackCode(callback, MCP_OAUTH_CALLBACK, state);
        const issuer = new URL(callback).searchParams.getAll('iss');
        if (issuer.length > 1 || server.responseIssuerRequired && issuer.length !== 1
          || issuer.length === 1 && new URL(issuer[0]!).href !== server.issuer) throw new Error('La respuesta OAuth pertenece a otro emisor.');
        const body = await post(server.tokenEndpoint, { client_id: clientId, code, code_verifier: verifier, redirect_uri: MCP_OAUTH_CALLBACK,
          grant_type: 'authorization_code', resource: server.resource });
        signal.throwIfAborted();
        return credentials(body, { clientId, redirectUri: MCP_OAUTH_CALLBACK, scopes,
          mcpOAuth: { resource: server.resource, issuer: server.issuer, tokenEndpoint: server.tokenEndpoint } });
      } finally {
        authenticating = false; browserPending = false; signal.removeEventListener('abort', cancel);
      }
    },
    /** A durable store must reserve this refresh before the possibly one-use request. */
    async refresh(previous: ProviderCredentialBundle): Promise<ProviderCredentialBundle> {
      const bundle = validateCredentialBundle(previous);
      if (!bundle.mcpOAuth || !bundle.refreshToken || !bundle.clientId) throw new Error('Autoriza esta conexión MCP de nuevo.');
      const body = await post(bundle.mcpOAuth.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: bundle.refreshToken,
        client_id: clientID(bundle.clientId), resource: bundle.mcpOAuth.resource });
      return credentials(body, bundle, true);
    },
  };
}
