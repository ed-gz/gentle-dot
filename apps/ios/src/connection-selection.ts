import { secretGet, secretSet } from './device-bridge.ts';
import { privateOrigin, restorePairing, restorePairingAttempt, validConnection, type PairedConnection } from './device-pairing.ts';
import { validDaemonUrl } from './local-state.ts';

export type SelectedConnection = { source: 'manual'; url: string; token: string } |
  ({ source: 'paired' } & PairedConnection);
export class ConnectionSelectionPending extends Error {
  readonly hasPrevious: boolean;
  readonly hasCandidate: boolean;
  constructor(hasPrevious: boolean, hasCandidate = false) {
    super('El último acceso no se guardó por completo. Vuelve a conectar Capri o recupera el acceso anterior.');
    this.name = 'ConnectionSelectionPending'; this.hasPrevious = hasPrevious; this.hasCandidate = hasCandidate;
  }
}
export class ConnectionSelectionAmbiguous extends Error {
  constructor() { super('Hay dos accesos guardados para esta laptop. Vuelve a elegir cómo conectarte.'); this.name = 'ConnectionSelectionAmbiguous'; }
}
type Marker = { version: 1; state: 'pending'; url: string; previous?: SelectedConnection; candidate?: SelectedConnection; pairingAttemptId?: string } | { version: 1; state: 'disconnected' } |
  { version: 1; state: 'active'; connection: SelectedConnection };
type SecretReader = typeof secretGet;
type SecretWriter = typeof secretSet;
type PairingReader = typeof restorePairing;
const account = 'capri.selected-connection.v1';
const validAttempt = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);

