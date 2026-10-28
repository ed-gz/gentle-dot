import { secretGet } from './device-bridge.ts';
import { getConnection, saveConnectionCredentials, validateCredentialBundle,
  type ConnectionInput, type ExternalConnection, type ProviderCredentialBundle } from './external-connections.ts';
import { createProviderOAuth, PROVIDER_API_ENDPOINTS, validateOAuthConfig,
  type ProviderOAuthConfig, type DeviceAuthorization } from './provider-oauth.ts';

type OAuthClient = ReturnType<typeof createProviderOAuth>;
export interface ProviderOAuthStoreDependencies {
  getConnection(id: string): Promise<ExternalConnection | null>;
  readSecret(account: string): Promise<string | null>;
  save(input: ConnectionInput, credentials: ProviderCredentialBundle, expectedRevision?: number): Promise<ExternalConnection>;
  oauth: OAuthClient;
  now(): number;
}
const defaults: ProviderOAuthStoreDependencies = {
  getConnection, readSecret: account => secretGet('external-connections', account),
  save: saveConnectionCredentials, oauth: createProviderOAuth(), now: Date.now,
};
function configuration(connection: ExternalConnection): ConnectionInput {
  return { id: connection.id, kind: connection.kind, label: connection.label, endpoint: connection.endpoint,
    enabled: connection.enabled, provider: connection.provider, apiMode: connection.apiMode, database: connection.database, uid: connection.uid };
}
function parseSecret(raw: string | null): ProviderCredentialBundle {
  if (!raw || raw.length > 16384) throw new Error('No se recuperó la credencial de Keychain.');
  let parsed: ProviderCredentialBundle;
  try { parsed = JSON.parse(raw); } catch { throw new Error('La credencial guardada no es válida. Vuelve a autorizar la cuenta.'); }
  return validateCredentialBundle(parsed);
}
function assertProviderTarget(connection: Pick<ExternalConnection, 'provider' | 'endpoint' | 'kind'>, provider?: string) {
  if (connection.kind !== 'https-api' || !connection.provider || (provider && connection.provider !== provider)) throw new Error('La credencial no corresponde a esta conexión de proveedor.');
  if (connection.provider !== 'odoo') {
    const expected = PROVIDER_API_ENDPOINTS[connection.provider];
    if (new URL(connection.endpoint).href.replace(/\/$/, '') !== expected.replace(/\/$/, '')) throw new Error('La credencial sólo puede utilizarse con el endpoint oficial del proveedor.');
  }
}

/** UI/adapter service only. Never expose the returned credential to model observations. */
export function createProviderOAuthStore(overrides: Partial<ProviderOAuthStoreDependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  const pending = new Map<string, Promise<{ connection: ExternalConnection; accessToken: string }>>();
  async function assertCurrent(expected: ExternalConnection) {
    const current = await dependencies.getConnection(expected.id);
    if (!current || !current.enabled || current.revision !== expected.revision || current.credentialAccount !== expected.credentialAccount
      || current.kind !== expected.kind || current.provider !== expected.provider || current.endpoint !== expected.endpoint
      || current.apiMode !== expected.apiMode || current.database !== expected.database || current.uid !== expected.uid) {
      throw new Error('La conexión cambió mientras se recuperaba el acceso. Vuelve a revisar su configuración.');
    }
  }
  async function resolveAccess(connectionId: string) {
    const connection = await dependencies.getConnection(connectionId);
    if (!connection || !connection.enabled || !connection.credentialAccount) throw new Error('La conexión no tiene una credencial activa.');
    assertProviderTarget(connection);
    const bundle = parseSecret(await dependencies.readSecret(connection.credentialAccount));
    await assertCurrent(connection);
    assertProviderTarget(connection, bundle.provider);
    if (bundle.refreshState && bundle.refreshState !== 'ready') throw new Error('La renovación anterior quedó sin confirmar. Autoriza de nuevo esta cuenta; no se repetirá el refresh.');
    if (bundle.expiresAt === undefined || bundle.expiresAt > dependencies.now() + 60000) return { connection, accessToken: bundle.accessToken };
    if (!bundle.refreshToken || !bundle.clientId || !bundle.provider || bundle.provider === 'odoo') throw new Error('La credencial venció. Autoriza de nuevo la cuenta.');
    // This revision CAS reserves a one-use refresh across windows and app restarts.
    const reserved = await dependencies.save(configuration(connection), { ...bundle, refreshState: 'refreshing' }, connection.revision);
    let refreshed: ProviderCredentialBundle;
    try {
      // A caller cancellation after reservation cannot discard rotated credentials.
      refreshed = await dependencies.oauth.refresh(bundle);
      const stored = await dependencies.save(configuration(reserved), refreshed, reserved.revision);
      return { connection: stored, accessToken: refreshed.accessToken };
    } catch {
      // Never retry a possibly consumed refresh token. Even a persistence failure
      // leaves 'refreshing' durable if this best-effort uncertainty update fails.
      await dependencies.save(configuration(reserved), { ...bundle, refreshState: 'uncertain' }, reserved.revision).catch(() => {});
      throw new Error('No se confirmó la renovación de acceso. Autoriza de nuevo esta cuenta antes de continuar.');
    }
  }
  return {
    async authorizeAndSave(input: ConnectionInput, configInput: ProviderOAuthConfig, signal: AbortSignal,
      presentDevice?: (authorization: DeviceAuthorization) => void | Promise<void>, expectedRevision?: number): Promise<ExternalConnection> {
      const config = validateOAuthConfig(configInput);
      const destination = { ...input, provider: config.provider };
      assertProviderTarget(destination as Pick<ExternalConnection, 'provider' | 'endpoint' | 'kind'>, config.provider);
      if (input.provider && input.provider !== config.provider) throw new Error('La autorización corresponde a otro proveedor.');
      if (input.id) {
        const current = await dependencies.getConnection(input.id);
        if (!current || current.revision !== expectedRevision) throw new Error('La conexión cambió antes de iniciar la autorización.');
      } else if (expectedRevision !== undefined) throw new Error('La conexión nueva no tiene una revisión anterior.');
      signal.throwIfAborted();
      const bundle = await dependencies.oauth.authorize(config, signal, presentDevice);
      signal.throwIfAborted();
      // Only metadata leaves this method; secrets are durably stored in Keychain
      // before the connection's CAS metadata transaction commits.
      return dependencies.save(destination, bundle, expectedRevision);
    },
    async getValidProviderAccess(connectionId: string, signal?: AbortSignal): Promise<{ connection: ExternalConnection; accessToken: string }> {
      signal?.throwIfAborted();
      let operation = pending.get(connectionId);
      if (!operation) {
        operation = resolveAccess(connectionId);
        pending.set(connectionId, operation);
        void operation.finally(() => { if (pending.get(connectionId) === operation) pending.delete(connectionId); }).catch(() => {});
      }
      const access = await operation;
      signal?.throwIfAborted();
      // Coalesced callers also re-check after awaiting the shared resolution.
      // The adapter checks once more immediately before sending its request.
      await assertCurrent(access.connection);
      signal?.throwIfAborted();
      return access;
    },
  };
}

const providerStore = createProviderOAuthStore();
export const authorizeProviderAndSave = providerStore.authorizeAndSave;
export const getValidProviderAccess = providerStore.getValidProviderAccess;
