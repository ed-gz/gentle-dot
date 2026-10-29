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
  const describe = () => enabled
    ? 'Al salir, iOS puede continuar un paso de análisis y mostrar una actividad. Puede detenerlo; las herramientas esperan a que vuelvas.'
    : 'El análisis extendido está desactivado. iOS puede dar un breve tiempo al paso actual; las herramientas esperan a que vuelvas.';
  try {
    enabled = native && storage().getItem(preferenceName) === '1';
    if (native) status.textContent = describe();
  } catch { status.textContent = 'No pude leer esta preferencia. Está desactivada.'; }
  toggle.checked = enabled; toggle.disabled = !native;
  if (!native) status.textContent = 'Disponible en la app instalada en el iPhone.';
  toggle.addEventListener('change', () => {
    const previous = enabled;
    try {
      storage().setItem(preferenceName, toggle.checked ? '1' : '0');
      enabled = toggle.checked;
      status.textContent = `${describe()} El cambio aplica a los próximos mensajes.`;
    } catch {
      enabled = previous; toggle.checked = previous;
      status.textContent = 'No pude guardar el cambio. La preferencia anterior se conserva.';
    }
  });
  return { enabled: () => enabled };
}
