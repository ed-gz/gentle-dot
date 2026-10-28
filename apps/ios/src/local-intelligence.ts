import { invoke as tauriInvoke, isTauri } from '@tauri-apps/api/core';

export type Availability = { available: boolean; status: string; supportsSpanish: boolean };
export type LocalReply = { ok: boolean; text?: string; error?: string; message?: string };
export type AgentDecision = { kind: 'answer' | 'tool'; text: string; toolName: string; argumentsJSON: string };
export type AgentReply = { ok: boolean; decision?: AgentDecision; error?: string; message?: string };
function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error('La IA de Apple requiere la app instalada en el iPhone.'));
  return tauriInvoke<T>(`plugin:local-intelligence|${command}`, args);
}
export function parseAvailability(value: unknown): Availability | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const item = value as Partial<Availability>;
  if (typeof item.available !== 'boolean' || typeof item.supportsSpanish !== 'boolean' ||
      typeof item.status !== 'string' || !/^[a-z_]{1,64}$/.test(item.status)) return;
  // A native error or a malformed response must never enable the composer.
  if (item.available !== (item.status === 'available' && item.supportsSpanish)) return;
  return { available: item.available, status: item.status, supportsSpanish: item.supportsSpanish };
}
type AvailabilityProbe = { native?: boolean; call?: () => Promise<unknown>; timeoutMs?: number };
export async function checkLocalIntelligence(probe: AvailabilityProbe = {}): Promise<Availability> {
  const unavailable = (status: string): Availability => ({ available: false, status, supportsSpanish: false });
  if (!(probe.native ?? isTauri())) return unavailable('browser_preview');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutMs = probe.timeoutMs ?? 8000;
    const value = await Promise.race([
      Promise.resolve().then(probe.call ?? (() => invoke<unknown>('check_availability'))),
      new Promise<Availability>(resolve => { timer = setTimeout(() => resolve(unavailable('bridge_timeout')), timeoutMs); }),
    ]);
    return parseAvailability(value) ?? unavailable('invalid_response');
  } catch { return unavailable('bridge_unavailable'); }
  finally { clearTimeout(timer); }
}
export const askLocal = (prompt: string) => invoke<LocalReply>('respond', { prompt });
/** Validation only: the on-device model selects the step, and the registry authorizes execution. */
export function validateAgentDecision(value: unknown): value is AgentDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<AgentDecision>;
  if ((item.kind !== 'answer' && item.kind !== 'tool') || typeof item.text !== 'string' || Array.from(item.text).length > 2400 ||
      typeof item.toolName !== 'string' || item.toolName.length > 80 || typeof item.argumentsJSON !== 'string' || Array.from(item.argumentsJSON).length > 4000) return false;
  let args: unknown;
  try { args = JSON.parse(item.argumentsJSON); } catch { return false; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (item.kind === 'answer') return item.text.trim().length > 0 && item.toolName === '' && Object.keys(args).length === 0;
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(item.toolName);
}
export async function agentStep(prompt: string, turnId?: string): Promise<AgentReply> {
  if (!prompt.trim() || Array.from(prompt).length > 8000) return { ok: false, error: 'invalid_prompt', message: 'El contexto del paso debe contener entre 1 y 8000 caracteres.' };
  let reply: AgentReply;
  try { reply = await invoke<AgentReply>('agent_step', { prompt, ...(turnId ? { turnId } : {}) }); }
  catch { return { ok: false, error: 'bridge_unavailable', message: 'El motor agéntico requiere una versión de Capri con el puente nativo instalado.' }; }
  if (!reply || typeof reply.ok !== 'boolean') return { ok: false, error: 'invalid_decision', message: 'El motor local devolvió una respuesta inválida.' };
  if (reply.ok && !validateAgentDecision(reply.decision)) return { ok: false, error: 'invalid_decision', message: 'El modelo no produjo un paso válido. Puedes volver a intentar.' };
  return reply;
}
export const cancelLocal = (turnId?: string) => invoke<{ ok: boolean }>('cancel', turnId ? { turnId } : undefined);
export const resetLocal = () => invoke<{ ok: boolean }>('reset');
export function availabilityMessage(value: Availability): string {
  if (value.available && value.supportsSpanish) return 'Lista · conversación sin internet';
  const messages: Record<string, string> = {
    checking: 'Comprobando la IA de este iPhone…',
    browser_preview: 'Disponible en la app instalada; esta vista no ejecuta el modelo de Apple.',
    bridge_unavailable: 'Capri no pudo comunicarse con la IA del iPhone. Comprueba otra vez; si persiste, actualiza o reinstala Capri.',
    bridge_timeout: 'La IA del iPhone no respondió a tiempo. Abre Capri en primer plano y comprueba otra vez.',
    invalid_response: 'La instalación devolvió un estado de IA no válido. Actualiza Capri y comprueba otra vez.',
    apple_intelligence_disabled: 'Activa Apple Intelligence en Ajustes del iPhone.',
    model_not_ready: 'Apple todavía está preparando el modelo. Revisa su descarga en Ajustes.',
    device_not_eligible: 'Apple no habilita este modelo en el dispositivo.',
    os_unsupported: 'El motor local necesita iOS 26 o posterior.',
    sdk_unavailable: 'Esta compilación no incluye el SDK de Foundation Models.',
    unsupported_language: 'El modelo instalado no admite español.',
    unsupported_platform: 'El motor de Apple funciona en el iPhone.',
    model_unavailable: 'Apple Intelligence no está disponible ahora. Revisa sus ajustes y comprueba otra vez.',
  };
  return messages[value.status] ?? 'El modelo de Apple no está disponible ahora.';
}
