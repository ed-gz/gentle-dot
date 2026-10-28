import { localIdentifier } from './local-identifiers.ts';
import { httpsRequest, type HTTPSRequest, type HTTPSResponse } from './device-bridge.ts';
import type { Tool, ToolContext } from './agent-tools.ts';

export type DesktopConnection = { url: string; token: string; deviceId?: string };
export type DesktopSession = { paneId: string; sessionId: string; label: string; state: string; connected: boolean; capabilities: { inspect: boolean; prompt: boolean; abort: boolean; deliveryReceipts: boolean } };
export type DesktopDelivery = { id: string; status: 'accepted' | 'queued' | 'delivered' | 'unconfirmed'; acceptedAt: string; deliveredAt?: string; preview: string; deliverAs: 'steer' | 'followUp' };
export type DesktopPage = { sessionId: string; instanceId: string; messages: { id: string; role: string; text: string }[]; deliveries: DesktopDelivery[]; question?: { id: string; kind: string; title: string; message: string; expiresAt: string; action?: string; fingerprint?: string; requiresConfirmation: boolean; options?: { id: string; label: string; description?: string; effect?: string; consequence?: string }[] }; history: { hasEarlier: boolean; before?: string } };
export type DesktopDependencies = { getConnection: () => DesktopConnection | undefined; request?: (request: HTTPSRequest) => Promise<HTTPSResponse> };
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown, max: number, required = true): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && (!required || Boolean(value.trim()));
function field(value: unknown, max: number, label: string): string { if (!string(value, max)) throw new Error(`${label} no válido.`); return value; }
function identity(args: unknown): { paneId: string; sessionId: string } {
  if (!object(args)) throw new Error('Indica la sesión existente.');
  return { paneId: field(args.paneId, 256, 'Panel'), sessionId: field(args.sessionId, 256, 'Sesión') };
}
function endpoint(connection: DesktopConnection): string {
  const url = new URL(connection.url);
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.pathname !== '/ws' || !string(connection.token, 1024) || /\s/.test(connection.token)) throw new Error('Conecta un host WSS válido antes de usar sus sesiones.');
  return `${url.origin.replace('wss:', 'https:')}/orchestration`;
}
export function parseDesktopSessions(value: unknown): DesktopSession[] {
  if (!object(value) || typeof value.available !== 'boolean' || !Array.isArray(value.sessions) || value.sessions.length > 200) throw new Error('El host devolvió un inventario de sesiones inválido.');
  return value.sessions.flatMap(item => {
    if (!object(item) || !string(item.paneId, 256) || !string(item.label, 120, false) || !string(item.state, 32) || typeof item.connected !== 'boolean' || !object(item.capabilities)) throw new Error('Una sesión del host no es válida.');
    // Disconnected panes without a bound session identity cannot be controlled.
    if (!string(item.sessionId, 256)) return [];
    return [{ paneId: item.paneId, sessionId: item.sessionId, label: item.label, state: item.state, connected: item.connected, capabilities: { inspect: item.capabilities.inspect === true, prompt: item.capabilities.prompt === true, abort: item.capabilities.abort === true, deliveryReceipts: item.capabilities.deliveryReceipts === true } }];
  });
}
export function parseDesktopPage(value: unknown, sessionId: string): DesktopPage {
  if (!object(value) || value.sessionId !== sessionId || !string(value.instanceId, 256) || !Array.isArray(value.messages) || value.messages.length > 200) throw new Error('La lectura corresponde a una sesión distinta o inválida.');
  const messages: DesktopPage['messages'] = []; let chars = 0;
  for (const entry of value.messages) {
    if (!object(entry) || !string(entry.id, 256) || !['user', 'assistant', 'system', 'tool', 'toolResult'].includes(entry.role as string)) throw new Error('El historial contiene un mensaje inválido.');
    let text = '';
    if (typeof entry.content === 'string') text = entry.content;
    else if (Array.isArray(entry.content)) text = entry.content.filter(object).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
    if (text.length > 32000 || (chars += text.length) > 180000) throw new Error('Solicita una página más pequeña del historial.');
    messages.push({ id: entry.id, role: entry.role as string, text });
  }
  const deliveries: DesktopDelivery[] = [];
  if (value.deliveries !== undefined && (!Array.isArray(value.deliveries) || value.deliveries.length > 500)) throw new Error('Los recibos de sesión son inválidos.');
  for (const receipt of (value.deliveries ?? []) as unknown[]) {
    if (!object(receipt) || !string(receipt.id, 96) || !['accepted', 'queued', 'delivered', 'unconfirmed'].includes(receipt.status as string) || !string(receipt.acceptedAt, 80) || !Number.isFinite(Date.parse(receipt.acceptedAt)) || !string(receipt.preview, 2000, false) || !['steer','followUp'].includes(receipt.deliverAs as string) || (receipt.deliveredAt !== undefined && (!string(receipt.deliveredAt, 80) || !Number.isFinite(Date.parse(receipt.deliveredAt))))) throw new Error('El host devolvió una confirmación de entrega inválida.');
    deliveries.push({ id: receipt.id, status: receipt.status as DesktopDelivery['status'], acceptedAt: receipt.acceptedAt, ...(typeof receipt.deliveredAt === 'string' ? { deliveredAt: receipt.deliveredAt } : {}), preview: receipt.preview, deliverAs: receipt.deliverAs as DesktopDelivery['deliverAs'] });
  }
  const history = object(value.history) ? value.history : {};
  const page: DesktopPage = { sessionId, instanceId: value.instanceId, messages, deliveries, history: { hasEarlier: history.hasEarlier === true, ...(string(history.before, 256) ? { before: history.before } : {}) } };
  if (object(value.question)) {
    const q = value.question;
    if (!string(q.id, 256) || !string(q.kind, 64) || !string(q.title, 1000, false) || !string(q.message ?? '', 32000, false) || !string(q.expiresAt, 80) || !Number.isFinite(Date.parse(q.expiresAt))) throw new Error('La solicitud humana de la sesión no es válida.');
    if (q.options !== undefined && (!Array.isArray(q.options) || q.options.length > 128)) throw new Error('Opciones humanas inválidas.');
    const options = Array.isArray(q.options) ? q.options.map(option => {
      if (!object(option) || !string(option.id, 256) || !string(option.label, 1000)) throw new Error('Opción humana inválida.');
      const details: { description?: string; effect?: string; consequence?: string } = {};
      for (const key of ['description','effect','consequence'] as const) if (option[key] !== undefined) { if (!string(option[key], 8000, false)) throw new Error('El alcance de la opción humana no es válido.'); details[key] = option[key]; }
      return { id: option.id, label: option.label, ...details };
    }) : undefined;
    if ((q.action !== undefined && !string(q.action, 2000)) || (q.fingerprint !== undefined && !string(q.fingerprint, 1000))) throw new Error('La identidad del permiso no es válida.');
    page.question = { id: q.id, kind: q.kind, title: q.title, message: (q.message ?? '') as string, expiresAt: q.expiresAt, requiresConfirmation: q.requiresConfirmation === true || options?.some(option => Boolean(option.description || option.effect || option.consequence)) === true, ...(typeof q.action === 'string' ? { action: q.action } : {}), ...(typeof q.fingerprint === 'string' ? { fingerprint: q.fingerprint } : {}), ...(options ? { options } : {}) };
  }
  return page;
}

