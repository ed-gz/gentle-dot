import { isTauri } from '@tauri-apps/api/core';

const preferenceName = 'capri.ios.continued-inference.v1';

/** An explicit, reversible preference. It changes future messages only. */
export function mountContinuedInferenceSettings(root: HTMLElement, dependencies: {
  native?: boolean; storage?: Pick<Storage, 'getItem' | 'setItem'>;
} = {}) {
  const toggle = root.querySelector<HTMLInputElement>('input')!;
  const status = root.querySelector<HTMLElement>('[role="status"]')!;
  const native = dependencies.native ?? isTauri();
  let enabled = false;
  const storage = () => dependencies.storage ?? globalThis.localStorage;
  try { enabled = native && storage().getItem(preferenceName) === '1'; }
  catch { status.textContent = 'No pude leer esta preferencia. Está desactivada.'; }
  toggle.checked = enabled; toggle.disabled = !native;
  if (!native) status.textContent = 'Disponible en la app instalada en el iPhone.';
  toggle.addEventListener('change', () => {
    const previous = enabled;
    try {
      storage().setItem(preferenceName, toggle.checked ? '1' : '0');
      enabled = toggle.checked;
      status.textContent = enabled
        ? 'Para tus próximos mensajes, iOS mostrará un paso de análisis y el inicio puede tardar unos segundos. Las herramientas esperan a que vuelvas; iOS puede detener el paso.'
        : 'Desactivado para los próximos mensajes. El paso actual conserva su estado.';
    } catch {
      enabled = previous; toggle.checked = previous;
      status.textContent = 'No pude guardar el cambio. La preferencia anterior se conserva.';
    }
  });
  return { enabled: () => enabled };
}
