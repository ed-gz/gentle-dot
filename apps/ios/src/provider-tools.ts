import type { Tool, ToolContext, ToolDefinition } from './agent-tools.ts';
import { validateOperation, type Operation, type AttachmentRef } from './external-actions.ts';
import { getConnection, beginRemoteExecution, finishRemoteExecution, type ExternalConnection } from './external-connections.ts';
import { httpsRequest, httpsReceiptState, nativeSHA256Bytes, type HTTPSRequest, type HTTPSResponse } from './device-bridge.ts';
import { readWork, readWorkFile } from './work-inbox.ts';
import { canonicalJSON } from './remote-mcp.ts';
import { localIdentifier } from './local-identifiers.ts';
import { gmailRaw, gmailReadable, type MailAttachment } from './provider-mail.ts';

type Access = { connection: ExternalConnection; accessToken: string };
export type ProviderServices = {
  getConnection: typeof getConnection;
  access(id: string): Promise<Access>;
  request(request: HTTPSRequest): Promise<HTTPSResponse>;
  begin: typeof beginRemoteExecution;
  finish: typeof finishRemoteExecution;
  receiptState: typeof httpsReceiptState;
  attachment(ref: AttachmentRef): Promise<Uint8Array>;
  hash(bytes: Uint8Array): Promise<string>;
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const textSchema = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const parameters = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
function args(value: unknown, keys: string[]): Record<string, unknown> { if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Argumentos de proveedor inválidos.'); return value; }
function text(value: unknown, max = 1000): string { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000\r\n]/.test(value)) throw new Error('Texto de consulta inválido.'); return value; }
function integer(value: unknown, max = 1000000000, fallback?: number): number { if (value === undefined && fallback !== undefined) return fallback; if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error('Identificador o límite inválido.'); return value as number; }
function repository(value: unknown): string { const result = text(value, 200); if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result) || result.split('/').some(part => ['.', '..'].includes(part))) throw new Error('Repositorio inválido.'); return result.split('/').map(encodeURIComponent).join('/'); }
function channel(value: unknown): string { const result = text(value, 100); if (!/^[CDG][A-Z0-9]+$/.test(result)) throw new Error('Selecciona el ID de canal de Slack.'); return result; }
function endpoint(connection: ExternalConnection): string {
  const url = new URL(connection.endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Endpoint de proveedor inválido.');
  const expected = { github: 'https://api.github.com/', slack: 'https://slack.com/api/', gmail: 'https://gmail.googleapis.com/' };
  const base = url.href.endsWith('/') ? url.href : url.href + '/';
  if (connection.provider && connection.provider !== 'odoo' && base !== expected[connection.provider]) throw new Error('Este adaptador requiere el endpoint oficial del proveedor; usa MCP para otros servidores.');
  if (connection.provider === 'odoo' && (!connection.apiMode || (connection.apiMode === 'legacy' && (!connection.database || !connection.uid)))) throw new Error('Selecciona JSON-2 o JSON-RPC legacy; legacy necesita base de datos y UID.');
  return base;
}
function json(response: HTTPSResponse): unknown {
  if (response.status < 200 || response.status >= 300) throw new Error(`El proveedor rechazó la consulta (HTTP ${response.status}); no se reintentó.`);
  try { return JSON.parse(response.body); } catch { throw new Error('El proveedor devolvió un resultado ilegible.'); }
}
function escapeHTML(value: string): string { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!)).replace(/\n/g, '<br>'); }
function odooValues(operation: Operation): Record<string, unknown> {
  if (operation.kind === 'odoo.task.create') return { project_id: operation.projectId, name: operation.name, description: escapeHTML(operation.description), user_ids: [[6, 0, operation.assigneeIds]], ...(operation.deadline ? { date_deadline: operation.deadline } : {}) };
  if (operation.kind !== 'odoo.task.update') throw new Error('Operación Odoo inválida.');
  const c = operation.changes;
  return { ...(c.name !== undefined ? { name: c.name } : {}), ...(c.description !== undefined ? { description: escapeHTML(c.description) } : {}), ...(c.stageId !== undefined ? { stage_id: c.stageId } : {}),
    ...(c.assigneeIds !== undefined ? { user_ids: [[6, 0, c.assigneeIds]] } : {}), ...(c.deadline !== undefined ? { date_deadline: c.deadline ?? false } : {}) };
}
async function hashBytes(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) return nativeSHA256Bytes(bytes);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const defaults: ProviderServices = {
  getConnection, request: httpsRequest, begin: beginRemoteExecution, finish: finishRemoteExecution, receiptState: httpsReceiptState, hash: hashBytes,
  async access(id) { const oauth = await import('./provider-oauth-store.ts'); return oauth.getValidProviderAccess(id); },
  async attachment(ref) {
    const work = await readWork(ref.workId); const stored = work.files.find(file => file.id === ref.fileId);
    if (!stored || stored.name !== ref.name || stored.type !== ref.mime || stored.size !== ref.size) throw new Error('El adjunto cambió. Vuelve a revisar el archivo.');
    const blob = await readWorkFile(ref.workId, ref.fileId);
    if (!blob || blob.size !== ref.size) throw new Error('El adjunto no está disponible.');
    return new Uint8Array(await blob.arrayBuffer());
  },
};

