import { isTauri } from '@tauri-apps/api/core';
import type { LiveCoordinatorState, createLiveActivityCoordinator } from './live-activity-coordinator.ts';

type Coordinator = ReturnType<typeof createLiveActivityCoordinator>;
const KEY = 'capri.ios.lock-screen-activity.v1';
/** The only persisted value is this non-secret, explicitly chosen preference. */
export function mountLiveActivitySettings(root: HTMLElement, coordinator: Coordinator, options: {
  native?: boolean; storage?: Pick<Storage, 'getItem' | 'setItem'>;
} = {}) {
  const toggle = root.querySelector<HTMLInputElement>('input')!;
  const message = root.querySelector<HTMLElement>('[role="status"]')!;
  const retry = root.querySelector<HTMLButtonElement>('button')!;
  const native = options.native ?? isTauri();
  let storageError = false, configured = false;
  const storage = () => options.storage ?? globalThis.localStorage;
  function saved(): 'enabled' | 'disabled' | 'unset' {
    try { const value = storage()?.getItem(KEY); return value === '1' ? 'enabled' : value === '0' ? 'disabled' : 'unset'; }
    catch { storageError = true; return 'unset'; }
  }
  function persist(enabled: boolean) {
    try { storage().setItem(KEY, enabled ? '1' : '0'); storageError = false; }
    catch { storageError = true; }
  }
  function render(state: LiveCoordinatorState) {
    toggle.checked = state.enabled;
    toggle.disabled = !native || state.status === 'checking';
    const canDismiss = !state.enabled && state.status === 'active' && !!state.activity;
    retry.hidden = !native || (!canDismiss && !['uncertain', 'unavailable', 'conflict'].includes(state.status));
    retry.textContent = canDismiss ? 'Ocultar actividad' : 'Comprobar estado';
    if (!native) message.textContent = 'Disponible en la app instalada en el iPhone.';
    else if (storageError) message.textContent = 'No pude guardar esta preferencia; sólo se conserva durante esta sesión.';
    else if (state.status === 'uncertain') message.textContent = state.message || 'No se confirmó el estado. Compruébalo antes de continuar.';
    else if (canDismiss) message.textContent = 'Hay una actividad abierta; puedes ocultarla sin detener el trabajo.';
    else if (!state.enabled) message.textContent = 'Desactivado. Al ocultarla, el trabajo continúa.';
    else if (state.status === 'checking') message.textContent = 'Comprobando la pantalla bloqueada…';
    else if (state.status === 'active') message.textContent = state.activity?.stale ? 'Sin señal reciente. Abre Capri para actualizar el estado.' : 'Mostrando el estado confirmado de esta respuesta local.';
    else if (state.status === 'ready') message.textContent = 'Se mostrará al iniciar una respuesta local. No incluye el contenido.';
    else message.textContent = state.message || 'No está disponible en esta instalación o en Ajustes del iPhone.';
  }
  async function initialize() {
    if (!native) { configured = true; render(coordinator.snapshot()); return; }
    const preference = saved(); configured = true;
    try {
      await coordinator.setEnabled(preference === 'enabled');
      // A prior opt-out may have raced a timeout. Inspect on restart so the
      // person can dismiss a still-visible activity without restarting work.
      if (preference === 'disabled') await coordinator.refresh();
    } catch { /* Status explains the failure; never retry a mutation. */ }
    render(coordinator.snapshot());
  }
  toggle.addEventListener('change', async () => {
    const enabled = toggle.checked; persist(enabled);
    try { await coordinator.setEnabled(enabled); } catch { /* The coordinator retains uncertainty for review. */ }
    render(coordinator.snapshot());
  });
  retry.addEventListener('click', async () => {
    try {
      const state = coordinator.snapshot();
      if (!state.enabled && state.status === 'active' && state.activity) await coordinator.setEnabled(false);
      else await coordinator.refresh();
    } catch { /* Status remains visible. */ }
    render(coordinator.snapshot());
  });
  async function refresh() {
    if (!configured || !native || !coordinator.snapshot().enabled) return;
    try { await coordinator.refresh(); } catch { /* Never restart an activity during recovery. */ }
    render(coordinator.snapshot());
  }
  return { initialize, refresh, render };
}