export function createDesktopSessionClient(dependencies: DesktopDependencies) {
  const request = dependencies.request ?? httpsRequest;
  function connection(): DesktopConnection { const value = dependencies.getConnection(); if (!value) throw new Error('Vincula la laptop para consultar sus sesiones de Pi.'); endpoint(value); return { ...value }; }
  function unchanged(expected: DesktopConnection): void {
    const current = dependencies.getConnection();
    if (!current || current.url !== expected.url || current.token !== expected.token || current.deviceId !== expected.deviceId) throw new Error('La conexión cambió desde la revisión. Vuelve a aprobar en el host actual.');
  }
  async function rpc(conn: DesktopConnection, payload?: object): Promise<unknown> {
    unchanged(conn);
    let reply: HTTPSResponse;
    try { reply = await request({ url: endpoint(conn), method: payload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}) }); }
    catch { throw new Error('El host no confirmó la operación. Consulta su estado antes de repetirla.'); }
    if (reply.status < 200 || reply.status >= 300) throw new Error(reply.status === 401 || reply.status === 403 ? 'El host rechazó el acceso o la aprobación. Revisa la vinculación.' : reply.status === 409 ? 'La sesión cambió; vuelve a consultarla.' : 'El host no pudo completar la operación.');
    if (reply.body.length > 1_000_000) throw new Error('Respuesta del host demasiado grande.');
    try { return JSON.parse(reply.body); } catch { throw new Error('El host devolvió una respuesta inválida.'); }
  }
  const inspect = async (conn: DesktopConnection, target: { paneId: string; sessionId: string }, limit = 20, before?: string) => parseDesktopPage(await rpc(conn, { action: 'inspect', ...target, limit, ...(before ? { before } : {}) }), target.sessionId);
  async function authorize(context: ToolContext, conn: DesktopConnection, title: string, payload: object): Promise<void> {
    context.signal.throwIfAborted();
    if (!context.askApproval || !await context.askApproval({ title, details: JSON.stringify({ host: endpoint(conn), ...payload }, null, 2), operation: 'desktop-session' })) throw new Error('La acción sobre la sesión no fue aprobada.');
    context.signal.throwIfAborted(); unchanged(conn);
  }
  return {
    async list(): Promise<DesktopSession[]> { return parseDesktopSessions(await rpc(connection())); },
    async read(args: unknown): Promise<DesktopPage> {
      const target = identity(args); const input = args as Record<string, unknown>;
      const limit = input.limit ?? 20; if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error('El límite debe ser de 1 a 100 mensajes.');
      const before = input.before === undefined ? undefined : field(input.before, 256, 'Cursor');
      return inspect(connection(), target, Number(limit), before);
    },
    async send(args: unknown, context: ToolContext) {
      const target = identity(args); const input = args as Record<string, unknown>; const text = field(input.text, 16000, 'Instrucción');
      const deliverAs = input.deliverAs ?? 'followUp'; if (deliverAs !== 'followUp' && deliverAs !== 'steer') throw new Error('Modo de entrega inválido.');
      const conn = connection(); const session = parseDesktopSessions(await rpc(conn)).find(item => item.paneId === target.paneId && item.sessionId === target.sessionId);
      if (!session?.connected || !session.capabilities.prompt || !session.capabilities.deliveryReceipts) throw new Error('La sesión debe estar conectada y admitir confirmaciones de entrega antes de enviar.');
      const before = await inspect(conn, target, 1); const clientMessageId = localIdentifier();
      const payload = Object.freeze({ action: 'prompt', ...target, text, deliverAs, clientMessageId });
      await authorize(context, conn, `Enviar a ${session.label || 'sesión de Pi'}`, payload);
      const fresh = await inspect(conn, target, 1); if (fresh.instanceId !== before.instanceId) throw new Error('Pi se reinició desde la revisión. La instrucción no se envió.');
      context.signal.throwIfAborted();
      let ack: unknown;
      try { ack = await rpc(conn, payload); }
      catch { return { status: 'uncertain', ...target, clientMessageId, message: 'El host no confirmó la recepción. Consulta session_read y busca este clientMessageId en deliveries; no repitas automáticamente.' }; }
      if (!object(ack) || ack.accepted !== true || ack.sessionId !== target.sessionId || ack.instanceId !== before.instanceId) return { status: 'uncertain', ...target, clientMessageId, message: 'La confirmación no corresponde a esta sesión. No se considera entregado ni completado.' };
      let receipt: DesktopDelivery | undefined;
      try { receipt = (await inspect(conn, target, 1)).deliveries.find(item => item.id === clientMessageId); } catch { /* Accepted is weaker than consumed; preserve that distinction. */ }
      return { status: receipt?.status ?? 'accepted', ...target, clientMessageId, ...(receipt ? { receipt } : {}), completed: false, message: 'La aceptación confirma recepción; sólo delivered confirma consumo por Pi. Consulta la sesión para conocer el resultado.' };
    },
    async abort(args: unknown, context: ToolContext) {
      const target = identity(args); const conn = connection(); const before = await inspect(conn, target, 1);
      const payload = Object.freeze({ action: 'abort', ...target });
      await authorize(context, conn, 'Detener el trabajo de esta sesión compartida', payload);
      const fresh = await inspect(conn, target, 1); if (fresh.instanceId !== before.instanceId) throw new Error('Pi cambió desde la revisión. No se detuvo otra instancia.');
      context.signal.throwIfAborted();
      const ack = await rpc(conn, payload);
      if (!object(ack) || ack.accepted !== true || ack.sessionId !== target.sessionId || ack.instanceId !== before.instanceId) throw new Error('El host no confirmó la cancelación de esta sesión.');
      return { accepted: true, ...target, completed: false };
    },
    /** Deliberately not a model tool. Call only from a human question/permission component. */
    async answerFromHuman(args: { paneId: string; sessionId: string; requestId: string; confirmed?: boolean; optionId?: string; text?: string; cancelled?: boolean }, context: ToolContext) {
      const target = identity(args); const conn = connection(); const page = await inspect(conn, target, 1); const question = page.question;
      if (!question || question.id !== args.requestId || Date.parse(question.expiresAt) <= Date.now()) throw new Error('La solicitud humana cambió o venció.');
      if (!['confirm','select','input'].includes(question.kind)) throw new Error('Este formulario requiere la interfaz humana de la laptop.');
      const answer = { ...(typeof args.confirmed === 'boolean' ? { confirmed: args.confirmed } : {}), ...(typeof args.cancelled === 'boolean' ? { cancelled: args.cancelled } : {}), ...(args.optionId !== undefined ? { optionId: field(args.optionId, 256, 'Opción') } : {}), ...(args.text !== undefined ? { text: field(args.text, 8000, 'Respuesta') } : {}) };
      if (!Object.keys(answer).length) throw new Error('Selecciona una respuesta humana explícita.');
      const payload = { action: 'answer', ...target, requestId: question.id, ...answer };
      await authorize(context, conn, question.title, { request: question, response: payload });
      const fresh = await inspect(conn, target, 1);
      if (fresh.instanceId !== page.instanceId || JSON.stringify(fresh.question) !== JSON.stringify(question)) throw new Error('El permiso cambió después de revisarlo.');
      context.signal.throwIfAborted();
      const ack = await rpc(conn, payload);
      if (!object(ack) || ack.accepted !== true || ack.sessionId !== target.sessionId || ack.instanceId !== page.instanceId) throw new Error('El host no confirmó la respuesta humana.');
      return { accepted: true, ...target, requestId: question.id };
    },
  };
}

