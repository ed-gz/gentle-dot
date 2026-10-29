import { localIdentifier } from './local-identifiers.ts';
import { CloseCode, PROTOCOL_VERSION, parseWorkSyncReply, parseWorkSyncRequest, type AgentState, type Ask, type ServerMessage, type WorkSyncReply, type WorkSyncRequest } from '@gentle-dot/protocol';
import { validDaemonUrl } from './local-state.ts';

export type LinkedStatus = 'offline' | 'connecting' | 'ready' | 'rejected';
type Callbacks = { onStatus(status: LinkedStatus): void; onMessage(message: ServerMessage): void };
const MAX_PAYLOAD = 1_000_000;
const STATES = new Set<AgentState>(['starting', 'idle', 'thinking', 'working', 'needs_you', 'restarting', 'error']);
const BACKOFF = [500, 1000, 2000, 5000, 10000, 30000];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const id = (value: unknown): value is string => string(value) && value.length > 0 && value.length <= 512;
const optional = (value: unknown, check: (input: unknown) => boolean) => value === undefined || check(value);
const boolean = (value: unknown) => typeof value === 'boolean';
const featureVersion = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
const state = (value: unknown) => string(value) && STATES.has(value as AgentState);
const oneOf = (value: unknown, values: readonly string[]) => string(value) && values.includes(value);
const strings = (value: unknown) => Array.isArray(value) && value.length <= 1000 && value.every(string);
const activity = (value: unknown) => record(value) && id(value.id) && string(value.title)
  && oneOf(value.kind, ['read', 'edit', 'run', 'search', 'memory', 'delegate', 'other'])
  && oneOf(value.status, ['running', 'done', 'failed']);
const attachments = (value: unknown) => Array.isArray(value) && value.length <= 10 && value.every(item => record(item)
  && string(item.name) && string(item.mime) && typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0);

export const askSnapshot = (ask: Ask) => JSON.stringify([ask.requestId, ask.method, ask.title, ask.message, ask.options, ask.placeholder, ask.prefill, ask.expiresAt, ask.timeoutMs]);

