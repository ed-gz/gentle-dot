import type { HTTPSResponse } from './device-bridge.ts';

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
export function parseMCPResponse(response: HTTPSResponse, id: string, version?: string): unknown {
  if (response.status !== 200 || new TextEncoder().encode(response.body).length > 2 * 1024 * 1024) throw new Error(`MCP no confirmó la solicitud (HTTP ${response.status}).`);
  // HTTP media type tokens are case-insensitive; preserve the body unchanged.
  const type = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  let messages: unknown[];
  if (type === 'text/event-stream') {
    const events = response.body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n');
    if (events.length > 1000) throw new Error('Demasiados eventos MCP.');
    messages = events.flatMap(event => { const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n'); return data ? [JSON.parse(data)] : []; });
  } else if (type === 'application/json') messages = [JSON.parse(response.body)];
  else throw new Error('El servidor no respondió JSON o SSE finito.');
  // Only the 2025-03-26 transport permits batched JSON-RPC responses. During
  // initialization, confirm the offered revision after matching the response.
  const flattened: unknown[] = [];
  let batched = false;
  for (const message of messages) {
    if (Array.isArray(message)) {
      if ((version !== undefined && version !== '2025-03-26') || message.length === 0 || flattened.length + message.length > 1000) throw new Error('Lote MCP no admitido o demasiado grande.');
      batched = true;
      flattened.push(...message);
    } else flattened.push(message);
    if (flattened.length > 1000) throw new Error('Demasiados mensajes MCP.');
  }
  let found: Record<string, unknown> | undefined;
  for (const message of flattened) {
    if (!object(message) || message.jsonrpc !== '2.0') throw new Error('Mensaje MCP inválido.');
    if (typeof message.method === 'string') {
      if ('id' in message) throw new Error('Capri no habilita solicitudes del servidor, sampling, roots ni elicitación.');
      continue; // Notifications are data; they never execute application code.
    }
    if (message.id !== id || found) throw new Error('Respuesta MCP no correlacionada o duplicada.');
    found = message;
  }
  if (!found || ('error' in found) === ('result' in found)) throw new Error('El servidor no devolvió un resultado MCP verificable.');
  if (batched && version === undefined && (!object(found.result) || found.result.protocolVersion !== '2025-03-26')) throw new Error('Lote MCP no admitido durante la inicialización.');
  if ('error' in found) throw new Error('El servidor MCP rechazó la solicitud.');
  return found.result;
}

