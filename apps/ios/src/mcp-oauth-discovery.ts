import { httpsRequest, type HTTPSRequest, type HTTPSResponse } from './device-bridge.ts';
import { validEndpoint } from './external-connections.ts';
import { classifyModernDiscovery, legacyHandshakeRejectedAsModern, modernMCPRequest } from './mcp-modern-protocol.ts';

export type MCPAuthorizationServer = {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
  responseIssuerRequired: boolean;
};
type Request = (request: HTTPSRequest) => Promise<HTTPSResponse>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function mcpScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50 || value.some(scope => typeof scope !== 'string' || !/^[\x21\x23-\x5b\x5d-\x7e]{1,300}$/.test(scope))) {
    throw new Error('El servicio devolvió permisos OAuth inválidos.');
  }
  return [...new Set(value)] as string[];
}

/** Parse challenge boundaries before parameters; never mistake Basic's metadata for Bearer. */
export function mcpChallenge(header: string | undefined): { metadata?: string; scopes?: string[] } {
  if (header === undefined) return {};
  if (header.length > 16384 || /[\r\n\x00]/.test(header)) throw new Error('El desafío de acceso no es válido.');
  const parts = header.match(/(?:[^,"\\]|"(?:[^"\\]|\\.)*")+/g);
  if (!parts || parts.join(',').replace(/\s/g, '') !== header.replace(/\s/g, '')) throw new Error('El desafío de acceso no es válido.');
  let bearer = false, found = false;
  const parameters = new Map<string, string>();
  for (let part of parts) {
    part = part.trim();
    const scheme = /^([A-Za-z][A-Za-z0-9_-]*)(?:\s+(?![ \t]*=)|$)/.exec(part);
    if (scheme) {
      bearer = scheme[1]!.toLowerCase() === 'bearer';
      if (bearer && found) throw new Error('El servidor anunció varios desafíos Bearer.');
      if (bearer) found = true;
      part = part.slice(scheme[0].length);
    }
    if (!bearer || !part) continue;
    const parameter = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s",]+))$/.exec(part);
    if (!parameter) throw new Error('El desafío Bearer no es válido.');
    const name = parameter[1]!.toLowerCase();
    if (parameters.has(name)) throw new Error('El desafío Bearer repite un parámetro.');
    parameters.set(name, (parameter[2] ?? parameter[3]!).replace(/\\(.)/g, '$1'));
  }
  const metadata = parameters.get('resource_metadata'), scope = parameters.get('scope');
  return { ...(metadata !== undefined ? { metadata: validEndpoint(metadata) } : {}),
    ...(scope !== undefined ? { scopes: mcpScopes(scope ? scope.split(' ') : []) } : {}) };
}

function metadataJSON(response: HTTPSResponse): Record<string, unknown> {
  if (response.status !== 200 || new TextEncoder().encode(response.body).length > 65536
    || response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new Error('El servicio no publicó metadatos OAuth JSON verificables.');
  }
  let value: unknown;
  try { value = JSON.parse(response.body); } catch { throw new Error('Los metadatos OAuth no son JSON válido.'); }
  if (!object(value)) throw new Error('Los metadatos OAuth no son un objeto.');
  return value;
}
function endpoint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Falta un endpoint OAuth HTTPS.');
  return validEndpoint(value);
}
function issuerURL(value: unknown): URL {
  const url = new URL(endpoint(value));
  if (url.search) throw new Error('El emisor OAuth no admite parámetros.');
  return url;
}

/** Discovery carries no existing credential. Only 404/405 allows a documented fallback. */
export async function discoverMCPAuthorization(resourceInput: string, signal: AbortSignal, request: Request = httpsRequest): Promise<MCPAuthorizationServer> {
  const resource = validEndpoint(resourceInput), resourceURL = new URL(resource);
  async function get(url: string) {
    signal.throwIfAborted();
    const response = await request({ url, method: 'GET', headers: { Accept: 'application/json' } });
    signal.throwIfAborted();
    return response;
  }
  signal.throwIfAborted();
  // A GET may open an indefinite SSE stream. An unauthenticated initialize has
  // a finite response and cannot invoke a remote tool.
  let probe = await request({ url: resource, method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'capri-oauth-discovery', method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Capri iOS', version: '0.1.0' },
    } }) });
  signal.throwIfAborted();
  if (legacyHandshakeRejectedAsModern(probe, 'capri-oauth-discovery')) {
    // Some modern-only resources validate headers before issuing a challenge.
    // The probe has no credential and cannot invoke a tool.
    const modern = modernMCPRequest('capri-oauth-modern-discovery', 'server/discover');
    probe = await request({ url: resource, ...modern });
    signal.throwIfAborted();
    if (probe.status === 200 && classifyModernDiscovery(probe, 'capri-oauth-modern-discovery') !== 'modern') throw new Error('El servidor no confirmó el descubrimiento MCP moderno.');
    if (![200, 401, 403].includes(probe.status)) throw new Error('El servidor no confirmó el acceso MCP moderno.');
  }
  if (![200, 401, 403, 405].includes(probe.status)) throw new Error('El endpoint MCP no confirmó cómo autorizar el acceso.');
  const challenge = [401, 403].includes(probe.status) ? mcpChallenge(probe.headers['www-authenticate']) : {};
  const resourcePaths = challenge.metadata ? [challenge.metadata] : [...new Set([
    resourceURL.origin + '/.well-known/oauth-protected-resource' + (resourceURL.pathname === '/' ? '' : resourceURL.pathname),
    resourceURL.origin + '/.well-known/oauth-protected-resource',
  ])];
  async function find(urls: string[]) {
    for (const url of urls) {
      const response = await get(url);
      if ([404, 405].includes(response.status)) continue;
      return metadataJSON(response);
    }
    throw new Error('El servicio no ofrece descubrimiento OAuth. Usa su token de acceso o revisa la configuración del servidor.');
  }
  const metadata = await find(resourcePaths);
  if (endpoint(metadata.resource) !== resource) throw new Error('Los metadatos corresponden a otro recurso MCP.');
  if (!Array.isArray(metadata.authorization_servers) || !metadata.authorization_servers.length || metadata.authorization_servers.length > 10) {
    throw new Error('El recurso no identificó su emisor OAuth.');
  }
  // Deterministic choice. Never switch issuers after a failed authorization or refresh.
  const issuers = metadata.authorization_servers.map(issuerURL), issuer = issuers[0]!;
  const path = issuer.pathname === '/' ? '' : issuer.pathname;
  const auth = await find([...new Set([
    issuer.origin + '/.well-known/oauth-authorization-server' + path,
    issuer.origin + '/.well-known/openid-configuration' + path,
    issuer.origin + path.replace(/\/$/, '') + '/.well-known/openid-configuration',
  ])]);
  if (issuerURL(auth.issuer).href !== issuer.href) throw new Error('El emisor OAuth no coincide con el anunciado por el recurso.');
  if (!Array.isArray(auth.code_challenge_methods_supported) || !auth.code_challenge_methods_supported.includes('S256')
    || !Array.isArray(auth.response_types_supported) || !auth.response_types_supported.includes('code')
    || auth.grant_types_supported !== undefined && (!Array.isArray(auth.grant_types_supported) || !auth.grant_types_supported.includes('authorization_code'))
    || auth.token_endpoint_auth_methods_supported !== undefined && (!Array.isArray(auth.token_endpoint_auth_methods_supported) || !auth.token_endpoint_auth_methods_supported.includes('none'))) {
    throw new Error('El emisor debe admitir un cliente público con código y PKCE S256, sin client secret.');
  }
  if (auth.authorization_response_iss_parameter_supported !== undefined && typeof auth.authorization_response_iss_parameter_supported !== 'boolean') {
    throw new Error('La identificación del emisor OAuth no es válida.');
  }
  return { resource, issuer: issuer.href, authorizationEndpoint: endpoint(auth.authorization_endpoint), tokenEndpoint: endpoint(auth.token_endpoint),
    scopes: challenge.scopes ?? mcpScopes(metadata.scopes_supported ?? []), responseIssuerRequired: auth.authorization_response_iss_parameter_supported === true };
}
