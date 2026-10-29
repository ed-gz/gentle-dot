import { secretGet, secretSet, secretDelete } from './device-bridge.ts';
import { localIdentifier } from './local-identifiers.ts';

export type Provider = 'github' | 'slack' | 'gmail' | 'odoo';
export const MCP_OAUTH_CALLBACK = 'dev.gentledot.capri.auth:/oauth/mcp';
export type MCPOAuthGrant = { resource: string; issuer: string; tokenEndpoint: string };
export type ProviderCredentialBundle = { accessToken: string; refreshToken?: string; expiresAt?: number; provider?: Provider; clientId?: string; redirectUri?: string; scopes?: string[]; obtainedAt?: number; refreshState?: 'ready' | 'refreshing' | 'uncertain'; mcpOAuth?: MCPOAuthGrant };
export type ExternalConnection = { id: string; kind: 'mcp' | 'https-api'; label: string; endpoint: string; revision: number; enabled: boolean; credentialAccount?: string; createdAt: number; updatedAt: number; provider?: Provider; apiMode?: 'json2' | 'legacy'; database?: string; uid?: number };
export type ConnectionInput = Pick<ExternalConnection, 'kind' | 'label' | 'endpoint' | 'provider' | 'apiMode' | 'database' | 'uid'> & { id?: string; enabled?: boolean };
export type RemoteExecution = { requestId: string; fingerprint: string; connectionId: string; connectionRevision: number; endpoint: string; toolName: string; schemaJSON: string; argumentsJSON: string; state: 'executing' | 'succeeded' | 'uncertain' | 'reviewed'; createdAt: number; updatedAt: number; resultJSON?: string };
const DATABASE = 'capri-ios-external-connections';
const OPERATION_STATE = 'operation-state';
const ENDPOINT_OPERATION_STATE = 'endpoint-operation-state';
const EXECUTION_STATE = 'execution-state';
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
  if (input.mcpOAuth !== undefined) {
    const grant = input.mcpOAuth;
    if (!grant || typeof grant !== 'object' || input.provider || !bundle.clientId || bundle.redirectUri !== MCP_OAUTH_CALLBACK) throw new Error('La credencial OAuth MCP no corresponde a un cliente nativo.');
    const issuer = validEndpoint(grant.issuer);
    if (new URL(issuer).search) throw new Error('Emisor OAuth MCP inválido.');
    bundle.mcpOAuth = { resource: validEndpoint(grant.resource), issuer, tokenEndpoint: validEndpoint(grant.tokenEndpoint) };
  }
  if (new TextEncoder().encode(JSON.stringify(bundle)).length > 16384) throw new Error('La credencial supera el límite de Keychain.');
  return bundle;
}
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('El almacenamiento de conexiones no está disponible.')); return; }
    let settled = false;
    const timer = setTimeout(() => { settled = true; reject(new Error('El almacenamiento de conexiones no respondió.')); }, 8000);
    const open = indexedDB.open(DATABASE, 3);
    open.onupgradeneeded = () => {
      if (settled) { open.transaction?.abort(); return; }
      const db = open.result;
      if (!db.objectStoreNames.contains('connections')) db.createObjectStore('connections', { keyPath: 'id' });
      const executions = db.objectStoreNames.contains('executions')
        ? open.transaction!.objectStore('executions') : db.createObjectStore('executions', { keyPath: 'requestId' });
      if (!executions.indexNames.contains('fingerprint')) executions.createIndex('fingerprint', 'fingerprint');
      // The index is populated for existing records during upgrade. Approval
      // binds schema/revision; replay protection binds the actual operation.
      if (!executions.indexNames.contains(OPERATION_STATE)) executions.createIndex(OPERATION_STATE,
        ['connectionId', 'endpoint', 'toolName', 'argumentsJSON', 'state']);
      // Recreating a connection or changing credentials cannot erase an
      // uncertain operation at the same endpoint. Account identity is not
      // assumed from a local connection ID.
      if (!executions.indexNames.contains(ENDPOINT_OPERATION_STATE)) executions.createIndex(ENDPOINT_OPERATION_STATE,
        ['endpoint', 'toolName', 'argumentsJSON', 'state']);
      if (!executions.indexNames.contains(EXECUTION_STATE)) executions.createIndex(EXECUTION_STATE, 'state');
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
  if (bundle.mcpOAuth && (connection.kind !== 'mcp' || bundle.mcpOAuth.resource !== connection.endpoint)) throw new Error('La credencial corresponde a otro recurso MCP.');
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
  if (token && token.mcpOAuth && (input.kind !== 'mcp' || input.provider || token.mcpOAuth.resource !== endpoint)) throw new Error('La credencial corresponde a otro recurso MCP.');
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
      const store = tx.objectStore('executions'); let checked = 0;
      for (const state of ['executing', 'uncertain']) {
        // Count indexed keys rather than loading potentially large saved results.
        // An older schema-dependent fingerprint cannot bypass this stable key.
        const pending = store.index(ENDPOINT_OPERATION_STATE).count([value.endpoint, value.toolName, value.argumentsJSON, state]);
        pending.onsuccess = () => {
          if (pending.result > 0) { fail(new Error('Esta operación ya está ejecutándose o quedó incierta. Verifica el servicio antes de repetir.')); return; }
          if (++checked !== 2) return;
          const active = store.index(EXECUTION_STATE).count('executing'), uncertain = store.index(EXECUTION_STATE).count('uncertain');
          let counted=0; const checkLimit=()=>{
            if (++counted!==2) return;
            if (active.result + uncertain.result >= 1000) { fail(new Error('Hay demasiadas operaciones sin resolver; revisa la evidencia antes de continuar.')); return; }
            store.add(value); done();
          };
          active.onsuccess=checkLimit; uncertain.onsuccess=checkLimit;
        };
      }
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
export type PendingRemoteExecution = { requestId:string; endpoint:string; toolName:string; state:'executing'|'uncertain'; argumentsPreview:string; truncated:boolean };
/** Page unresolved records via their state index; do not load completed results. */
export async function listPendingRemoteExecutions(offset: number, limit: number): Promise<{items:PendingRemoteExecution[];total:number;offset:number;nextOffset?:number}> {
  if (!Number.isSafeInteger(offset)||offset<0||offset>1000||!Number.isSafeInteger(limit)||limit<1||limit>20) throw new Error('Rango inválido.');
  return transaction(['executions'],'readonly',(tx,done,fail)=>{
    const index=tx.objectStore('executions').index(EXECUTION_STATE), active=index.count('executing'), uncertain=index.count('uncertain');let counted=0;
    const start=()=>{if(++counted!==2)return;const total=active.result+uncertain.result,items:PendingRemoteExecution[]=[];let skip=offset;
      const read=(state:'executing'|'uncertain')=>{const cursor=index.openCursor(IDBKeyRange.only(state));cursor.onsuccess=()=>{
        try {const item=cursor.result;if(!item){if(state==='executing'){read('uncertain');return;}done({items,total,offset,...(offset+items.length<total?{nextOffset:offset+items.length}:{})});return;}
          if(skip>0){skip--;item.continue();return;}
          const value=item.value as RemoteExecution;
          if(!value || !uuid.test(value.requestId)||typeof value.endpoint!=='string'||validEndpoint(value.endpoint)!==value.endpoint||typeof value.toolName!=='string'||!value.toolName||value.toolName.length>256||typeof value.argumentsJSON!=='string'||value.argumentsJSON.length>100_000||value.state!==state)throw new Error('El registro requiere revisión y no se modificó.');
          items.push({requestId:value.requestId,endpoint:value.endpoint,toolName:value.toolName,state,argumentsPreview:value.argumentsJSON.slice(0,1000),truncated:value.argumentsJSON.length>1000});
          if(items.length===limit){done({items,total,offset,...(offset+items.length<total?{nextOffset:offset+items.length}:{})});return;}item.continue();
        }catch(error){fail(error instanceof Error?error:new Error('El registro requiere revisión.'));}
      };};
      read('executing');
    };
    active.onsuccess=start;uncertain.onsuccess=start;
  });
}
export async function getRemoteExecution(id:string):Promise<RemoteExecution | null> {
  if(!uuid.test(id)) throw new Error('ID de operación inválido.');
  return transaction(['executions'],'readonly',(tx,done)=>{const read=tx.objectStore('executions').get(id);read.onsuccess=()=>done(read.result??null);});
}
/** Human review closes only the exact unresolved record; it does not send,
 * cancel the original request or assert that the remote action succeeded. */
export async function reviewRemoteExecution(expected: RemoteExecution): Promise<void> {
  if (!expected || !uuid.test(expected.requestId) || !['executing','uncertain'].includes(expected.state)) throw new Error('El registro no requiere esta revisión.');
  const original = structuredClone(expected);
  await transaction<void>(['executions'], 'readwrite', (tx, done, fail) => {
    const store = tx.objectStore('executions'), read = store.get(original.requestId);
    read.onsuccess = () => {
      if (!read.result || JSON.stringify(read.result) !== JSON.stringify(original) || !['executing','uncertain'].includes(read.result.state)) {
        fail(new Error('La operación cambió después de la revisión.')); return;
      }
      store.put({ ...read.result, state:'reviewed', updatedAt:Date.now() }); done();
    };
  });
}