function validManual(value: unknown): value is SelectedConnection & { source: 'manual' } {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  if (input.source !== 'manual' || typeof input.url !== 'string' || typeof input.token !== 'string' ||
      !input.token || new TextEncoder().encode(input.token).length > 8192 || /[\u0000-\u001f\u007f]/.test(input.token)) return false;
  try { return validDaemonUrl(input.url) === input.url; } catch { return false; }
}
function validSelected(value: unknown): value is SelectedConnection {
  if (validManual(value)) return true;
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  if (input.source !== 'paired' || typeof input.url !== 'string') return false;
  try { return validConnection(input, privateOrigin(new URL(input.url.replace(/^wss:/, 'https:')).origin)); }
  catch { return false; }
}
function parseMarker(text: string): Marker {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('No pude verificar el acceso seleccionado. Vuelve a conectar Capri.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('No pude verificar el acceso seleccionado. Vuelve a conectar Capri.');
  const item = parsed as Record<string, unknown>;
  if (item.version !== 1) throw new Error('No pude verificar el acceso seleccionado. Vuelve a conectar Capri.');
  if (item.state === 'disconnected') return { version: 1, state: 'disconnected' };
  if (item.state === 'pending' && typeof item.url === 'string') {
    try {
      if (validDaemonUrl(item.url) === item.url && (item.previous === undefined || validSelected(item.previous)) &&
          (item.candidate === undefined || (validSelected(item.candidate) && item.candidate.url === item.url)) &&
          (item.pairingAttemptId === undefined || validAttempt(item.pairingAttemptId)))
        return { version: 1, state: 'pending', url: item.url, ...(item.previous ? { previous: item.previous as SelectedConnection } : {}),
          ...(item.candidate ? { candidate: item.candidate as SelectedConnection } : {}), ...(item.pairingAttemptId ? { pairingAttemptId: item.pairingAttemptId as string } : {}) };
    } catch { /* fail closed */ }
  }
  if (item.state === 'active' && validSelected(item.connection)) return { version: 1, state: 'active', connection: item.connection };
  throw new Error('No pude verificar el acceso seleccionado. Vuelve a conectar Capri.');
}

/**
 * Atomic Keychain selection, separate from legacy per-host entries. A pending
 * marker is written before changing a connection; a failed or interrupted save
 * cannot silently reactivate the previous credential after restart.
 *
 * The caller must disable both connection forms and disconnect while begin or
 * commit is in flight. A ticket fences stale callbacks in this web view, but
 * cannot make a queued Keychain write atomic across process termination.
 */
export function createConnectionSelectionStore(dependencies: {
  get?: SecretReader;
  set?: SecretWriter;
  pairing?: PairingReader;
} = {}) {
  const get = dependencies.get ?? secretGet;
  const set = dependencies.set ?? secretSet;
  const pairing = dependencies.pairing ?? restorePairing;
  let generation = 0;
  let pending = false;
  let boundAttempt: { ticket: number; pairingAttemptId?: string } | undefined;

  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (pending) return Promise.reject(new Error('Espera a que termine de guardarse el acceso.'));
    pending = true;
    return run().finally(() => { pending = false; });
  }
  async function begin(url: string, current?: SelectedConnection, pairingAttemptId?: string): Promise<number> {
    const canonical = validDaemonUrl(url);
    if (current && !validSelected(current)) throw new Error('No pude conservar el acceso anterior.');
    if (pairingAttemptId !== undefined && !validAttempt(pairingAttemptId)) throw new Error('Identidad de vinculación inválida.');
    return exclusive(async () => {
      const ticket = ++generation;
      const existingText = await get('daemon-manual', account);
      const existing = existingText === null ? undefined : parseMarker(existingText);
      const previous = current ?? (existing?.state === 'active' ? existing.connection : existing?.state === 'pending' ? existing.previous : undefined);
      await set('daemon-manual', account, JSON.stringify({ version: 1, state: 'pending', url: canonical, ...(previous ? { previous } : {}), ...(pairingAttemptId ? { pairingAttemptId } : {}) } satisfies Marker));
      boundAttempt = { ticket, pairingAttemptId };
      return ticket;
    });
  }
  async function commit(ticket: number, connection: SelectedConnection): Promise<void> {
    if (!validSelected(connection)) throw new Error('El acceso no corresponde a la conexión seleccionada.');
    return exclusive(async () => {
      if (ticket !== generation) throw new Error('La conexión cambió antes de guardar el acceso.');
      const markerText = await get('daemon-manual', account);
      const marker = markerText === null ? undefined : parseMarker(markerText);
      const safe: SelectedConnection = connection.source === 'manual'
        ? { source: 'manual', url: connection.url, token: connection.token }
        : { source: 'paired', url: connection.url, token: connection.token, deviceId: connection.deviceId, name: connection.name };
      if (marker?.state === 'active' && JSON.stringify(marker.connection) === JSON.stringify(safe) && ticket === generation) return;
      if (!marker || marker.state !== 'pending' || marker.url !== connection.url || ticket !== generation || boundAttempt?.ticket !== ticket || marker.pairingAttemptId !== boundAttempt.pairingAttemptId) {
        throw new Error('La conexión cambió antes de guardar el acceso.');
      }
      // Construct an allowlisted record, never serialize extra caller fields.
      try { await set('daemon-manual', account, JSON.stringify({ version: 1, state: 'active', connection: safe } satisfies Marker)); }
      catch (error) {
        // A lost bridge response may follow a completed Keychain write. Only
        // a fresh exact read can confirm that this specific selection landed.
        try {
          const after = await get('daemon-manual', account);
          const verified = after === null ? undefined : parseMarker(after);
          if (verified?.state === 'active' && JSON.stringify(verified.connection) === JSON.stringify(safe) && ticket === generation) return;
        } catch { /* Unknown result remains unconfirmed. */ }
        throw error;
      }
    });
  }
  async function stage(ticket: number, connection: SelectedConnection): Promise<void> {
    if (!validSelected(connection)) throw new Error('El acceso no corresponde a la conexión seleccionada.');
    return exclusive(async () => {
      if (ticket !== generation) throw new Error('La conexión cambió antes de guardar el acceso.');
      const markerText = await get('daemon-manual', account);
      const marker = markerText === null ? undefined : parseMarker(markerText);
      if (!marker || marker.state !== 'pending' || marker.url !== connection.url || boundAttempt?.ticket !== ticket || marker.pairingAttemptId !== boundAttempt.pairingAttemptId) throw new Error('La conexión cambió antes de guardar el acceso.');
      const candidate: SelectedConnection = connection.source === 'manual'
        ? { source: 'manual', url: connection.url, token: connection.token }
        : { source: 'paired', url: connection.url, token: connection.token, deviceId: connection.deviceId, name: connection.name };
      await set('daemon-manual', account, JSON.stringify({ ...marker, candidate } satisfies Marker));
    });
  }
  async function rollback(ticket: number, clearEmpty = false): Promise<SelectedConnection | null> {
    return exclusive(async () => {
      if (ticket !== generation) throw new Error('La conexión cambió antes de recuperar el acceso.');
      const markerText = await get('daemon-manual', account);
      const marker = markerText === null ? undefined : parseMarker(markerText);
      if (!marker || marker.state !== 'pending') return null;
      if (boundAttempt?.ticket !== ticket || marker.pairingAttemptId !== boundAttempt.pairingAttemptId) throw new Error('La conexión cambió antes de recuperar el acceso.');
      if (!marker.previous) {
        if (clearEmpty && !marker.candidate) {
          await set('daemon-manual', account, JSON.stringify({ version: 1, state: 'disconnected' } satisfies Marker));
          ++generation;
        }
        return null;
      }
      await set('daemon-manual', account, JSON.stringify({ version: 1, state: 'active', connection: marker.previous } satisfies Marker));
      ++generation;
      return marker.previous;
    });
  }
  async function disconnect(): Promise<void> {
    return exclusive(async () => {
      ++generation;
      // A tombstone prevents legacy credentials from reappearing on restart.
      await set('daemon-manual', account, JSON.stringify({ version: 1, state: 'disconnected' } satisfies Marker));
    });
  }
  async function recoverPrevious(): Promise<SelectedConnection | null> {
    return exclusive(async () => {
      const text = await get('daemon-manual', account);
      const marker = text === null ? undefined : parseMarker(text);
      if (!marker || marker.state !== 'pending' || !marker.previous) return null;
      await set('daemon-manual', account, JSON.stringify({ version: 1, state: 'active', connection: marker.previous } satisfies Marker));
      ++generation;
      return marker.previous;
    });
  }
  async function recoverCandidate(): Promise<{ ticket: number; connection: SelectedConnection; previous?: SelectedConnection } | null> {
    return exclusive(async () => {
      const text = await get('daemon-manual', account);
      const marker = text === null ? undefined : parseMarker(text);
      if (!marker || marker.state !== 'pending') return null;
      let candidate = marker.candidate;
      if (!candidate && marker.pairingAttemptId) {
        const origin = new URL(marker.url.replace(/^wss:/, 'https:')).origin;
        const paired = await restorePairingAttempt(origin, marker.pairingAttemptId, get);
        if (paired && paired.url === marker.url) candidate = { source: 'paired', ...paired };
      }
      if (!candidate) return null;
      const ticket = ++generation;
      boundAttempt = { ticket, pairingAttemptId: marker.pairingAttemptId };
      return { ticket, connection: candidate, ...(marker.previous ? { previous: marker.previous } : {}) };
    });
  }
  async function restore(url?: string): Promise<SelectedConnection | null> {
    const markerText = await get('daemon-manual', account);
    if (markerText !== null) {
      const marker = parseMarker(markerText);
      if (marker.state === 'disconnected') return null;
      if (marker.state === 'pending') throw new ConnectionSelectionPending(Boolean(marker.previous), Boolean(marker.candidate || marker.pairingAttemptId));
      return marker.connection;
    }
    if (!url) return null;
    const canonical = validDaemonUrl(url);
    // Migration cannot infer which of two old credentials the user chose.
    // Never pick one silently or fall back after a Keychain read error.
    const origin = new URL(canonical.replace(/^wss:/, 'https:')).origin;
    let paired: PairedConnection | null = null;
    try { privateOrigin(origin); } catch {
      const token = await get('daemon-manual', origin);
      const candidate = { source: 'manual' as const, url: canonical, token: token ?? '' };
      if (token === null) return null;
      if (!validManual(candidate)) throw new Error('El acceso manual guardado no es válido.');
      return candidate;
    }
    paired = await pairing(origin);
    const token = await get('daemon-manual', origin);
    if (paired && token !== null) throw new ConnectionSelectionAmbiguous();
    if (paired) {
      if (paired.url !== canonical) throw new Error('El acceso guardado corresponde a otra dirección.');
      return { source: 'paired', ...paired };
    }
    if (token === null) return null;
    const candidate = { source: 'manual' as const, url: canonical, token };
    if (!validManual(candidate)) throw new Error('El acceso manual guardado no es válido.');
    return candidate;
  }
  return { begin, stage, commit, rollback, recoverPrevious, recoverCandidate, disconnect, restore };
}
