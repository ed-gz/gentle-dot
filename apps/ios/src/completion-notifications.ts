import { invoke, isTauri } from '@tauri-apps/api/core';
import { withInferenceDeadline } from './inference-recovery.ts';

export type CompletionNotificationStatus = { enabled: boolean; authorization: 'authorized' | 'provisional' | 'ephemeral' | 'denied' | 'not_determined' | 'unavailable' };
export function parseCompletionNotificationStatus(value: unknown): CompletionNotificationStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('El iPhone no confirmó la configuración de avisos.');
  const item = value as Record<string, unknown>;
  if (item.ok !== true || typeof item.enabled !== 'boolean' || typeof item.authorization !== 'string'
      || !['authorized', 'provisional', 'ephemeral', 'denied', 'not_determined', 'unavailable'].includes(item.authorization)
      || (item.enabled && !['authorized', 'provisional', 'ephemeral'].includes(item.authorization))) throw new Error('El iPhone no confirmó la configuración de avisos.');
  return { enabled: item.enabled, authorization: item.authorization as CompletionNotificationStatus['authorization'] };
}

/** Permission is requested exclusively by a direct change to the checkbox. */
export function mountCompletionNotifications(root: HTMLElement, dependencies: {
  native?: boolean; status?: () => Promise<unknown>; configure?: (enabled: boolean) => Promise<unknown>;
} = {}) {
  const toggle = root.querySelector<HTMLInputElement>('input')!;
  const message = root.querySelector<HTMLElement>('[role="status"]')!;
  const native = dependencies.native ?? isTauri();
  const status = dependencies.status ?? (() => invoke('plugin:local-intelligence|notification_status'));
  const configure = dependencies.configure ?? ((enabled: boolean) => invoke('plugin:local-intelligence|notification_configure', { enabled }));
  let revision = 0, userRevision = 0, configuring = false, refreshAfterConfiguration = false;
  function show(value: CompletionNotificationStatus) {
    toggle.checked = value.enabled;
    message.textContent = value.enabled ? 'Si iOS permite completar la respuesta al salir, te avisaré sin mostrar su contenido.'
      : value.authorization === 'denied' ? 'Los avisos están desactivados en Ajustes del iPhone.'
      : 'Desactivados. Puedes activarlos cuando quieras.';
  }
  async function refresh() {
    if (!native) { toggle.disabled = true; message.textContent = 'Los avisos se configuran en la app instalada en el iPhone.'; return; }
    // The system consent sheet can trigger a foreground event before its result
    // returns; never replace that user decision with a stale status read.
    if (configuring) { refreshAfterConfiguration = true; return; }
    const current = ++revision; toggle.disabled = true;
    try { const value = parseCompletionNotificationStatus(await withInferenceDeadline(status())); if (current === revision) show(value); }
    catch { if (current === revision) message.textContent = 'No pude comprobar los avisos. Vuelve a abrir Ajustes para reintentar.'; }
    finally { if (current === revision) toggle.disabled = false; }
  }
  toggle.addEventListener('change', async () => {
    const previous = !toggle.checked, enabled = toggle.checked, current = ++revision, userChoice = ++userRevision;
    configuring = true; toggle.disabled = true;
    let timedOut = false;
    const operation = Promise.resolve().then(() => configure(enabled));
    // A system consent sheet may outlive the bridge deadline. Re-read the
    // actual setting when it eventually returns, unless the person changed it.
    void operation.then(() => { if (timedOut && userChoice === userRevision) void refresh(); }, () => {});
    try { const value = parseCompletionNotificationStatus(await withInferenceDeadline(operation)); if (current === revision) show(value); }
    catch { timedOut = true; if (current === revision) { toggle.checked = previous; message.textContent = 'No pude confirmar el cambio. Comprueba los avisos en Ajustes del iPhone.'; } }
    finally {
      configuring = false;
      if (current === revision) toggle.disabled = false;
      if (refreshAfterConfiguration) { refreshAfterConfiguration = false; void refresh(); }
    }
  });
  return { refresh };
}
