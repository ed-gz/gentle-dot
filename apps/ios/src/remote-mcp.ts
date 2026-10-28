import { httpsRequest, nativeSHA256, type HTTPSRequest, type HTTPSResponse } from './device-bridge.ts';
import { getConnection, connectionToken, beginRemoteExecution, finishRemoteExecution, type ExternalConnection, type RemoteExecution } from './external-connections.ts';
import { localIdentifier } from './local-identifiers.ts';
import type { Tool, ToolContext } from './agent-tools.ts';

const VERSION = '2025-06-18';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function canonicalJSON(value: unknown): string {
  function normalize(input: unknown, depth = 0): unknown {
    if (depth > 24) throw new Error('JSON demasiado profundo.');
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(item => normalize(item, depth + 1));
    if (object(input)) return Object.fromEntries(Object.keys(input).sort().map(key => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Propiedad JSON no permitida.');
      return [key, normalize(input[key], depth + 1)];
    }));
    throw new Error('Sólo se permiten valores JSON.');
  }
  return JSON.stringify(normalize(value));
}
/** Fail closed for unsupported validation keywords. No remote refs or regular-expression execution. */
export function validateMCPArguments(schema: Record<string, unknown>, value: unknown): Record<string, unknown> {
  const keywords = new Set(['$schema', '$id', '$defs', 'definitions', '$ref', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
    'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', 'minProperties', 'maxProperties']);
  function check(rule: unknown, input: unknown, depth = 0): void {
    if (depth > 24) throw new Error('Esquema demasiado profundo.');
    if (typeof rule === 'boolean') { if (!rule) throw new Error('Valor no admitido.'); return; }
    if (!object(rule) || Object.keys(rule).some(key => !keywords.has(key))) throw new Error('El esquema MCP usa validaciones aún no compatibles; no se ejecutó la herramienta.');
    if (rule.$ref !== undefined) {
      if (typeof rule.$ref !== 'string' || !rule.$ref.startsWith('#/')) throw new Error('Referencias externas no admitidas.');
      let referenced: unknown = schema;
      for (const part of rule.$ref.slice(2).split('/').map(item => item.replace(/~1/g, '/').replace(/~0/g, '~'))) referenced = object(referenced) ? referenced[part] : undefined;
      check(referenced, input, depth + 1);
    }
    for (const combinator of ['anyOf', 'oneOf', 'allOf']) if (rule[combinator] !== undefined) {
      const branches = rule[combinator]; if (!Array.isArray(branches) || branches.length < 1 || branches.length > 20) throw new Error('Combinación de esquema inválida.');
      const valid = branches.filter(branch => { try { check(branch, input, depth + 1); return true; } catch { return false; } }).length;
      if (combinator === 'allOf' ? valid !== branches.length : combinator === 'oneOf' ? valid !== 1 : valid === 0) throw new Error('Los argumentos no cumplen el esquema.');
    }
    if (rule.enum !== undefined && (!Array.isArray(rule.enum) || !rule.enum.some(item => canonicalJSON(item) === canonicalJSON(input)))) throw new Error('Valor fuera del catálogo.');
    if ('const' in rule && canonicalJSON(rule.const) !== canonicalJSON(input)) throw new Error('Valor constante incorrecto.');
    const matches = (type: unknown) => type === 'null' ? input === null : type === 'array' ? Array.isArray(input) : type === 'object' ? object(input) : type === 'integer' ? Number.isSafeInteger(input) : type === 'number' ? typeof input === 'number' && Number.isFinite(input) : type === typeof input && ['string', 'boolean'].includes(String(type));
    if (rule.type !== undefined && !(Array.isArray(rule.type) ? rule.type.some(matches) : matches(rule.type))) throw new Error('Tipo de argumento incorrecto.');
    if (typeof input === 'string') { const n = Array.from(input).length; if (typeof rule.minLength === 'number' && n < rule.minLength || typeof rule.maxLength === 'number' && n > rule.maxLength) throw new Error('Longitud de texto inválida.'); }
    if (typeof input === 'number') for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
      const limit = rule[key]; if (typeof limit === 'number' && (key === 'minimum' ? input < limit : key === 'maximum' ? input > limit : key === 'exclusiveMinimum' ? input <= limit : input >= limit)) throw new Error('Número fuera de rango.');
    }
    if (Array.isArray(input)) {
      if (typeof rule.minItems === 'number' && input.length < rule.minItems || typeof rule.maxItems === 'number' && input.length > rule.maxItems) throw new Error('Cantidad de elementos inválida.');
      if (rule.uniqueItems === true && new Set(input.map(canonicalJSON)).size !== input.length) throw new Error('Elementos duplicados.');
      if (rule.items !== undefined) input.forEach(item => check(rule.items, item, depth + 1));
    }
    if (object(input)) {
      const keys = Object.keys(input);
      if (typeof rule.minProperties === 'number' && keys.length < rule.minProperties || typeof rule.maxProperties === 'number' && keys.length > rule.maxProperties) throw new Error('Cantidad de campos inválida.');
      if (rule.required !== undefined && (!Array.isArray(rule.required) || rule.required.some(key => typeof key !== 'string' || !Object.hasOwn(input, key)))) throw new Error('Falta un campo obligatorio.');
      const properties = object(rule.properties) ? rule.properties : {};
      for (const key of keys) {
        if (Object.hasOwn(properties, key)) check(properties[key], input[key], depth + 1);
        else if (rule.additionalProperties !== undefined) check(rule.additionalProperties, input[key], depth + 1);
      }
    }
  }
  if (!object(value) || new TextEncoder().encode(canonicalJSON(value)).length > 16 * 1024) throw new Error('Argumentos MCP inválidos o demasiado grandes.');
  check(schema, value); return JSON.parse(canonicalJSON(value));
}
type RemoteTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type MCPServices = {
  getConnection: (id: string) => Promise<ExternalConnection | null>;
  token: (connection: ExternalConnection) => Promise<string | null>;
  request: (request: HTTPSRequest) => Promise<HTTPSResponse>;
  begin: (execution: RemoteExecution) => Promise<void>;
  finish: typeof finishRemoteExecution;
  hash: (text: string) => Promise<string>;
};
async function hash(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) return nativeSHA256(text);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function parseMCPResponse(response: HTTPSResponse, id: string): unknown {
  if (response.status !== 200 || new TextEncoder().encode(response.body).length > 2 * 1024 * 1024) throw new Error(`MCP no confirmó la solicitud (HTTP ${response.status}).`);
  const type = response.headers['content-type']?.split(';')[0]?.trim();
  let messages: unknown[];
  if (type === 'text/event-stream') {
    const events = response.body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n');
    if (events.length > 1000) throw new Error('Demasiados eventos MCP.');
    messages = events.flatMap(event => { const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n'); return data ? [JSON.parse(data)] : []; });
  } else if (type === 'application/json') messages = [JSON.parse(response.body)];
  else throw new Error('El servidor no respondió JSON o SSE finito.');
  let found: Record<string, unknown> | undefined;
  for (const message of messages) {
    if (!object(message) || message.jsonrpc !== '2.0') throw new Error('Mensaje MCP inválido.');
    if (typeof message.method === 'string') {
      if ('id' in message) throw new Error('Capri no habilita solicitudes del servidor, sampling, roots ni elicitación.');
      continue; // Notifications are data; they never execute application code.
    }
    if (message.id !== id || found) throw new Error('Respuesta MCP no correlacionada o duplicada.');
    found = message;
  }
  if (!found || ('error' in found) === ('result' in found)) throw new Error('El servidor no devolvió un resultado MCP verificable.');
  if ('error' in found) throw new Error('El servidor MCP rechazó la solicitud.');
  return found.result;
}

export async function discoverMCPTools(connectionId: string, overrides: Partial<MCPServices> = {}): Promise<Tool[]> {
  const service: MCPServices = { getConnection, token: connectionToken, request: httpsRequest, begin: beginRemoteExecution, finish: finishRemoteExecution, hash, ...overrides };
  const connection = await service.getConnection(connectionId);
  if (!connection || !connection.enabled || connection.kind !== 'mcp') throw new Error('La conexión MCP no está habilitada.');
  const expected = canonicalJSON(connection);
  const token = await service.token(connection);
  let session: string | undefined;
  let initialized = false;
  async function current(): Promise<void> {
    if (canonicalJSON(await service.getConnection(connectionId)) !== expected) throw new Error('La conexión cambió; vuelve a descubrir las herramientas.');
  }
  async function rpc(method: string, params: unknown, id = localIdentifier()): Promise<unknown> {
    await current();
    if (method !== 'initialize' && !initialized) throw new Error('La sesión MCP caducó. Actualiza las conexiones para iniciar otra; no se repitió ninguna operación.');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (session) headers['Mcp-Session-Id'] = session;
    if (initialized) headers['MCP-Protocol-Version'] = VERSION;
    const result = await service.request({ url: connection!.endpoint, method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    if (result.status === 404 && session) { session = undefined; initialized = false; throw new Error('La sesión MCP caducó. Vuelve a descubrir las herramientas.'); }
    if (method === 'initialize') {
      const value = result.headers['mcp-session-id'];
      if (value !== undefined && (!/^[\x21-\x7e]{1,1024}$/.test(value))) throw new Error('Identificador de sesión MCP inválido.');
      session = value;
    }
    return parseMCPResponse(result, id);
  }
  const init = await rpc('initialize', { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'Capri iOS', version: '0.1.0' } });
  if (!object(init) || init.protocolVersion !== VERSION || !object(init.capabilities) || !object(init.capabilities.tools)) throw new Error('El servidor no ofrece herramientas con MCP 2025-06-18.');
  initialized = true;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': VERSION };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (session) headers['Mcp-Session-Id'] = session;
  await current();
  const ready = await service.request({ url: connection.endpoint, method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  if (ready.status !== 202) throw new Error('El servidor no confirmó la inicialización MCP.');
  async function catalog(): Promise<RemoteTool[]> {
    const all: RemoteTool[] = []; const cursors = new Set<string>(); const names = new Set<string>(); let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await rpc('tools/list', cursor ? { cursor } : {});
      if (!object(result) || !Array.isArray(result.tools)) throw new Error('Catálogo MCP inválido.');
      for (const raw of result.tools) {
        if (!object(raw) || typeof raw.name !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(raw.name) || names.has(raw.name) ||
          !object(raw.inputSchema) || raw.inputSchema.type !== 'object' || (raw.description !== undefined && typeof raw.description !== 'string')) throw new Error('Definición de herramienta MCP inválida.');
        const tool = { name: raw.name, description: typeof raw.description === 'string' ? raw.description : raw.name, inputSchema: raw.inputSchema };
        if (tool.description.length > 4000 || canonicalJSON(tool.inputSchema).length > 16 * 1024) throw new Error('Esquema MCP demasiado grande.');
        names.add(tool.name); all.push(tool);
        if (all.length > 64 || canonicalJSON(all).length > 512 * 1024) throw new Error('Catálogo MCP demasiado grande; habilita menos herramientas en el servidor.');
      }
      if (result.nextCursor === undefined) return all;
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 2048 || cursors.has(result.nextCursor)) throw new Error('Paginación MCP inválida.');
      cursor = result.nextCursor; cursors.add(cursor);
    }
    throw new Error('El catálogo MCP supera diez páginas.');
  }
  const tools = await catalog();
  return Promise.all(tools.map(async remote => {
    const schemaJSON = canonicalJSON(remote.inputSchema);
    const suffix = (await service.hash(connection.id + '\n' + remote.name)).slice(0, 24);
    return {
      definition: { name: `mcp_${suffix}`, description: `${connection.label}: ${remote.description}`.slice(0, 4000), parameters: structuredClone(remote.inputSchema) },
      validate(value: unknown) { return validateMCPArguments(remote.inputSchema, value); },
      async execute(value: unknown, context: ToolContext) {
        const args = validateMCPArguments(remote.inputSchema, value); const argumentsJSON = canonicalJSON(args);
        context.signal.throwIfAborted(); await current();
        if (!context.askApproval) throw new Error('Esta herramienta remota requiere revisión y aprobación en la conversación.');
        const details = canonicalJSON({ endpoint: connection.endpoint, connectionRevision: connection.revision, tool: remote.name, schema: remote.inputSchema, arguments: args });
        if (!await context.askApproval({ title: `Revisar ${remote.name} · ${connection.label}`, details, operation: 'mcp.tools.call' })) return { executed: false, approved: false };
        context.signal.throwIfAborted(); await current();
        const fresh = (await catalog()).find(tool => tool.name === remote.name);
        if (!fresh || canonicalJSON(fresh.inputSchema) !== schemaJSON || fresh.description !== remote.description) throw new Error('La herramienta cambió después de revisarla. Descúbrela y aprueba de nuevo.');
        context.signal.throwIfAborted(); await current();
        const requestId = localIdentifier();
        // Schema and credential revisions invalidate approvals, but cannot erase
        // uncertainty about the same operation's previous network outcome.
        const fingerprint = await service.hash(canonicalJSON({ connectionId, endpoint: connection.endpoint, tool: remote.name, arguments: args }));
        const time = Date.now();
        await service.begin({ requestId, fingerprint, connectionId, connectionRevision: connection.revision, endpoint: connection.endpoint, toolName: remote.name, schemaJSON, argumentsJSON, state: 'executing', createdAt: time, updatedAt: time });
        try {
          context.signal.throwIfAborted();
          const result = await rpc('tools/call', { name: remote.name, arguments: args }, requestId);
          if (!object(result) || !Array.isArray(result.content) || (result.isError !== undefined && typeof result.isError !== 'boolean')) throw new Error('Resultado de herramienta MCP inválido.');
          // Store only the correlated result; untrusted resource links are never fetched.
          await service.finish(requestId, 'succeeded', canonicalJSON(result));
          return { requestId, confirmed: true, toolFailed: result.isError === true, result, untrustedContent: true };
        } catch {
          await service.finish(requestId, 'uncertain').catch(() => {});
          throw new Error('La operación MCP quedó sin confirmar. Conservé su registro y no la repetiré automáticamente.');
        }
      },
    } satisfies Tool;
  }));
}
