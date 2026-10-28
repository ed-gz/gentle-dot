import { invoke as tauriInvoke, isTauri } from '@tauri-apps/api/core';

export type Availability = { available: boolean; status: string; supportsSpanish: boolean };
export type LocalReply = { ok: boolean; text?: string; error?: string; message?: string };
export type AgentDecision = { kind: 'answer' | 'tool'; text: string; toolName: string; argumentsJSON: string };
export type AgentReply = { ok: boolean; decision?: AgentDecision; error?: string; message?: string };
function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error('La IA de Apple requiere la app instalada en el iPhone.'));
  return tauriInvoke<T>(`plugin:local-intelligence|${command}`, args);
}
export async function checkLocalIntelligence(): Promise<Availability> {
  try { return await invoke<Availability>('check_availability'); }
  catch { return { available: false, status: 'bridge_unavailable', supportsSpanish: false }; }
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
export async function agentStep(prompt: string): Promise<AgentReply> {
  if (!prompt.trim() || Array.from(prompt).length > 8000) return { ok: false, error: 'invalid_prompt', message: 'El contexto del paso debe contener entre 1 y 8000 caracteres.' };
  let reply: AgentReply;
  try { reply = await invoke<AgentReply>('agent_step', { prompt }); }
  catch { return { ok: false, error: 'bridge_unavailable', message: 'El motor agéntico requiere una versión de Capri con el puente nativo instalado.' }; }
  if (!reply || typeof reply.ok !== 'boolean') return { ok: false, error: 'invalid_decision', message: 'El motor local devolvió una respuesta inválida.' };
  if (reply.ok && !validateAgentDecision(reply.decision)) return { ok: false, error: 'invalid_decision', message: 'El modelo no produjo un paso válido. Puedes volver a intentar.' };
  return reply;
}
export const cancelLocal = () => invoke<{ ok: boolean }>('cancel');
export const resetLocal = () => invoke<{ ok: boolean }>('reset');
export function availabilityMessage(value: Availability): string {
  if (value.available && value.supportsSpanish) return 'Lista · conversación sin internet';
  const messages: Record<string, string> = {
    bridge_unavailable: 'Disponible en la app instalada; esta vista no ejecuta el modelo de Apple.',
    apple_intelligence_disabled: 'Activa Apple Intelligence en Ajustes del iPhone.',
    model_not_ready: 'Apple todavía está preparando el modelo. Revisa su descarga en Ajustes.',
    device_not_eligible: 'Apple no habilita este modelo en el dispositivo.',
    os_unsupported: 'El motor local necesita iOS 26 o posterior.',
    sdk_unavailable: 'Esta compilación no incluye el SDK de Foundation Models.',
    unsupported_language: 'El modelo instalado no admite español.',
    unsupported_platform: 'El motor de Apple funciona en el iPhone.',
  };
  return messages[value.status] ?? 'El modelo de Apple no está disponible ahora.';
}