/** Direct adapters use fixed routes; the model never selects a URL, method or authentication header. */
export async function createProviderTools(connectionId: string, overrides: Partial<ProviderServices> = {}): Promise<Tool[]> {
  const service = { ...defaults, ...overrides };
  const configured = await service.getConnection(connectionId);
  if (!configured || configured.kind !== 'https-api' || !configured.enabled || !configured.provider) throw new Error('Selecciona una conexión de API habilitada.');
  endpoint(configured);
  const provider = configured.provider;
  const prefix = `api_${configured.id.replace(/-/g, '')}_`;
  async function access(): Promise<Access> {
    const value = await service.access(connectionId);
    if (value.connection.id !== connectionId || !value.connection.enabled || value.connection.kind !== 'https-api' || value.connection.provider !== provider || !value.accessToken) throw new Error('La conexión del proveedor cambió o está deshabilitada.');
    endpoint(value.connection); await same(value.connection); return value;
  }
  async function same(connection: ExternalConnection): Promise<void> {
    if (canonicalJSON(await service.getConnection(connectionId)) !== canonicalJSON(connection)) throw new Error('La conexión cambió después de revisarla. Vuelve a aprobar.');
  }
  function request(access: Access, path: string, method: HTTPSRequest['method'] = 'GET', body?: unknown): HTTPSRequest {
    const headers: Record<string, string> = { Authorization: `Bearer ${access.accessToken}`, Accept: 'application/json' };
    if (provider === 'github') { headers.Accept = 'application/vnd.github+json'; headers['X-GitHub-Api-Version'] = '2026-03-10'; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return { url: endpoint(access.connection) + (provider === 'gmail' ? 'gmail/v1/' : '') + path, method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  }
  function odooRequest(access: Access, model: string, method: string, kwargs: Record<string, unknown>, positional: unknown[]): HTTPSRequest {
    if (access.connection.apiMode === 'json2') {
      const result = request(access, `json/2/${model}/${method}`, 'POST', kwargs);
      if (access.connection.database) result.headers['X-Odoo-Database'] = access.connection.database;
      return result;
    }
    const result = request(access, 'jsonrpc', 'POST', { jsonrpc: '2.0', id: localIdentifier(), method: 'call',
      params: { service: 'object', method: 'execute_kw', args: [access.connection.database, access.connection.uid, access.accessToken, model, method, positional, method === 'search_read' ? kwargs : {}] } });
    delete result.headers.Authorization; return result;
  }
  function odooResult(value: unknown, connection: ExternalConnection, outgoing: HTTPSRequest): unknown {
    if (connection.apiMode !== 'legacy') return value;
    if (!object(value) || value.jsonrpc !== '2.0' || value.id !== JSON.parse(outgoing.body!).id || 'error' in value || !('result' in value)) throw new Error('Odoo no confirmó la operación.');
    return value.result;
  }
  async function odooRead(access: Access, model: string, kwargs: Record<string, unknown>): Promise<unknown> {
    const outgoing = odooRequest(access, model, 'search_read', kwargs, []);
    return odooResult(json(await service.request(outgoing)), access.connection, outgoing);
  }
  function read<A>(name: string, description: string, schema: Record<string, unknown>, validate: (value: unknown) => A,
    run: (value: A, access: Access) => Promise<unknown>): Tool {
    return { definition: { name: prefix + name, description: `${configured!.label}: ${description}`, parameters: schema }, validate,
      async execute(value, context) { const safe = validate(value); context.signal.throwIfAborted(); const credentials = await access(); context.signal.throwIfAborted(); const result = await run(safe, credentials); context.signal.throwIfAborted(); return { data: result, untrustedContent: true }; } };
  }
  async function attachmentBytes(ref: AttachmentRef): Promise<Uint8Array> {
    const bytes = await service.attachment(ref);
    if (bytes.length !== ref.size || await service.hash(bytes) !== ref.sha256) throw new Error('El adjunto no coincide con la huella revisada.');
    return bytes;
  }
  function write(name: string, description: string, kind: Operation['kind'], schema: Record<string, unknown>): Tool {
    const operationFor = (value: unknown): Operation => { const safe = args(value, Object.keys((schema.properties ?? {}) as object));
      if (kind === 'odoo.task.update') args(safe.changes, ['name', 'description', 'stageId', 'assigneeIds', 'deadline']);
      return validateOperation({ ...safe, kind }); };
    const definition: ToolDefinition = { name: prefix + name, description: `${configured!.label}: ${description} Requiere revisión exacta antes de enviar.`, parameters: schema };
    return { definition, validate(value) {
      // Keep validated arguments inside the public schema: callers may validate again.
      const { kind: _kind, ...parameters } = operationFor(value); return parameters;
    }, async execute(value, context: ToolContext) {
      const operation = operationFor(value); context.signal.throwIfAborted();
      const credentials = await access(); const connection = credentials.connection;
      const files: MailAttachment[] = [];
      let sender: string | undefined;
      let outgoing: HTTPSRequest;
      if (operation.kind === 'github.issue') outgoing = request(credentials, `repos/${repository(operation.repository)}/issues`, 'POST', { title: operation.title, body: operation.text, labels: operation.labels });
      else if (operation.kind === 'slack.message') outgoing = request(credentials, 'chat.postMessage', 'POST', { channel: operation.channel, text: operation.text, mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false });
      else if (operation.kind === 'gmail.message') {
        for (const ref of operation.attachments) files.push({ name: ref.name, mime: ref.mime, bytes: await attachmentBytes(ref) });
        const profile = json(await service.request(request(credentials, 'users/me/profile')));
        if (!object(profile) || typeof profile.emailAddress !== 'string') throw new Error('No se pudo confirmar la cuenta remitente.');
        sender = profile.emailAddress;
        outgoing = request(credentials, 'users/me/messages/send', 'POST', { raw: gmailRaw(operation, profile.emailAddress, files, `capri_${localIdentifier()}`) });
      } else if (operation.kind === 'odoo.task.create') outgoing = odooRequest(credentials, 'project.task', 'create', { vals_list: [odooValues(operation)] }, [odooValues(operation)]);
      else outgoing = odooRequest(credentials, 'project.task', 'write', { ids: [operation.taskId], vals: odooValues(operation) }, [[operation.taskId], odooValues(operation)]);
      context.signal.throwIfAborted(); await same(connection);
      if (!context.askApproval) throw new Error('Revisa el contenido en la conversación antes de enviarlo.');
      const review = { provider, endpoint: connection.endpoint, revision: connection.revision, path: outgoing.url, method: outgoing.method,
        ...(connection.database ? { database: connection.database } : {}), ...(connection.uid ? { uid: connection.uid } : {}), ...(sender ? { from: sender } : {}), apiMode: connection.apiMode ?? null, operation };
      if (!await context.askApproval({ title: description, details: JSON.stringify(review, null, 2), operation: kind })) return { executed: false, approved: false };
      context.signal.throwIfAborted(); await same(connection);
      if (operation.kind === 'gmail.message') for (const ref of operation.attachments) await attachmentBytes(ref);
      context.signal.throwIfAborted(); await same(connection);
      const requestId = localIdentifier(), owner = localIdentifier(); const argumentsJSON = canonicalJSON(operation); const schemaJSON = canonicalJSON(definition.parameters);
      const fingerprint = await service.hash(new TextEncoder().encode(canonicalJSON({ connectionId, endpoint: connection.endpoint, kind, operation })));
      context.signal.throwIfAborted(); const time = Date.now();
      await service.begin({ requestId, fingerprint, connectionId, connectionRevision: connection.revision, endpoint: connection.endpoint, toolName: kind, schemaJSON, argumentsJSON, state: 'executing', createdAt: time, updatedAt: time, nativeReceipt:1, owner });
      try {
        await same(connection); context.signal.throwIfAborted();
        const response = await service.request({...outgoing,receiptId:requestId,receiptOwner:owner});
        if ([400, 401, 403, 404, 422, 429].includes(response.status)) {
          const result = { accepted: false, httpStatus: response.status, message: 'El proveedor rechazó la solicitud. Corrige la conexión o el contenido antes de un nuevo intento.' };
          await service.finish(requestId, 'succeeded', canonicalJSON(result)); return { requestId, confirmed: true, ...result };
        }
        const raw = json(response); let result: unknown;
        if (provider === 'slack') {
          if (!object(raw) || typeof raw.ok !== 'boolean') throw new Error('Respuesta Slack inválida.');
          result = raw.ok ? { accepted: true, channel: raw.channel, timestamp: raw.ts } : { accepted: false, error: typeof raw.error === 'string' ? raw.error.slice(0, 100) : 'slack_rejected' };
          if (raw.ok && (typeof raw.ts !== 'string' || typeof raw.channel !== 'string')) throw new Error('Respuesta Slack incompleta.');
        } else if (provider === 'github') {
          if (!object(raw) || !Number.isSafeInteger(raw.number) || typeof raw.html_url !== 'string') throw new Error('Respuesta GitHub inválida.');
          result = { accepted: true, number: raw.number, url: raw.html_url };
        } else if (provider === 'gmail') {
          if (!object(raw) || typeof raw.id !== 'string' || !raw.id) throw new Error('Respuesta Gmail inválida.');
          result = { accepted: true, id: raw.id, threadId: raw.threadId ?? null };
        } else {
          const value = odooResult(raw, connection, outgoing);
          if (operation.kind === 'odoo.task.update') { if (value !== true) throw new Error('Odoo no confirmó la edición.'); result = { accepted: true, taskId: operation.taskId }; }
          else { const taskId = Array.isArray(value) && value.length === 1 ? value[0] : value; result = { accepted: true, taskId: integer(taskId) }; }
        }
        await service.finish(requestId, 'succeeded', canonicalJSON(result)); return { requestId, confirmed: true, result };
      } catch {
        if (await service.receiptState(requestId,owner).catch(()=>undefined) === 'terminal') await service.finish(requestId, 'uncertain').catch(() => {});
        throw new Error('El envío quedó sin confirmar. Conservé el registro y no lo repetiré automáticamente. Revisa el servicio.');
      }
    } };
  }
  const strings = { type: 'array', items: textSchema(254), maxItems: 30 };
  if (provider === 'github') return [
    read('repositories', 'Lista tus repositorios, 20 por página.', parameters({ page: { type: 'integer', minimum: 1 } }), value => ({ page: integer(args(value, ['page']).page, 10000, 1) }), async (a, access) => json(await service.request(request(access, `user/repos?per_page=20&page=${a.page}&sort=updated`)))),
    read('issues', 'Consulta issues de un repositorio; las pull requests también aparecen en la API.', parameters({ repository: textSchema(200), page: { type: 'integer', minimum: 1 } }, ['repository']), value => { const a = args(value, ['repository', 'page']); return { repository: repository(a.repository), page: integer(a.page, 10000, 1) }; }, async (a, access) => json(await service.request(request(access, `repos/${a.repository}/issues?state=all&per_page=20&page=${a.page}`)))),
    read('issue', 'Lee un issue completo por número.', parameters({ repository: textSchema(200), number: { type: 'integer', minimum: 1 } }, ['repository', 'number']), value => { const a = args(value, ['repository', 'number']); return { repository: repository(a.repository), number: integer(a.number) }; }, async (a, access) => json(await service.request(request(access, `repos/${a.repository}/issues/${a.number}`)))),
    write('create_issue', 'Crear issue de GitHub', 'github.issue', parameters({ repository: textSchema(200), title: textSchema(256), text: textSchema(30000), labels: { type: 'array', items: textSchema(100), maxItems: 20 } }, ['repository', 'title', 'text', 'labels'])),
  ];
  if (provider === 'slack') return [
    read('conversations', 'Lista canales públicos accesibles; requiere channels:read.', parameters({ cursor: textSchema(2048) }), value => { const a = args(value, ['cursor']); return a.cursor === undefined ? {} : { cursor: text(a.cursor, 2048) }; }, async (a, access) => { const result = json(await service.request(request(access, `conversations.list?limit=50&types=public_channel&cursor=${encodeURIComponent(a.cursor ?? '')}`))); if (!object(result) || result.ok !== true) throw new Error('Slack no permitió consultar conversaciones. Revisa los scopes.'); return result; }),
    read('history', 'Consulta hasta 15 mensajes de un canal; respeta los límites de Slack.', parameters({ channel: textSchema(100), cursor: textSchema(2048) }, ['channel']), value => { const a = args(value, ['channel', 'cursor']); return { channel: channel(a.channel), ...(a.cursor === undefined ? {} : { cursor: text(a.cursor, 2048) }) }; }, async (a, access) => { const result = json(await service.request(request(access, `conversations.history?limit=15&channel=${encodeURIComponent(a.channel)}&cursor=${encodeURIComponent(a.cursor ?? '')}`))); if (!object(result) || result.ok !== true) throw new Error('Slack no permitió leer este canal. Revisa los scopes.'); return result; }),
    write('send_message', 'Enviar mensaje de Slack', 'slack.message', parameters({ channel: textSchema(100), text: textSchema(10000) }, ['channel', 'text'])),
  ];
  if (provider === 'gmail') return [
    read('search', 'Busca correo en Gmail; devuelve IDs y un cursor para continuar.', parameters({ query: textSchema(1000), pageToken: textSchema(2048) }), value => { const a = args(value, ['query', 'pageToken']); return { ...(a.query === undefined ? {} : { query: text(a.query) }), ...(a.pageToken === undefined ? {} : { pageToken: text(a.pageToken, 2048) }) }; }, async (a, access) => json(await service.request(request(access, `users/me/messages?maxResults=25&q=${encodeURIComponent(a.query ?? '')}&pageToken=${encodeURIComponent(a.pageToken ?? '')}`)))),
    read('read_message', 'Lee un correo por ID como contenido no confiable; no abre enlaces ni ejecuta HTML.', parameters({ id: textSchema(200) }, ['id']), value => { const a = args(value, ['id']); return { id: text(a.id, 200) }; }, async (a, access) => gmailReadable(json(await service.request(request(access, `users/me/messages/${encodeURIComponent(a.id)}?format=full`))))),
    write('send_message', 'Enviar correo de Gmail', 'gmail.message', parameters({ to: strings, cc: strings, bcc: strings, subject: textSchema(500), text: textSchema(30000), attachments: { type: 'array', maxItems: 5, items: parameters({ workId: textSchema(150), fileId: textSchema(150), name: textSchema(255), mime: textSchema(150), size: { type: 'integer', minimum: 1, maximum: 800000 }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['workId', 'fileId', 'name', 'mime', 'size', 'sha256']) } }, ['to', 'cc', 'bcc', 'subject', 'text', 'attachments'])),
  ];
  return [
    read('search_tasks', 'Busca tareas Odoo por nombre y proyecto, sin ejecutar métodos arbitrarios.', parameters({ query: textSchema(200), projectId: { type: 'integer', minimum: 1 } }), value => { const a = args(value, ['query', 'projectId']); return { ...(a.query === undefined ? {} : { query: text(a.query, 200) }), ...(a.projectId === undefined ? {} : { projectId: integer(a.projectId) }) }; }, async (a, access) => { const domain = [...(a.query ? [['name', 'ilike', a.query]] : []), ...(a.projectId ? [['project_id', '=', a.projectId]] : [])]; return odooRead(access, 'project.task', { domain, fields: ['id', 'name', 'project_id', 'stage_id', 'user_ids', 'date_deadline', 'description', 'write_date'], limit: 20, order: 'write_date desc' }); }),
    read('projects', 'Lista hasta 30 proyectos Odoo accesibles.', parameters({}), value => args(value, []), async (_, access) => odooRead(access, 'project.project', { domain: [], fields: ['id', 'name'], limit: 30 })),
    read('users', 'Busca responsables confirmables por nombre; no los asigna por inferencia.', parameters({ query: textSchema(200) }, ['query']), value => ({ query: text(args(value, ['query']).query, 200) }), async (a, access) => odooRead(access, 'res.users', { domain: [['name', 'ilike', a.query]], fields: ['id', 'name'], limit: 20 })),
    write('create_task', 'Crear tarea Odoo', 'odoo.task.create', parameters({ projectId: { type: 'integer', minimum: 1 }, name: textSchema(256), description: { type: 'string', maxLength: 30000 }, assigneeIds: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 20 }, deadline: { type: 'string', description: 'AAAA-MM-DD confirmado; omitir si no existe acuerdo.' } }, ['projectId', 'name', 'description', 'assigneeIds'])),
    write('update_task', 'Actualizar tarea Odoo', 'odoo.task.update', parameters({ taskId: { type: 'integer', minimum: 1 }, changes: parameters({ name: textSchema(256), description: { type: 'string', maxLength: 30000 }, stageId: { type: 'integer', minimum: 1 }, assigneeIds: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 20 }, deadline: { type: ['string', 'null'], description: 'AAAA-MM-DD confirmado, o null para retirar explícitamente la fecha.' } }) }, ['taskId', 'changes'])),
  ];
}
