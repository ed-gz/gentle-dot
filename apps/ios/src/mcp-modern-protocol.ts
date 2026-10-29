/** Bounded wire helpers for the experimental MCP 2026-07-28 path.
 * No network or tool execution takes place in this module. */
import { canonicalJSON, parseMCPResponse } from './mcp-json.ts';
import type { HTTPSResponse } from './device-bridge.ts';

export const MODERN_MCP_VERSION = '2026-07-28';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const bytes = (value: string) => new TextEncoder().encode(value).length;
export class MCPModernVersionUnsupported extends Error {
  readonly supportedVersions: string[];
  constructor(supportedVersions: string[]) { super('El servidor MCP no admite esta versión; no se cambió de protocolo.'); this.supportedVersions = supportedVersions; }
}

/** A correlated rejection of the legacy handshake can justify a harmless
 * modern discovery probe. It never authorizes a tool call or a downgrade. */
export function legacyHandshakeRejectedAsModern(response: HTTPSResponse, id: string): boolean {
  if (response.status !== 400 || bytes(response.body) > 64 * 1024) return false;
  try {
    const message: unknown = JSON.parse(response.body);
    return object(message) && message.jsonrpc === '2.0' && message.id === id && !('result' in message) && object(message.error) &&
      typeof message.error.message === 'string' && typeof message.error.code === 'number' && [-32020, -32022, -32602].includes(message.error.code);
  } catch { return false; }
}

/** These methods are the only ones modelled by this prototype. Validation,
 * authorization, approval and durable execution remain the caller's duty. */
export function modernMCPRequest(id: string, method: 'server/discover' | 'tools/list' | 'tools/call', params: Record<string, unknown> = {}, parameterHeaders: Record<string, string> = {}) {
  if (typeof id !== 'string' || !id || id.length > 128 || !['server/discover', 'tools/list', 'tools/call'].includes(method) || !object(params) || Object.hasOwn(params, '_meta')) throw new Error('Solicitud MCP moderna inválida.');
  if (method === 'server/discover' && Object.keys(params).length) throw new Error('Parámetros de descubrimiento inválidos.');
  if (method === 'tools/list' && (Object.keys(params).some(key => key !== 'cursor') ||
    (params.cursor !== undefined && (typeof params.cursor !== 'string' || !params.cursor || params.cursor.length > 2048)))) throw new Error('Cursor MCP inválido.');
  if (method === 'tools/call' && (Object.keys(params).some(key => key !== 'name' && key !== 'arguments') ||
    typeof params.name !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(params.name) || !object(params.arguments))) throw new Error('Llamada MCP moderna inválida.');
  const body = canonicalJSON({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': MODERN_MCP_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'Capri iOS', version: '0.1.0' },
  } } });
  if (bytes(body) > 64 * 1024) throw new Error('Solicitud MCP demasiado grande.');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MODERN_MCP_VERSION, 'Mcp-Method': method };
  if (method === 'tools/call') headers['Mcp-Name'] = params.name as string;
  if (method !== 'tools/call' && Object.keys(parameterHeaders).length) throw new Error('Cabeceras de parámetros MCP inválidas.');
  for (const [name, value] of Object.entries(parameterHeaders)) {
    if (!/^Mcp-Param-[A-Za-z0-9!#$%&'*+.^_`|~-]{1,118}$/.test(name) || typeof value !== 'string') throw new Error('Cabecera de parámetro MCP inválida.');
    headers[name] = value;
  }
  validateModernHTTPHeaders(headers);
  return { method: 'POST' as const, headers, body };
}

/** Match the native bridge limits before requesting approval or dispatch. */
export function validateModernHTTPHeaders(headers: Record<string, string>): void {
  const entries = Object.entries(headers), names = new Set<string>(); let total = 0;
  if (entries.length > 32) throw new Error('Demasiadas cabeceras MCP.');
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (names.has(lower) || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(name) || typeof value !== 'string' ||
        /[\x00-\x1f\x7f]/.test(value) || bytes(value) > 16 * 1024) throw new Error('Cabecera MCP inválida.');
    names.add(lower); total += bytes(name) + bytes(value);
  }
  if (total > 32 * 1024) throw new Error('Cabeceras MCP demasiado grandes.');
}

/** Only an explicit legacy-compatible 400 can initiate the older handshake.
 * Modern errors, auth failures, network errors and ambiguous responses never
 * silently downgrade or retry an operation. */
export function classifyModernDiscovery(response: HTTPSResponse, id: string): 'modern' | 'legacy' {
  if (bytes(response.body) > 2 * 1024 * 1024) throw new Error('Respuesta MCP demasiado grande.');
  if (response.status === 200) {
    const result = parseMCPResponse(response, id, MODERN_MCP_VERSION);
    if (!object(result) || result.resultType !== 'complete' ||
      !Array.isArray(result.supportedVersions) || !result.supportedVersions.length || result.supportedVersions.length > 64 ||
      result.supportedVersions.some(v => typeof v !== 'string' || !v || v.length > 128) ||
      !result.supportedVersions.includes(MODERN_MCP_VERSION) || !object(result.capabilities) || !object(result.capabilities.tools))
      throw new Error('El descubrimiento MCP moderno no confirmó versión y herramientas compatibles.');
    return 'modern';
  }
  if (response.status !== 400) throw new Error(`No se confirmó el descubrimiento MCP (HTTP ${response.status}).`);
  if (!response.body.trim()) throw new Error('El servidor no identificó el protocolo; no se cambió de versión.');
  let message: unknown;
  try { message = JSON.parse(response.body); } catch { throw new Error('Respuesta MCP de negociación inválida.'); }
  if (!object(message) || message.jsonrpc !== '2.0' || message.id !== id || !object(message.error) || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string' || Object.hasOwn(message, 'result'))
    throw new Error('Error MCP de negociación no correlacionado.');
  if (message.error.code === -32022) {
    const data = message.error.data;
    if (!object(data) || data.requested !== MODERN_MCP_VERSION || !Array.isArray(data.supported) || !data.supported.length || data.supported.length > 64 ||
      data.supported.some(value => typeof value !== 'string' || !value || value.length > 128)) throw new Error('Contraoferta de versión MCP inválida.');
    throw new MCPModernVersionUnsupported([...new Set(data.supported)] as string[]);
  }
  if (message.error.code === -32600 || message.error.code === -32601) return 'legacy';
  // Includes unsupported-version, capability and header mismatch errors. A
  // 2026 server's supported versions are never treated as a legacy signal.
  throw new Error('El servidor MCP moderno rechazó la negociación; no se cambió de protocolo.');
}

/** MRTR is not yet wired to a review UI; never mistake it for a completed call. */
export function classifyModernResult(result: unknown): 'complete' | 'input_required' {
  if (!object(result)) throw new Error('Resultado MCP moderno inválido.');
  if (result.resultType === 'complete') return 'complete';
  if (result.resultType === 'input_required') return 'input_required';
  throw new Error('Tipo de resultado MCP moderno no admitido.');
}
