import { createOrchestrationClient, type OrchestrationClient } from '@gentle-dot/ui/src/orchestration.ts';
import { httpsRequest, type HTTPSRequest, type HTTPSResponse } from './device-bridge.ts';
import { validDaemonUrl } from './local-state.ts';
import type { DesktopConnection } from './desktop-tools.ts';
import { uploadSessionFile } from './session-upload.ts';

/** Reuse the desktop session contract through the phone's authenticated native
 * transport. A connection change fences both outgoing requests and late reads. */
export function createLaptopClient(connection: DesktopConnection, options: {
  current: () => DesktopConnection | undefined;
  request?: (request: HTTPSRequest) => Promise<HTTPSResponse>;
}): OrchestrationClient {
  const url = new URL(validDaemonUrl(connection.url));
  if (url.pathname !== '/ws' || !connection.token || /\s/.test(connection.token)) throw new Error('Vincula una laptop válida.');
  const origin = url.origin.replace('wss:', 'https:');
  const captured = { ...connection };
  const request = options.request ?? httpsRequest;
  function current() {
    const live = options.current();
    if (!live || live.url !== captured.url || live.token !== captured.token || live.deviceId !== captured.deviceId) throw new Error('Cambió la laptop vinculada. Actualiza las sesiones antes de continuar.');
  }
  const transport: typeof fetch = async (input, init) => {
    current(); init?.signal?.throwIfAborted();
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (target.origin !== origin || target.username || target.password || target.search || target.hash ||
      !['/orchestration', '/api/mobile/workflows', '/api/mobile/approvals', '/api/mobile/answer', '/api/mobile/computer', '/browser'].includes(target.pathname)) throw new Error('Destino de sesión no permitido.');
    const method = init?.method ?? 'GET';
    if (!['GET', 'POST'].includes(method) || (init?.body !== undefined && typeof init.body !== 'string')) throw new Error('Esta operación necesita un transporte de archivos.');
    const pending = request({ url: target.href, method: method as 'GET' | 'POST',
      headers: { Authorization: `Bearer ${captured.token}`, ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    let onAbort: (() => void) | undefined;
    const reply = await (init?.signal ? Promise.race([pending, new Promise<never>((_, reject) => {
      onAbort = () => reject(init.signal!.reason);
      init.signal!.addEventListener('abort', onAbort, { once: true });
      if (init.signal!.aborted) onAbort();
    })]) : pending).finally(() => { if (onAbort) init?.signal?.removeEventListener('abort', onAbort); });
    current(); init?.signal?.throwIfAborted();
    if (new TextEncoder().encode(reply.body).byteLength > 2 * 1024 * 1024) throw new Error('La sesión devolvió demasiados datos. Carga una página más pequeña.');
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  };
  const client = createOrchestrationClient(captured, { fetch: transport, terminalMood: false });
  const snapshot = client.snapshot;
  client.snapshot = async signal => {
    const value = await snapshot(signal);
    if (value.sessions.length > 200 || value.sessions.some(session => !session ||
      typeof session.paneId !== 'string' || !session.paneId || session.paneId.length > 256 ||
      typeof session.label !== 'string' || session.label.length > 120 ||
      (session.provider !== undefined && !['herdr', 'orca', 'terminal'].includes(session.provider)) ||
      !['idle', 'working', 'blocked', 'done', 'unknown'].includes(session.state) ||
      typeof session.connected !== 'boolean' || (session.sessionId !== undefined && (typeof session.sessionId !== 'string' || session.sessionId.length > 256)))) {
      throw new Error('El equipo devolvió una sesión no válida.');
    }
    return value;
  };
  const inspect = client.inspect;
  client.inspect = async (paneId, sessionId, signal, page) => {
    const value = await inspect(paneId, sessionId, signal, page);
    if (value.sessionId !== sessionId || value.messages.length > 200 || value.messages.some(message =>
      typeof message.id !== 'string' || message.id.length > 256 ||
      !['user', 'assistant', 'system', 'tool', 'toolResult'].includes(message.role) ||
      !Array.isArray(message.content) || message.content.some(block => !block || block.type !== 'text' || typeof block.text !== 'string' || block.text.length > 200_000))) throw new Error('El historial no corresponde a esta sesión.');
    return value;
  };
  client.uploadAttachment = (paneId, sessionId, file, uploadId, signal) => {
    current();
    return uploadSessionFile(captured, paneId, sessionId, file, { current: options.current, uploadId, signal });
  };
  return client;
}