/** Only this shell's supported events cross the untrusted WebSocket boundary. */
function parse(raw: unknown): ServerMessage | undefined {
  if (!string(raw) || raw.length > MAX_PAYLOAD || new TextEncoder().encode(raw).byteLength > MAX_PAYLOAD) return;
  let message: unknown;
  try { message = JSON.parse(raw); } catch { return; }
  if (!record(message) || !Number.isSafeInteger(message.seq) || (message.seq as number) < 0) return;
  let valid = false;
  switch (message.type) {
    case 'work_sync_reply': valid = !!parseWorkSyncReply(message); break;
    case 'ready':
      valid = state(message.agentState) && optional(message.conversationId, id) && optional(message.clientId, id)
        && optional(message.model, string)
        && optional(message.features, value => record(value) && boolean(value.conversations) && optional(value.historyRefresh, boolean)
          && optional(value.workSync, featureVersion) && optional(value.meetingDrafts, featureVersion)
          && optional(value.sendAccepted, featureVersion))
        && optional(message.voice, value => record(value) && boolean(value.transcribe) && boolean(value.speak) && optional(value.local, boolean))
        && optional(message.pin, value => record(value) && boolean(value.set) && optional(value.locked, boolean));
      break;
    case 'agent_state': valid = state(message.state); break;
    case 'request_accepted': valid = id(message.requestId) && message.requestId.length <= 200; break;
    case 'history':
      valid = optional(message.conversationId, id) && optional(message.requestId, id) && optional(message.hasEarlier, boolean)
        && Array.isArray(message.messages) && message.messages.length <= 2000 && message.messages.every(entry => record(entry)
          && id(entry.id) && oneOf(entry.role, ['user', 'assistant']) && string(entry.text)
          && Array.isArray(entry.activities) && entry.activities.length <= 1000 && entry.activities.every(activity)
          && optional(entry.attachments, attachments) && optional(entry.earlier, value => value === true));
      break;
    case 'user_message':
      valid = id(message.messageId) && string(message.text) && optional(message.attachments, attachments); break;
    case 'message_delta': valid = id(message.messageId) && string(message.delta); break;
    case 'message_done':
      valid = id(message.messageId) && string(message.text) && optional(message.error, string)
        && optional(message.intermediate, value => value === true) && optional(message.stopped, value => value === true); break;
    case 'activity': valid = id(message.messageId) && activity(message.activity); break;
    case 'toast':
      valid = oneOf(message.level, ['info', 'warning', 'error']) && string(message.message)
        && optional(message.title, string) && optional(message.notificationId, id)
        && optional(message.notificationEvent, value => oneOf(value, ['dotReply', 'dotError', 'agentCompleted', 'agentAttention', 'agentError', 'agentAvailable', 'permission']))
        && optional(message.session, value => record(value) && id(value.paneId) && optional(value.sessionId, id));
      break;
    case 'ask': {
      const ask = message.ask;
      valid = record(ask) && id(ask.requestId) && string(ask.title)
        && oneOf(ask.method, ['select', 'confirm', 'input', 'editor', 'app', 'pin'])
        && optional(ask.message, string) && optional(ask.options, strings) && optional(ask.placeholder, string)
        && optional(ask.prefill, string) && optional(ask.expiresAt, string)
        && optional(ask.timeoutMs, value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
      break;
    }
    case 'ask_resolved': valid = id(message.requestId); break;
    case 'error': valid = id(message.code) && string(message.message); break;
    case 'interrupted': valid = true; break;
    case 'queue': valid = strings(message.steering) && strings(message.followUp); break;
  }
  return valid ? message as ServerMessage : undefined;
}

/** Foreground connection only. No credential storage, automatic prompt retry or native privileges. */
export function createLinkedChat(callbacks: Callbacks) {
  let credentials: { url: string; token: string } | undefined;
  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let suspended = false;
  let authenticated = false;
  let workSync = false, meetingDrafts = false, sendAccepted = false;
  const asks = new Map<string, Ask>();
  const requests = new Map<string, { transferId: string; resolve(reply: WorkSyncReply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  function clearConnection() {
    clearTimeout(retryTimer);
    clearTimeout(connectTimer);
    retryTimer = connectTimer = undefined;
    const old = socket;
    socket = undefined;
    authenticated = false; workSync = meetingDrafts = sendAccepted = false;
    asks.clear();
    for (const request of requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('El enlace se interrumpió; la operación no tiene confirmación.'));
    }
    requests.clear();
    old?.close();
  }
  function retry() {
    clearConnection();
    callbacks.onStatus('offline');
    if (!credentials || suspended) return;
    const delay = BACKOFF[Math.min(attempts++, BACKOFF.length - 1)]!;
    retryTimer = setTimeout(() => { retryTimer = undefined; open(); }, delay);
  }
  function transmit(message: object): boolean {
    if (!authenticated || !socket || socket.readyState !== WebSocket.OPEN) return false;
    try { socket.send(JSON.stringify(message)); return true; }
    catch { retry(); return false; }
  }
  function open() {
    if (!credentials || suspended) return;
    clearConnection();
    callbacks.onStatus('connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(credentials.url); } catch { retry(); return; }
    socket = ws;
    let sequence = -1;
    const current = () => socket === ws && !suspended;
    connectTimer = setTimeout(() => { if (current() && !authenticated) retry(); }, 12000);
    ws.onopen = () => {
      if (!current() || !credentials) return;
      try { ws.send(JSON.stringify({ type: 'hello', token: credentials.token, protocol: PROTOCOL_VERSION })); }
      catch { retry(); }
    };
    ws.onmessage = event => {
      if (!current()) return;
      const message = parse(event.data);
      if (!message || message.seq <= sequence || (!authenticated && message.type !== 'ready')) return;
      if (message.type === 'request_accepted' && !sendAccepted) return;
      sequence = message.seq;
      if (message.type === 'ask') asks.set(message.ask.requestId, message.ask);
      if (message.type === 'ask_resolved') asks.delete(message.requestId);
      if (message.type === 'work_sync_reply') {
        const request = requests.get(message.requestId);
        if (request && request.transferId === message.transferId) {
          clearTimeout(request.timer); requests.delete(message.requestId); request.resolve(message);
        }
        return;
      }
      if (message.type === 'ready') {
        if (authenticated) return;
        clearTimeout(connectTimer);
        connectTimer = undefined;
        authenticated = true;
        workSync = message.features?.workSync === 1; meetingDrafts = workSync && message.features?.meetingDrafts === 1;
        sendAccepted = message.features?.sendAccepted === 1;
        attempts = 0;
        callbacks.onStatus('ready');
        if (!current() || !transmit({ type: 'get_history' })) return;
      }
      if (current()) callbacks.onMessage(message);
    };
    ws.onclose = event => {
      if (!current()) return;
      if (event.code === CloseCode.unauthorized || event.code === CloseCode.badProtocol) {
        credentials = undefined;
        clearConnection();
        callbacks.onStatus('rejected');
      } else retry();
    };
    ws.onerror = () => { if (current()) retry(); };
  }
  return {
    connect(url: string, token: string) {
      const endpoint = validDaemonUrl(url);
      const secret = token.trim();
      if (!secret || secret.length > 4096) throw new Error('Introduce un token válido para conectar.');
      clearConnection();
      credentials = { url: endpoint, token: secret };
      attempts = 0;
      suspended = false;
      open();
    },
    disconnect() {
      credentials = undefined;
      clearConnection();
      callbacks.onStatus('offline');
    },
    suspend() {
      suspended = true;
      clearConnection();
      callbacks.onStatus('offline');
    },
    resume() {
      suspended = false;
      if (credentials && !socket && !retryTimer) { attempts = 0; open(); }
    },
    send(text: string, requestId?: string): boolean {
      const value = text.trim();
      if (!value || text.length > 8000 || !authenticated) return false;
      const identifier = requestId ?? localIdentifier();
      if (!id(identifier) || identifier.length > 200) return false;
      return transmit({ type: 'send', text: value, requestId: identifier, ...(sendAccepted ? { receipt: 'accepted-v1' } : {}) });
    },
    answer(requestId: string, fields: { value?: string; confirmed?: boolean; cancelled?: boolean }, expected?: Ask): boolean {
      const ask = asks.get(requestId);
      if (!ask || (expected && askSnapshot(ask) !== askSnapshot(expected)) || !authenticated || ask.method === 'app' || ask.method === 'pin'
        || (ask.expiresAt !== undefined && (!Number.isFinite(Date.parse(ask.expiresAt)) || Date.parse(ask.expiresAt) <= Date.now()))) return false;
      if (fields.cancelled === true) return transmit({ type: 'ui_response', requestId, cancelled: true });
      if (ask.method === 'confirm' && typeof fields.confirmed === 'boolean') return transmit({ type: 'ui_response', requestId, confirmed: fields.confirmed });
      if (['input', 'editor', 'select'].includes(ask.method) && typeof fields.value === 'string' && fields.value.length <= 32000
        && (ask.method !== 'select' || ask.options?.includes(fields.value))) return transmit({ type: 'ui_response', requestId, value: fields.value });
      return false;
    },
    exchange(request: WorkSyncRequest): Promise<WorkSyncReply> {
      const safe = parseWorkSyncRequest(request);
      if (!safe || requests.has(safe.requestId) || !authenticated) return Promise.reject(new Error('Conecta Gentle Dot antes de transferir el trabajo.'));
      if (!workSync) return Promise.reject(new Error('Actualiza Gentle Dot en la laptop para transferir trabajos. La conversación sigue disponible y el trabajo local se conserva.'));
      if (safe.operation === 'process' && !meetingDrafts) return Promise.reject(new Error('Este Gentle Dot no tiene disponible el procesamiento de reuniones. El material confirmado se conserva.'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          requests.delete(safe.requestId);
          reject(new Error('El host no confirmó la operación. Consulta su estado antes de reintentar.'));
        }, 30000);
        requests.set(safe.requestId, { transferId: safe.transferId, resolve, reject, timer });
        if (!transmit(safe)) {
          clearTimeout(timer); requests.delete(safe.requestId);
          reject(new Error('No se pudo confirmar el envío al host.'));
        }
      });
    },
    abort: () => transmit({ type: 'abort' }),
    supportsWorkSync: () => authenticated && workSync,
    supportsMeetingDrafts: () => authenticated && meetingDrafts,
    supportsSendAccepted: () => authenticated && sendAccepted,
    ready: () => authenticated && socket?.readyState === WebSocket.OPEN,
  };
}
