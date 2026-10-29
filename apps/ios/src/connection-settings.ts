import { isTauri } from '@tauri-apps/api/core';
import { openExternalURL, registeredURLSchemes, secretGet } from './device-bridge.ts';
import { listConnections, saveConnection, saveConnectionCredentials, removeConnection, validateCredentialBundle,
  type ConnectionInput, type ExternalConnection, type Provider } from './external-connections.ts';
import { authorizeProviderAndSave } from './provider-oauth-store.ts';
import { authorizeMCPAndSave } from './mcp-oauth-store.ts';
import { PROVIDER_API_ENDPOINTS, validateOAuthConfig, type ProviderOAuthConfig } from './provider-oauth.ts';

const names = { mcp: 'MCP remoto', github: 'GitHub', slack: 'Slack', gmail: 'Gmail', odoo: 'Odoo' };
type Service = keyof typeof names;
const errorText = (error: unknown) => error instanceof Error ? error.message : 'No se completó la configuración.';

/** Fixed, visible consent choices. Never take scopes or OAuth URLs from model output. */
export function settingsOAuthConfig(provider: 'github' | 'slack' | 'gmail', clientId: string, write: boolean, privateRepositories = false): ProviderOAuthConfig {
  let scopes: string[], redirectUri: string | undefined;
  if (provider === 'github') scopes = privateRepositories ? ['read:user', 'repo'] : ['read:user', ...(write ? ['public_repo'] : [])];
  else if (provider === 'slack') { scopes = ['channels:read', 'channels:history', 'users:read', ...(write ? ['chat:write'] : [])]; redirectUri = 'capri-auth://oauth/slack'; }
  else { scopes = ['https://www.googleapis.com/auth/gmail.readonly', ...(write ? ['https://www.googleapis.com/auth/gmail.send'] : [])]; redirectUri = clientId.split('.').reverse().join('.') + ':/oauth2redirect/google'; }
  return validateOAuthConfig({ provider, clientId, scopes, ...(redirectUri ? { redirectUri } : {}) });
}

