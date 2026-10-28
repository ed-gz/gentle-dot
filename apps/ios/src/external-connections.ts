import { secretGet, secretSet, secretDelete } from './device-bridge.ts';
import { localIdentifier } from './local-identifiers.ts';

export type Provider = 'github' | 'slack' | 'gmail' | 'odoo';
export type ProviderCredentialBundle = { accessToken: string; refreshToken?: string; expiresAt?: number; provider?: Provider; clientId?: string; redirectUri?: string; scopes?: string[]; obtainedAt?: number; refreshState?: 'ready' | 'refreshing' | 'uncertain' };
export type ExternalConnection = { id: string; kind: 'mcp' | 'https-api'; label: string; endpoint: string; revision: number; enabled: boolean; credentialAccount?: string; createdAt: number; updatedAt: number; provider?: Provider; apiMode?: 'json2' | 'legacy'; database?: string; uid?: number };
export type ConnectionInput = Pick<ExternalConnection, 'kind' | 'label' | 'endpoint' | 'provider' | 'apiMode' | 'database' | 'uid'> & { id?: string; enabled?: boolean };
export type RemoteExecution = { requestId: string; fingerprint: string; connectionId: string; connectionRevision: number; endpoint: string; toolName: string; schemaJSON: string; argumentsJSON: string; state: 'executing' | 'succeeded' | 'uncertain'; createdAt: number; updatedAt: number; resultJSON?: string };
const DATABASE = 'capri-ios-external-connections';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function validEndpoint(input: string): string {
  if (typeof input !== 'string' || input.length > 2048 || /[\u0000-\u0020\\#]/.test(input)) throw new Error('Usa un endpoint HTTPS sin credenciales.');
  const url = new URL(input);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || input.split('/')[2]?.includes('@') || url.hash) throw new Error('Usa un endpoint HTTPS sin credenciales.');
  const forbidden = /^(token|access_token|refresh_token|api_key|apikey|key|client_secret|password|authorization)$/i;
  for (const key of url.searchParams.keys()) if (forbidden.test(key)) throw new Error('Las credenciales se guardan en Keychain, nunca en el endpoint.');
  return url.href;
}
export function validateConnection(value: unknown): ExternalConnection {
  if (!value || typeof value !== 'object') throw new Error('Conexión inválida.');
  const item = value as ExternalConnection;
  if (!uuid.test(item.id) || !['mcp', 'https-api'].includes(item.kind) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 80 ||
      !Number.isSafeInteger(item.revision) || item.revision < 1 || typeof item.enabled !== 'boolean' || !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt) ||
      (item.credentialAccount !== undefined && !uuid.test(item.credentialAccount))) throw new Error('Conexión inválida.');
  if (item.provider !== undefined && !['github', 'slack', 'gmail', 'odoo'].includes(item.provider) || item.apiMode !== undefined && !['json2', 'legacy'].includes(item.apiMode) ||
      item.database !== undefined && (typeof item.database !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(item.database)) || item.uid !== undefined && (!Number.isSafeInteger(item.uid) || item.uid < 1)) throw new Error('Metadatos del proveedor inválidos.');
  return { id: item.id, kind: item.kind, label: item.label.trim(), endpoint: validEndpoint(item.endpoint), revision: item.revision, enabled: item.enabled,
    ...(item.credentialAccount ? { credentialAccount: item.credentialAccount } : {}), createdAt: item.createdAt, updatedAt: item.updatedAt,
    ...(item.provider ? { provider: item.provider } : {}), ...(item.apiMode ? { apiMode: item.apiMode } : {}), ...(item.database ? { database: item.database } : {}), ...(item.uid ? { uid: item.uid } : {}) };
}
export function validateCredentialBundle(input: ProviderCredentialBundle): ProviderCredentialBundle {
  if (!input || typeof input !== 'object' || typeof input.accessToken !== 'string' || !input.accessToken || input.accessToken.length > 12000 || /[\u0000-\u0020\u007f]/.test(input.accessToken)) throw new Error('Credencial inválida.');
  const bundle: ProviderCredentialBundle = { accessToken: input.accessToken };
  if (input.refreshToken !== undefined) { if (typeof input.refreshToken !== 'string' || !input.refreshToken || input.refreshToken.length > 12000 || /[\u0000-\u0020\u007f]/.test(input.refreshToken)) throw new Error('Credencial de renovación inválida.'); bundle.refreshToken = input.refreshToken; }
  for (const key of ['expiresAt', 'obtainedAt'] as const) if (input[key] !== undefined) { if (!Number.isSafeInteger(input[key]) || input[key]! < 1) throw new Error('Fecha de credencial inválida.'); bundle[key] = input[key]; }
  if (input.provider !== undefined) { if (!['github', 'slack', 'gmail', 'odoo'].includes(input.provider)) throw new Error('Proveedor inválido.'); bundle.provider = input.provider; }
  for (const key of ['clientId', 'redirectUri'] as const) if (input[key] !== undefined) { if (typeof input[key] !== 'string' || !input[key] || input[key]!.length > 2048 || /[\u0000-\u0020\u007f]/.test(input[key]!)) throw new Error('Configuración OAuth inválida.'); bundle[key] = input[key]; }
  if (input.scopes !== undefined) { if (!Array.isArray(input.scopes) || input.scopes.length > 50 || input.scopes.some(scope => typeof scope !== 'string' || !scope || scope.length > 300 || /\s/.test(scope))) throw new Error('Scopes inválidos.'); bundle.scopes = [...new Set(input.scopes)]; }
  if (input.refreshState !== undefined) { if (!['ready', 'refreshing', 'uncertain'].includes(input.refreshState)) throw new Error('Estado de renovación inválido.'); bundle.refreshState = input.refreshState; }
  if (new TextEncoder().encode(JSON.stringify(bundle)).length > 16384) throw new Error('La credencial supera el límite de Keychain.');
  return bundle;
}
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('El almacenamiento de conexiones no está disponible.')); return; }
    let settled = false;
    const timer = setTimeout(() => { settled = true; reject(new Error('El almacenamiento de conexiones no respondió.')); }, 8000);
    const open = indexedDB.open(DATABASE, 1);
    open.onupgradeneeded = () => {
      if (settled) { open.transaction?.abort(); return; }
      open.result.createObjectStore('connections', { keyPath: 'id' });
      const executions = open.result.createObjectStore('executions', { keyPath: 'requestId' });
      executions.createIndex('fingerprint', 'fingerprint');
    };
    open.onerror = () => { clearTimeout(timer); reject(new Error('No se pudo abrir el almacenamiento de conexiones.')); };
    open.onblocked = () => { clearTimeout(timer); settled = true; reject(new Error('Cierra otras ventanas de Capri para abrir las conexiones.')); };
    open.onsuccess = () => { if (settled) { open.result.close(); return; } settled = true; clearTimeout(timer); resolve(open.result); };
  });
}
async function transaction<T>(stores: string[], mode: IDBTransactionMode, action: (tx: IDBTransaction, done: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode); let result: T; let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error('El almacenamiento local no confirmó la operación.'); try { tx.abort(); } catch { db.close(); reject(failure); } }, 8000);
    tx.oncomplete = () => { clearTimeout(timer); db.close(); resolve(result!); };
    tx.onabort = tx.onerror = () => { clearTimeout(timer); db.close(); reject(failure ?? new Error('No se guardó la operación de conexión.')); };
    try { action(tx, value => { result = value; }, error => { failure = error; tx.abort(); }); }
    catch (error) { failure = error instanceof Error ? error : new Error('Operación inválida.'); tx.abort(); }
  });
}
export async function listConnections(): Promise<ExternalConnection[]> {
  return transaction(['connections'], 'readonly', (tx, done, fail) => {
    const read = tx.objectStore('connections').getAll(); read.onsuccess = () => { try { done(read.result.map(validateConnection)); } catch (error) { fail(error as Error); } };
  });
}
export async function getConnection(id: string): Promise<ExternalConnection | null> {
  if (!uuid.test(id)) throw new Error('Identificador de conexión inválido.');
  return transaction(['connections'], 'readonly', (tx, done, fail) => {
    const read = tx.objectStore('connections').get(id); read.onsuccess = () => { try { done(read.result ? validateConnection(read.result) : null); } catch (error) { fail(error as Error); } };
  });
}
export async function connectionToken(connection: ExternalConnection): Promise<string | null> {
  if (!connection.credentialAccount) return null;
  const raw = await secretGet('external-connections', connection.credentialAccount);
  if (!raw) throw new Error('La credencial no está disponible en Keychain.');
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error('La credencial de conexión no es válida.'); }
  const token = (value as { accessToken?: unknown } | null)?.accessToken;
  if (typeof token !== 'string' || !token || token.length > 12000 || /[\u0000-\u0020\u007f]/.test(token)) throw new Error('La credencial de conexión no es válida.');
  const bundle = validateCredentialBundle(value as ProviderCredentialBundle);
  if (bundle.refreshState && bundle.refreshState !== 'ready') throw new Error('La renovación está pendiente o incierta; vuelve a autorizar la conexión antes de usarla.');
  if (bundle.expiresAt !== undefined && bundle.expiresAt <= Date.now() + 30_000) throw new Error('La credencial requiere renovación antes de usarla.');
  return token;
}
/** UI configuration only; tokens are never fields in the metadata transaction. */
export async function saveConnection(input: ConnectionInput, token?: string, expectedRevision?: number): Promise<ExternalConnection> {
  return saveCredentials(input, token === undefined || token === '' ? token : { accessToken: token }, expectedRevision);
}
export async function saveConnectionCredentials(input: ConnectionInput, credentials: ProviderCredentialBundle, expectedRevision?: number): Promise<ExternalConnection> {
  return saveCredentials(input, validateCredentialBundle(credentials), expectedRevision);
}
async function saveCredentials(input: ConnectionInput, token?: '' | ProviderCredentialBundle, expectedRevision?: number): Promise<ExternalConnection> {
  const id = input.id ?? localIdentifier();
  const old = input.id ? await getConnection(id) : null;
  if (old ? expectedRevision !== old.revision : expectedRevision !== undefined) throw new Error('La conexión cambió. Vuelve a revisar su configuración.');
  const endpoint = validEndpoint(input.endpoint);
  if (old?.credentialAccount && endpoint !== old.endpoint && token === undefined) throw new Error('Al cambiar el endpoint, introduce la credencial para ese destino o déjala explícitamente vacía.');
  if (token) token = validateCredentialBundle(token);
  const credentialAccount = token === undefined ? old?.credentialAccount : token ? localIdentifier() : undefined;
  const time = Date.now();
  const next = validateConnection({ id, kind: input.kind, label: input.label, endpoint, enabled: input.enabled ?? true,
    revision: (old?.revision ?? 0) + 1, credentialAccount, createdAt: old?.createdAt ?? time, updatedAt: time,
    provider: input.provider, apiMode: input.apiMode, database: input.database, uid: input.uid });
  if (token && credentialAccount) await secretSet('external-connections', credentialAccount, JSON.stringify(token));
  try {
    await transaction<void>(['connections'], 'readwrite', (tx, done, fail) => {
      const store = tx.objectStore('connections'); const read = store.get(id);
      read.onsuccess = () => {
        if ((read.result?.revision ?? 0) !== (old?.revision ?? 0)) { fail(new Error('Otra ventana cambió la conexión.')); return; }
        const count = store.count(); count.onsuccess = () => {
          if (!old && count.result >= 32) { fail(new Error('Se permiten hasta 32 conexiones.')); return; }
          store.put(next); done();
        };
      };
    });
  } catch (error) { if (token && credentialAccount) await secretDelete('external-connections', credentialAccount).catch(() => {}); throw error; }
  if (old?.credentialAccount && old.credentialAccount !== credentialAccount) await secretDelete('external-connections', old.credentialAccount).catch(() => {});
  return next;
}
export async function removeConnection(id: string, expectedRevision: number): Promise<void> {
  const old = await getConnection(id); if (!old || old.revision !== expectedRevision) throw new Error('La conexión cambió.');
  await transaction<void>(['connections'], 'readwrite', (tx, done, fail) => {
    const store = tx.objectStore('connections'); const read = store.get(id); read.onsuccess = () => {
      if (read.result?.revision !== expectedRevision) { fail(new Error('La conexión cambió.')); return; }
      store.delete(id); done();
    };
  });
  if (old.credentialAccount) await secretDelete('external-connections', old.credentialAccount);
}
export async function beginRemoteExecution(value: RemoteExecution): Promise<void> {
  await transaction<void>(['executions', 'connections'], 'readwrite', (tx, done, fail) => {
    const connection = tx.objectStore('connections').get(value.connectionId);
    connection.onsuccess = () => {
      if (connection.result?.revision !== value.connectionRevision || connection.result?.endpoint !== value.endpoint || !connection.result?.enabled) { fail(new Error('La conexión cambió antes de ejecutar.')); return; }
      const store = tx.objectStore('executions'); const related = store.index('fingerprint').getAll(value.fingerprint);
      related.onsuccess = () => {
        if (related.result.some((entry: RemoteExecution) => entry.state !== 'succeeded')) { fail(new Error('Esta operación ya está ejecutándose o quedó incierta. Verifica el servicio antes de repetir.')); return; }
        const count = store.count(); count.onsuccess = () => {
          if (count.result >= 1000) { fail(new Error('El registro de ejecuciones está lleno; conserva su evidencia antes de continuar.')); return; }
          store.add(value); done();
        };
      };
    };
  });
}
export async function finishRemoteExecution(requestId: string, state: 'succeeded' | 'uncertain', resultJSON?: string): Promise<void> {
  if (resultJSON && new TextEncoder().encode(resultJSON).length > 2 * 1024 * 1024) throw new Error('Resultado remoto demasiado grande.');
  await transaction<void>(['executions'], 'readwrite', (tx, done, fail) => {
    const store = tx.objectStore('executions'); const read = store.get(requestId); read.onsuccess = () => {
      if (!read.result || read.result.state !== 'executing') { fail(new Error('El estado de ejecución ya cambió.')); return; }
      store.put({ ...read.result, state, updatedAt: Date.now(), ...(resultJSON ? { resultJSON } : {}) }); done();
    };
  });
}
export async function listRemoteExecutions(): Promise<RemoteExecution[]> {
  return transaction(['executions'], 'readonly', (tx, done) => { const read = tx.objectStore('executions').getAll(); read.onsuccess = () => done(read.result); });
}
