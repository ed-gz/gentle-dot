import { httpsRequest, type HTTPSRequest, type HTTPSResponse } from './device-bridge.ts';
import { validDaemonUrl } from './local-state.ts';

export type TrustedApproval = Readonly<{ requestId: string; title: string; body: string; expiresAt: string; origin: string }>;
export type ApprovalConnection = { url: string; token: string };
export type ApprovalFailureCode = 'disconnected' | 'unauthorized' | 'forbidden' | 'expired' | 'changed' | 'invalid' | 'busy' | 'network' | 'uncertain';
export class ApprovalFailure extends Error {
  readonly code: ApprovalFailureCode;
  constructor(code: ApprovalFailureCode, message: string) { super(message); this.name = 'ApprovalFailure'; this.code = code; }
}
type Current = { origin: string; token: string };
type ApprovalView = { id: string; title: string; message: string; expiresAt: string };
type Witness = { connection: Current; exact: string };
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseViews(body: string): ApprovalView[] {
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new ApprovalFailure('invalid', 'El host devolvió permisos ilegibles. Revísalos en la laptop.'); }
  if (!object(value) || !Array.isArray(value.approvals) || value.approvals.length > 64) throw new ApprovalFailure('invalid', 'El host devolvió una lista de permisos inválida.');
  const ids = new Set(); const result: ApprovalView[] = [];
  for (const raw of value.approvals) {
    if (!object(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 200 || ids.has(raw.id) ||
      typeof raw.title !== 'string' || typeof raw.message !== 'string' || typeof raw.expiresAt !== 'string' || !Number.isFinite(Date.parse(raw.expiresAt))) {
      throw new ApprovalFailure('invalid', 'Un permiso del host no tiene una vista verificable. Revísalo en la laptop.');
    }
    const view = { id: raw.id, title: raw.title, message: raw.message, expiresAt: raw.expiresAt };
    if (new TextEncoder().encode(JSON.stringify(view)).length > 64 * 1024) throw new ApprovalFailure('invalid', 'El permiso supera el tamaño de revisión. Revísalo completo en la laptop.');
    ids.add(raw.id); result.push(view);
  }
  return result;
}
function statusFailure(status: number): ApprovalFailure {
  if (status === 401) return new ApprovalFailure('unauthorized', 'El acceso del teléfono expiró o fue revocado. Vuelve a vincularlo.');
  if (status === 403) return new ApprovalFailure('forbidden', 'Vincula este iPhone con autorización de la app de escritorio para responder permisos. El token maestro no habilita esta función.');
  if (status === 409) return new ApprovalFailure('expired', 'La solicitud ya terminó o venció. Actualiza los permisos.');
  return new ApprovalFailure('network', 'No se pudo consultar el estado del permiso. Revisa la laptop y la conexión.');
}

/** Human UI only. Never register list/answer as model tools or infer approval from prose. */
export function createTrustedApprovals(options: {
  getConnection(): ApprovalConnection | null | undefined;
  request?: (request: HTTPSRequest) => Promise<HTTPSResponse>;
  now?: () => number;
}) {
  const request = options.request ?? httpsRequest;
  const now = options.now ?? Date.now;
  const witnessed = new WeakMap<TrustedApproval, Witness>();
  const consumed = new WeakSet<TrustedApproval>();
  const inFlight = new Set<string>();
  function current(): Current {
    const connection = options.getConnection();
    if (!connection || !/^[A-Za-z0-9_-]{32,1024}$/.test(connection.token)) throw new ApprovalFailure('disconnected', 'Conecta un dispositivo vinculado antes de revisar permisos.');
    let origin: string;
    try { const url = new URL(validDaemonUrl(connection.url)); url.protocol = 'https:'; origin = url.origin; }
    catch { throw new ApprovalFailure('disconnected', 'La dirección del host no es válida.'); }
    return { origin, token: connection.token };
  }
  function sameConnection(expected: Current): void {
    const value = current();
    if (value.origin !== expected.origin || value.token !== expected.token) throw new ApprovalFailure('changed', 'La conexión cambió. Revisa de nuevo el permiso antes de responder.');
  }
  async function fetchViews(connection: Current): Promise<ApprovalView[]> {
    let response: HTTPSResponse;
    try { response = await request({ url: connection.origin + '/api/mobile/approvals', method: 'GET', headers: { Authorization: `Bearer ${connection.token}` } }); }
    catch { throw new ApprovalFailure('network', 'No se pudo consultar el permiso. No se envió ninguna respuesta.'); }
    if (response.status !== 200) throw statusFailure(response.status);
    sameConnection(connection);
    return parseViews(response.body);
  }
  return {
    async list(): Promise<TrustedApproval[]> {
      const connection = current();
      const views = await fetchViews(connection);
      return views.filter(view => Date.parse(view.expiresAt) > now()).map(view => {
        const snapshot: TrustedApproval = Object.freeze({ requestId: view.id, title: view.title, body: view.message, expiresAt: view.expiresAt, origin: connection.origin });
        witnessed.set(snapshot, { connection, exact: JSON.stringify(view) });
        return snapshot;
      });
    },
    async answer(snapshot: TrustedApproval, approved: boolean): Promise<{ confirmed: true; approved: boolean }> {
      const witness = witnessed.get(snapshot);
      if (!witness || typeof approved !== 'boolean') throw new ApprovalFailure('invalid', 'Primero abre y revisa el permiso actual.');
      if (consumed.has(snapshot)) throw new ApprovalFailure('uncertain', 'Esta respuesta ya se intentó. Consulta el host y revisa una nueva copia antes de repetir.');
      if (Date.parse(snapshot.expiresAt) <= now()) throw new ApprovalFailure('expired', 'El permiso venció. Actualiza la conversación.');
      const key = `${snapshot.origin}\n${snapshot.requestId}`;
      if (inFlight.has(key)) throw new ApprovalFailure('busy', 'La respuesta a este permiso ya está en curso.');
      inFlight.add(key);
      try {
        sameConnection(witness.connection);
        const views = await fetchViews(witness.connection);
        const fresh = views.find(view => view.id === snapshot.requestId);
        if (!fresh || Date.parse(fresh.expiresAt) <= now()) throw new ApprovalFailure('expired', 'La solicitud ya terminó o venció.');
        if (JSON.stringify(fresh) !== witness.exact) throw new ApprovalFailure('changed', 'El contenido del permiso cambió. Revisa su nueva versión antes de responder.');
        sameConnection(witness.connection);
        consumed.add(snapshot);
        let response: HTTPSResponse;
        try {
          response = await request({ url: witness.connection.origin + '/api/mobile/answer', method: 'POST',
            headers: { Authorization: `Bearer ${witness.connection.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: snapshot.requestId, approved }) });
        } catch { throw new ApprovalFailure('uncertain', 'No se confirmó la respuesta. Consulta el host antes de intentar de nuevo.'); }
        if (response.status !== 200) {
          if ([401, 403, 409].includes(response.status)) throw statusFailure(response.status);
          throw new ApprovalFailure('uncertain', 'El host no confirmó la respuesta. Consulta el permiso antes de volver a intentar.');
        }
        let value: unknown;
        try { value = JSON.parse(response.body); } catch { /* Success is only a verified server ACK. */ }
        if (!object(value) || value.ok !== true) throw new ApprovalFailure('uncertain', 'El host no confirmó la respuesta. Actualiza los permisos antes de repetir.');
        return { confirmed: true, approved };
      } finally { inFlight.delete(key); }
    },
  };
}