/** One settings form; no credentials, consent codes or auth methods enter the model registry. */
export function mountConnectionSettings(): { refresh(): Promise<void>; cancel(): void } {
  const root = document.getElementById('connection-settings');
  if (!root) throw new Error('Falta la sección de conexiones.');
  root.innerHTML = `<h2>Conexiones</h2>
    <p class="hint">Conecta tus cuentas para trabajar con ellas desde la conversación. Capri pedirá revisar cada envío o cambio externo.</p>
    <div id="connections-list"></div>
    <details id="connection-editor"><summary>Añadir conexión</summary>
      <form id="provider-connection">
        <label>Servicio<select id="connection-provider"><option value="mcp">MCP remoto</option><option value="github">GitHub</option><option value="slack">Slack</option><option value="gmail">Gmail</option><option value="odoo">Odoo</option></select></label>
        <label>Nombre<input id="connection-label" maxlength="80" required placeholder="Mi servicio" /></label>
        <label id="connection-method-field">Acceso<select id="connection-method"><option value="token">Token de acceso</option><option value="oauth">Autorizar cuenta</option></select></label>
        <label id="connection-endpoint-field"><span id="connection-endpoint-label">Endpoint MCP</span><input id="connection-endpoint" type="url" maxlength="2048" placeholder="https://servicio.example/mcp" /></label>
        <label id="connection-secret-field"><span id="connection-secret-label">Token de acceso, si lo requiere</span><input id="connection-secret" type="password" autocomplete="off" maxlength="12000" /></label>
        <div id="connection-oauth-fields">
          <label>Client ID público<input id="connection-client-id" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="200" aria-describedby="connection-auth-hint" /></label>
          <label id="connection-permissions-field">Permisos<select id="connection-permissions"><option value="read">Sólo lectura</option><option value="write">Con escritura</option></select></label>
          <label id="connection-scopes-field">Permisos del servicio (opcional)<input id="connection-scopes" maxlength="4000" autocapitalize="none" spellcheck="false" placeholder="files:read" /><span class="hint">Separados por espacios. Si lo dejas vacío, el servicio indicará cuáles necesita al autorizar.</span></label>
          <label id="connection-private-field">Repositorios de GitHub<select id="connection-private"><option value="public">Sólo públicos</option><option value="private">Públicos y privados</option></select></label>
          <p id="connection-auth-hint" class="hint"></p>
          <p id="connection-callback-status" class="hint" role="status"></p>
        </div>
        <div id="connection-odoo-fields">
          <label>API de Odoo<select id="connection-odoo-mode"><option value="json2">JSON-2</option><option value="legacy">JSON-RPC</option></select></label>
          <p class="hint">JSON-2 requiere Odoo 19 o posterior. La API anterior JSON-RPC necesita base de datos y el ID numérico del usuario.</p>
          <label>Base de datos<input id="connection-database" maxlength="128" autocomplete="off" /></label>
          <label id="connection-uid-field">ID numérico del usuario<input id="connection-uid" type="number" min="1" step="1" inputmode="numeric" /></label>
        </div>
        <p id="connection-credential-hint" class="hint">Las credenciales se guardan en Keychain. No las escribas en la conversación.</p>
        <div class="actions"><button id="connection-save" class="primary" type="submit">Guardar conexión</button><button id="connection-edit-cancel" type="button" hidden>Descartar edición</button></div>
      </form>
      <div id="connection-device" class="review-card" hidden><h3>Autoriza Capri en GitHub</h3><p>Código: <strong id="connection-device-code"></strong></p><p id="connection-device-expiry" class="hint"></p><button id="connection-device-open" type="button">Abrir GitHub para autorizar</button></div>
      <button id="connection-auth-cancel" type="button" hidden>Cancelar autorización</button>
    </details><p id="connections-status" class="hint" role="status" aria-live="polite"></p>`;
  const element = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  const input = (id: string) => element<HTMLInputElement>('connection-' + id);
  const select = (id: string) => element<HTMLSelectElement>('connection-' + id);
  const form = element<HTMLFormElement>('provider-connection'), editor = element<HTMLDetailsElement>('connection-editor');
  const status = element('connections-status');
  let editing: ExternalConnection | undefined, active: AbortController | undefined, busy = false, sequence = 0, renderSequence = 0;
  let deviceURL: string | undefined;
  const service = () => select('provider').value as Service;
  const oauth = () => service() === 'slack' || service() === 'gmail' || (service() === 'github' || service() === 'mcp') && select('method').value === 'oauth';
  function section(id: string, visible: boolean) {
    const field = element('connection-' + id); field.hidden = !visible;
    field.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select').forEach(control => { control.disabled = !visible || busy; });
  }
  function updateFields() {
    const provider = service(), auth = oauth();
    section('method-field', provider === 'github' || provider === 'mcp'); section('endpoint-field', provider === 'mcp' || provider === 'odoo');
    section('secret-field', !auth); section('oauth-fields', auth); section('private-field', auth && provider === 'github');
    section('permissions-field', auth && provider !== 'mcp'); section('scopes-field', auth && provider === 'mcp');
    section('odoo-fields', provider === 'odoo'); section('uid-field', provider === 'odoo' && select('odoo-mode').value === 'legacy');
    const privateGrant = provider === 'github' && auth && select('private').value === 'private';
    select('permissions').options[0]!.disabled = privateGrant;
    if (privateGrant) select('permissions').value = 'write';
    select('provider').disabled = busy || !!editing;
    input('label').disabled = busy;
    input('endpoint').required = provider === 'mcp' || provider === 'odoo';
    input('secret').required = !auth && provider !== 'mcp' && !editing;
    input('client-id').required = auth;
    input('database').required = provider === 'odoo' && select('odoo-mode').value === 'legacy';
    input('uid').required = provider === 'odoo' && select('odoo-mode').value === 'legacy';
    element('connection-endpoint-label').textContent = provider === 'odoo' ? 'Servidor Odoo' : 'Endpoint MCP';
    input('endpoint').placeholder = provider === 'odoo' ? 'https://mi-empresa.odoo.com' : 'https://servicio.example/mcp';
    element('connection-secret-label').textContent = provider === 'mcp' ? 'Token de acceso, si lo requiere' : provider === 'odoo' ? 'API key de Odoo' : 'Token personal de GitHub';
    element('connection-credential-hint').textContent = editing && !auth
      ? 'Deja la credencial vacía para conservarla. Al cambiar el servidor, introduce una credencial nueva para ese destino.'
      : 'Las credenciales se guardan en Keychain. Guardarlas no comprueba el acceso ni autoriza envíos o cambios.';
    element('connection-auth-hint').textContent = provider === 'mcp' ? 'Registra Capri como cliente público nativo del servicio con retorno dev.gentledot.capri.auth:/oauth/mcp. Debe admitir PKCE S256 y este retorno nativo. Usa el client ID público, sin client secret. Capri descubrirá su servidor de autorización.'
      : provider === 'slack' ? 'Usa una app Slack con PKCE público y callback capri-auth://oauth/slack. Se consultan canales públicos; enviar mensajes requiere el permiso opcional.'
      : provider === 'gmail' ? 'Usa un client ID de tipo iOS del bundle de Capri. Esta IPA debe incluir su esquema de retorno; se comprueba antes de abrir Google.'
      : 'Usa el client ID público de una app GitHub con device flow habilitado. El código se autoriza en github.com. GitHub concede lectura y escritura para repositorios privados; cada cambio seguirá requiriendo tu revisión. No hace falta client secret.';
    element<HTMLButtonElement>('connection-save').disabled = busy;
    element('connection-save').textContent = auth ? 'Autorizar y guardar' : editing ? 'Guardar cambios' : 'Guardar conexión';
    element<HTMLButtonElement>('connection-edit-cancel').disabled = busy;
    element('connection-edit-cancel').hidden = !editing;
    if (!auth) element('connection-callback-status').textContent = '';
  }
  function resetForm() {
    editing = undefined; form.reset(); input('secret').value = ''; deviceURL = undefined;
    element('connection-device').hidden = true; element('connection-device-code').textContent = '';
    element('connection-callback-status').textContent = ''; editor.querySelector('summary')!.textContent = 'Añadir conexión'; updateFields();
  }
  async function checkCallback(config: ProviderOAuthConfig) {
    if (!config.redirectUri) return;
    const required = new URL(config.redirectUri).protocol.slice(0, -1).toLowerCase();
    const registered = await registeredURLSchemes();
    if (!registered.some(scheme => scheme.toLowerCase() === required)) throw new Error(config.provider === 'gmail'
      ? 'Esta IPA no incluye el callback de ese client ID. Genera una IPA con CAPRI_GOOGLE_CLIENT_ID configurado e instálala antes de autorizar Gmail.'
      : 'Esta IPA no registra capri-auth. Instala una compilación de Capri con el callback de Slack.');
    element('connection-callback-status').textContent = 'El callback está registrado en esta instalación.';
  }
  async function edit(connection: ExternalConnection) {
    if (busy) return;
    const epoch = ++sequence; resetForm(); editing = connection;
    select('provider').value = connection.provider ?? 'mcp'; input('label').value = connection.label; input('endpoint').value = connection.endpoint;
    select('odoo-mode').value = connection.apiMode ?? 'json2'; input('database').value = connection.database ?? ''; input('uid').value = connection.uid?.toString() ?? '';
    editor.open = true; editor.querySelector('summary')!.textContent = 'Editar ' + connection.label;
    updateFields(); input('label').focus();
    if (connection.credentialAccount && connection.provider !== 'odoo') {
      try {
        const raw = await secretGet('external-connections', connection.credentialAccount);
        if (epoch !== sequence || editing?.id !== connection.id) return;
        if (raw) {
          const credential = validateCredentialBundle(JSON.parse(raw));
          if (credential.clientId) {
            input('client-id').value = credential.clientId;
            select('method').value = 'oauth';
            input('scopes').value = credential.mcpOAuth ? (credential.scopes ?? []).join(' ') : '';
            select('permissions').value = credential.scopes?.some(scope => ['repo', 'public_repo', 'chat:write', 'https://www.googleapis.com/auth/gmail.send'].includes(scope)) ? 'write' : 'read';
            select('private').value = credential.scopes?.includes('repo') ? 'private' : 'public'; updateFields();
          }
        }
      } catch { if (epoch === sequence) status.textContent = 'No se recuperó la configuración anterior. Puedes introducir el acceso de nuevo.'; }
    }
  }
  async function refresh() {
    const epoch = ++renderSequence;
    try {
      const connections = await listConnections();
      if (epoch !== renderSequence) return;
      const list = element('connections-list'); list.replaceChildren();
      if (!connections.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'Todavía no hay servicios configurados.'; list.append(empty); }
      for (const connection of connections) {
        const item = document.createElement('article'); item.className = 'work-item';
        const title = document.createElement('strong'); title.textContent = connection.label;
        const detail = document.createElement('p'); detail.className = 'hint'; detail.textContent = `${names[connection.provider ?? 'mcp']} · ${connection.enabled ? 'Habilitada · conexión sin comprobar' : 'Desactivada'}\n${connection.endpoint}\n${connection.credentialAccount ? 'Credencial guardada en Keychain; acceso pendiente de comprobar al usarla.' : 'Sin credencial guardada.'}`;
        const actions = document.createElement('div'); actions.className = 'actions';
        const editButton = document.createElement('button'); editButton.type = 'button'; editButton.textContent = 'Editar acceso'; editButton.disabled = busy; editButton.onclick = () => { void edit(connection); };
        const toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = connection.enabled ? 'Desactivar' : 'Activar'; toggle.disabled = busy;
        toggle.onclick = async () => { if (busy) return; toggle.disabled = true; try { await saveConnection({ ...connection, enabled: !connection.enabled }, undefined, connection.revision); await refresh(); } catch (error) { status.textContent = errorText(error); toggle.disabled = false; } };
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Quitar conexión'; remove.disabled = busy;
        remove.onclick = () => {
          if (busy) return; const confirmation = document.createElement('div'); confirmation.className = 'review-card';
          const message = document.createElement('p'); message.textContent = `Quitar ${connection.label} de Capri y eliminar su credencial local. Esto no revoca el acceso en el proveedor.`;
          const yes = document.createElement('button'); yes.type = 'button'; yes.textContent = 'Confirmar eliminación';
          const no = document.createElement('button'); no.type = 'button'; no.textContent = 'Conservar';
          yes.onclick = async () => { if (busy) return; yes.disabled = true; try { await removeConnection(connection.id, connection.revision); if (editing?.id === connection.id) resetForm(); await refresh(); status.textContent = 'Conexión retirada de este iPhone.'; } catch (error) { status.textContent = errorText(error); yes.disabled = false; } };
          no.onclick = () => { confirmation.remove(); remove.hidden = false; }; confirmation.append(message, yes, no); item.append(confirmation); remove.hidden = true; yes.focus();
        };
        actions.append(editButton, toggle, remove); item.append(title, detail, actions); list.append(item);
      }
    } catch (error) { if (epoch === renderSequence) status.textContent = errorText(error); }
  }
  function cancel() { sequence++; active?.abort(); input('secret').value = ''; deviceURL = undefined; element('connection-device').hidden = true; element('connection-device-code').textContent = ''; }
  select('provider').addEventListener('change', () => { sequence++; input('secret').value = ''; input('client-id').value = ''; input('endpoint').value = ''; input('scopes').value = ''; select('method').value = 'token'; select('permissions').value = 'read'; element('connection-callback-status').textContent = ''; updateFields(); });
  select('method').addEventListener('change', () => { input('secret').value = ''; updateFields(); });
  select('private').addEventListener('change', () => { select('permissions').value = select('private').value === 'private' ? 'write' : 'read'; updateFields(); });
  select('odoo-mode').addEventListener('change', updateFields);
  element('connection-edit-cancel').addEventListener('click', () => { sequence++; resetForm(); });
  element('connection-auth-cancel').addEventListener('click', cancel);
  element('connection-device-open').addEventListener('click', async () => { if (!deviceURL || !active || active.signal.aborted) return; try { await openExternalURL(deviceURL); } catch (error) { status.textContent = errorText(error); } });
  input('client-id').addEventListener('input', () => { element('connection-callback-status').textContent = ''; });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    sequence++;
    let controller: AbortController | undefined;
    try {
      if (!isTauri()) throw new Error('Configura las cuentas en Capri instalada en el iPhone para proteger el acceso en Keychain.');
      const provider = service(), auth = oauth();
      const destination: ConnectionInput = { ...(editing ? { id: editing.id, enabled: editing.enabled } : {}), kind: provider === 'mcp' ? 'mcp' : 'https-api',
        label: input('label').value.trim(), endpoint: provider === 'mcp' || provider === 'odoo' ? input('endpoint').value.trim() : PROVIDER_API_ENDPOINTS[provider],
        ...(provider !== 'mcp' ? { provider: provider as Provider } : {}), ...(provider === 'odoo' ? { apiMode: select('odoo-mode').value as 'json2' | 'legacy',
          ...(input('database').value.trim() ? { database: input('database').value.trim() } : {}), ...(select('odoo-mode').value === 'legacy' ? { uid: Number(input('uid').value) } : {}) } : {}) };
      const revision = editing?.revision, token = input('secret').value;
      const config = auth && provider !== 'mcp' ? settingsOAuthConfig(provider as 'github' | 'slack' | 'gmail', input('client-id').value.trim(), select('permissions').value === 'write', select('private').value === 'private') : undefined;
      const mcpConfig = auth && provider === 'mcp' ? { endpoint: destination.endpoint, clientId: input('client-id').value.trim(),
        ...(input('scopes').value.trim() ? { scopes: input('scopes').value.trim().split(/\s+/) } : {}) } : undefined;
      busy = true; controller = new AbortController(); active = controller; updateFields(); await refresh();
      input('secret').value = ''; status.textContent = auth ? 'Esperando autorización de la cuenta…' : 'Guardando acceso en este iPhone…';
      element('connection-auth-cancel').hidden = !auth;
      if (mcpConfig) await authorizeMCPAndSave(destination, mcpConfig, controller.signal, revision);
      else if (config) {
        await checkCallback(config); controller.signal.throwIfAborted();
        await authorizeProviderAndSave(destination, config, controller.signal, info => {
          controller!.signal.throwIfAborted(); deviceURL = info.verificationUri;
          element('connection-device-code').textContent = info.userCode;
          element('connection-device-expiry').textContent = 'Vence a las ' + new Date(info.expiresAt).toLocaleTimeString() + '. Mantén abierta esta autorización al regresar a Capri.';
          element('connection-device').hidden = false;
        }, revision);
      } else if (token && provider !== 'mcp') await saveConnectionCredentials(destination, { provider, accessToken: token }, revision);
      else await saveConnection(destination, token || (editing ? undefined : ''), revision);
      status.textContent = auth ? 'Autorización guardada. Ya puedes pedirle a Capri que consulte esta cuenta.' : 'Configuración guardada. Se comprobará el acceso cuando Capri use la conexión.';
      resetForm(); editor.open = false;
    } catch (error) { status.textContent = controller?.signal.aborted ? 'Autorización cancelada. No se iniciarán más solicitudes.' : errorText(error); }
    finally { active = undefined; busy = false; deviceURL = undefined; element('connection-device').hidden = true; element('connection-device-code').textContent = ''; element('connection-auth-cancel').hidden = true; updateFields(); await refresh(); }
  });
  updateFields();
  return { refresh, cancel };
}