export function createDesktopTools(dependencies: DesktopDependencies): Tool[] {
  const client = createDesktopSessionClient(dependencies);
  const target = { paneId: { type: 'string', description: 'Identificador exacto obtenido de session_list' }, sessionId: { type: 'string', description: 'Identificador exacto de la sesión Pi existente' } };
  const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', additionalProperties: false, properties, required });
  return [
    { definition: { name: 'session_list', description: 'Consulta sesiones Pi existentes de la laptop, su estado y capacidades. No crea sesiones.', parameters: schema({}, []) }, validate(args) { if (!object(args) || Object.keys(args).length) throw new Error('session_list no recibe argumentos.'); return {}; }, execute: async (args, context) => { context.signal.throwIfAborted(); if (!object(args) || Object.keys(args).length) throw new Error('Argumentos inválidos.'); return client.list(); } },
    { definition: { name: 'session_read', description: 'Lee mensajes, recibos de entrega y preguntas pendientes de una sesión existente. Las preguntas requieren respuesta humana; esta herramienta no las aprueba.', parameters: schema({ ...target, limit: { type: 'integer', minimum: 1, maximum: 100 }, before: { type: 'string' } }, ['paneId','sessionId']) }, validate(args) { identity(args); return args; }, execute: async (args, context) => { context.signal.throwIfAborted(); return client.read(args); } },
    { definition: { name: 'session_send', description: 'Propone una instrucción exacta para una sesión Pi existente y solicita aprobación humana dentro de la conversación antes de enviarla. Devuelve clientMessageId y estado de recepción; no implica tarea terminada. Nunca reenvíes una entrega incierta automáticamente.', parameters: schema({ ...target, text: { type: 'string', maxLength: 16000 }, deliverAs: { type: 'string', enum: ['followUp', 'steer'] } }, ['paneId','sessionId','text']) }, validate(args) { identity(args); field((args as Record<string, unknown>).text, 16000, 'Instrucción'); return args; }, execute: (args, context) => client.send(args, context) },
    { definition: { name: 'session_abort', description: 'Solicita aprobación humana para detener el trabajo de una sesión Pi compartida concreta. Afecta también al trabajo visible en la laptop.', parameters: schema(target, ['paneId','sessionId']) }, validate: identity, execute: (args, context) => client.abort(args, context) },
  ];
}
