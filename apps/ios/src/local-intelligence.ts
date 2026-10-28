import { invoke as tauriInvoke, isTauri } from '@tauri-apps/api/core';

export type Availability = { available: boolean; status: string; supportsSpanish: boolean };
export type LocalReply = { ok: boolean; text?: string; error?: string; message?: string };
function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error('La IA de Apple requiere la app instalada en el iPhone.'));
  return tauriInvoke<T>(`plugin:local-intelligence|${command}`, args);
}
export async function checkLocalIntelligence(): Promise<Availability> {
  try { return await invoke<Availability>('check_availability'); }
  catch { return { available: false, status: 'bridge_unavailable', supportsSpanish: false }; }
}
export const askLocal = (prompt: string) => invoke<LocalReply>('respond', { prompt });
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
