import { secretGet } from './device-bridge.ts';
import { getConnection, saveConnectionCredentials, validateCredentialBundle, validEndpoint,
  type ConnectionInput, type ExternalConnection, type ProviderCredentialBundle } from './external-connections.ts';
import { createMCPOAuth, type MCPOAuthConfig } from './mcp-oauth.ts';

const defaults = { getConnection, save: saveConnectionCredentials,
  readSecret: (account: string) => secretGet('external-connections', account), oauth: createMCPOAuth(), now: Date.now };
function target(connection: Pick<ExternalConnection, 'kind' | 'provider' | 'endpoint'>, bundle?: ProviderCredentialBundle) {
  if (connection.kind !== 'mcp' || connection.provider || bundle?.provider
    || bundle?.mcpOAuth && bundle.mcpOAuth.resource !== validEndpoint(connection.endpoint)) throw new Error('El acceso no corresponde a este servidor MCP.');
}
function configuration(connection: ExternalConnection): ConnectionInput {
  return { id: connection.id, kind: 'mcp', label: connection.label, endpoint: connection.endpoint, enabled: connection.enabled };
}

/** Rotation reserves a revision before consuming a refresh token; no retry after uncertainty. */
export function createMCPOAuthStore(overrides: Partial<typeof defaults> = {}) {
  const dependencies = { ...defaults, ...overrides };
  const pending = new Map<string, Promise<ExternalConnection>>();
  async function current(expected: ExternalConnection) {
    const found = await dependencies.getConnection(expected.id);
    if (!found || !found.enabled || found.revision !== expected.revision || found.credentialAccount !== expected.credentialAccount
      || found.kind !== expected.kind || found.provider !== expected.provider || found.endpoint !== expected.endpoint) throw new Error('La conexión cambió mientras se recuperaba su acceso.');
  }
  async function resolve(id: string): Promise<ExternalConnection> {
    const connection = await dependencies.getConnection(id);
    if (!connection || !connection.enabled) throw new Error('La conexión MCP no está activa.');
    target(connection);
    if (!connection.credentialAccount) return connection;
    const raw = await dependencies.readSecret(connection.credentialAccount);
    if (!raw || raw.length > 16384) throw new Error('No se recuperó el acceso MCP desde Keychain.');
    let bundle: ProviderCredentialBundle;
    try { bundle = validateCredentialBundle(JSON.parse(raw)); } catch { throw new Error('La credencial MCP guardada no es válida.'); }
    await current(connection); target(connection, bundle);
    if (bundle.refreshState && bundle.refreshState !== 'ready') throw new Error('La renovación MCP quedó sin confirmar. Autoriza la cuenta de nuevo.');
    if (bundle.expiresAt === undefined || bundle.expiresAt > dependencies.now() + 60000) return connection;
    if (!bundle.mcpOAuth || !bundle.refreshToken) throw new Error('El acceso MCP venció. Autoriza la cuenta de nuevo.');
    const reserved = await dependencies.save(configuration(connection), { ...bundle, refreshState: 'refreshing' }, connection.revision);
    try {
      await current(reserved);
      const refreshed = await dependencies.oauth.refresh(bundle);
      return await dependencies.save(configuration(reserved), refreshed, reserved.revision);
    } catch {
      await dependencies.save(configuration(reserved), { ...bundle, refreshState: 'uncertain' }, reserved.revision).catch(() => {});
      throw new Error('No se confirmó la renovación MCP. Autoriza la cuenta de nuevo; no se repetirá el refresh.');
    }
  }
  return {
    async authorizeAndSave(input: ConnectionInput, config: MCPOAuthConfig, signal: AbortSignal, expectedRevision?: number): Promise<ExternalConnection> {
      target(input);
      if (input.endpoint !== config.endpoint) throw new Error('La autorización corresponde a otro destino.');
      if (input.id) {
        const found = await dependencies.getConnection(input.id);
        if (!found || found.revision !== expectedRevision) throw new Error('La conexión cambió antes de autorizar.');
      } else if (expectedRevision !== undefined) throw new Error('La conexión nueva no tiene una revisión previa.');
      signal.throwIfAborted();
      const bundle = await dependencies.oauth.authorize(config, signal);
      signal.throwIfAborted(); target(input, bundle);
      return dependencies.save(input, bundle, expectedRevision);
    },
    async prepare(id: string): Promise<ExternalConnection> {
      let operation = pending.get(id);
      if (!operation) {
        operation = resolve(id); pending.set(id, operation);
        void operation.finally(() => { if (pending.get(id) === operation) pending.delete(id); }).catch(() => {});
      }
      const connection = await operation;
      await current(connection);
      return connection;
    },
  };
}
const store = createMCPOAuthStore();
export const authorizeMCPAndSave = store.authorizeAndSave;
export const prepareMCPAccess = store.prepare;
