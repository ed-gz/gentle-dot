import { availabilityMessage, type Availability } from './local-intelligence.ts';
import type { LinkedStatus } from './linked-chat.ts';

export type HealthAction = 'check-local' | 'show-apple-setup' | 'show-pairing' | 'retry-host' | 'repair-installation' | 'use-iphone' | 'use-gentle' | 'show-host-help';
export type HealthState = 'ready' | 'checking' | 'offline' | 'attention';
export type HealthItem = { state: HealthState; title: string; detail: string; action?: HealthAction };
export type ConnectionHealthInput = {
  local: Availability;
  linkedStatus: LinkedStatus;
  agentState?: string;
  hostConfigured: boolean;
  credentialState?: 'restoring' | 'saved' | 'memory' | 'missing' | 'unavailable';
  capabilities?: { workSync: boolean; meetingDrafts: boolean };
  preference?: 'auto' | 'iphone' | 'gentle';
};
export type ConnectionHealth = {
  canConverse: boolean;
  selectedEngine: 'iphone' | 'gentle';
  summary: string;
  primaryAction?: HealthAction;
  local: HealthItem;
  host: HealthItem;
  work: HealthItem;
};

function localHealth(value: Availability): HealthItem {
  if (value.available && value.supportsSpanish && value.status === 'available')
    return { state: 'ready', title: 'IA en este iPhone', detail: 'Lista para conversar sin internet ni laptop.' };
  const title = 'IA en este iPhone';
  const detail = availabilityMessage(value);
  if (value.status === 'checking') return { state: 'checking', title, detail };
  const action: HealthAction = ['apple_intelligence_disabled', 'model_not_ready', 'unsupported_language', 'model_unavailable'].includes(value.status)
    ? 'show-apple-setup' : ['sdk_unavailable', 'invalid_response', 'browser_preview', 'unsupported_platform'].includes(value.status)
      ? 'repair-installation' : value.status === 'device_not_eligible' || value.status === 'os_unsupported'
        ? 'show-pairing' : 'check-local';
  return { state: 'attention', title, detail, action };
}

function hostHealth(input: ConnectionHealthInput): HealthItem {
  const title = 'Gentle Dot en tu laptop';
  if (input.linkedStatus === 'ready') {
    if (input.agentState === 'starting' || input.agentState === 'restarting')
      return { state: 'checking', title, detail: 'Laptop conectada. Su asistente está iniciando.' };
    if (input.agentState === 'error')
      return { state: 'attention', title, detail: 'Laptop conectada. Revisa el asistente en Gentle Dot antes de continuar.', action: 'show-host-help' };
    return { state: 'ready', title, detail: input.agentState === 'needs_you' ? 'Conectado. Hay una revisión esperando tu respuesta.'
      : input.agentState === 'thinking' || input.agentState === 'working' ? 'Conectado y trabajando. Puedes añadir una instrucción.' : 'Conectado. Puedes continuar tu conversación y tus sesiones de Pi.' };
  }
  if (input.linkedStatus === 'rejected')
    return { state: 'attention', title, detail: 'La laptop rechazó el acceso. Genera otra invitación desde Gentle Dot y vuelve a vincular.', action: 'show-pairing' };
  if (input.linkedStatus === 'connecting')
    return { state: 'checking', title, detail: 'Conectando con tu laptop…' };
  if (input.credentialState === 'restoring')
    return { state: 'checking', title, detail: 'Recuperando el acceso guardado en este iPhone…' };
  if (input.credentialState === 'unavailable')
    return { state: 'attention', title, detail: 'No se pudo recuperar el acceso seguro. Desbloquea el iPhone y vuelve a intentar.', action: 'retry-host' };
  if (!input.hostConfigured || input.credentialState === 'missing')
    return { state: 'offline', title, detail: 'Vincula tu laptop para continuar sesiones de Pi. La IA del iPhone funciona por separado.', action: 'show-pairing' };
  return { state: 'offline', title, detail: 'Laptop sin conexión. Abre Gentle Dot y comprueba la conexión privada; tus datos locales siguen aquí.', action: 'retry-host' };
}

/** Pure presentation state. Never probes, stores, exposes or infers credentials. */
export function connectionHealth(input: ConnectionHealthInput): ConnectionHealth {
  const local = localHealth(input.local), host = hostHealth(input);
  const preference = input.preference ?? 'auto';
  const selectedEngine = preference === 'auto' ? local.state === 'ready' ? 'iphone' : host.state === 'ready' ? 'gentle' : 'iphone' : preference;
  const chosen = selectedEngine === 'iphone' ? local : host;
  const canConverse = chosen.state === 'ready';
  let primaryAction = canConverse ? undefined : chosen.action;
  if (!canConverse && selectedEngine === 'iphone' && host.state === 'ready') primaryAction = 'use-gentle';
  else if (!canConverse && selectedEngine === 'gentle' && local.state === 'ready') primaryAction = 'use-iphone';
  else if (!canConverse && preference === 'auto' && input.hostConfigured && host.state !== 'checking' && input.local.status !== 'checking'
    && ['device_not_eligible', 'os_unsupported', 'browser_preview', 'unsupported_platform'].includes(input.local.status)) primaryAction = host.action;
  const work: HealthItem = input.linkedStatus !== 'ready'
    ? { state: 'offline', title: 'Trabajos y reuniones', detail: 'Se conservan en este iPhone hasta que conectes la laptop.' }
    : !input.capabilities?.workSync
      ? { state: 'attention', title: 'Trabajos y reuniones', detail: 'Actualiza Gentle Dot en la laptop para transferir trabajos. El chat y las sesiones siguen disponibles.', action: 'show-host-help' }
      : !input.capabilities.meetingDrafts
        ? { state: 'attention', title: 'Trabajos y reuniones', detail: 'Puedes transferir trabajos. Este host todavía no ofrece minutas.', action: 'show-host-help' }
        : { state: 'ready', title: 'Trabajos y reuniones', detail: 'Puedes transferir trabajos y solicitar minutas. Cada envío requiere tu revisión.' };
  return { canConverse, selectedEngine, summary: canConverse ? selectedEngine === 'iphone' ? 'Lista para conversar en este iPhone.' : 'Lista para conversar con tu laptop.'
    : chosen.state === 'checking' ? chosen.detail : selectedEngine === 'iphone' ? local.detail : host.detail,
    ...(primaryAction ? { primaryAction } : {}), local, host, work };
}

export function healthActionLabel(action: HealthAction): string {
  return { 'check-local': 'Comprobar otra vez', 'show-apple-setup': 'Preparar la IA del iPhone', 'show-pairing': 'Vincular laptop',
    'retry-host': 'Reconectar laptop', 'repair-installation': 'Revisar instalación', 'use-iphone': 'Usar este iPhone',
    'use-gentle': 'Usar la laptop', 'show-host-help': 'Revisar Gentle Dot' }[action];
}
