import { isTauri } from '@tauri-apps/api/core';
import { cancelPairingCode, scanPairingCode, type ScannedInvitation } from './pairing-qr.ts';
import './pairing-input.css';

type PairingMount = { dispose(): void };
const mounted = new WeakMap<HTMLFormElement, PairingMount>();

/** Photo/camera QR entry only. The existing form remains the sole explicit pairing action. */
export function mountPairingInput(form: HTMLFormElement, input: HTMLInputElement | HTMLTextAreaElement,
  dependencies: { scan?: (file: File, signal?: AbortSignal) => Promise<ScannedInvitation>; cancel?: () => Promise<void>; native?: boolean } = {}): PairingMount {
  const previous = mounted.get(form); if (previous) return previous;
  const scan = dependencies.scan ?? ((file, signal) => scanPairingCode(file, undefined, signal)), cancel = dependencies.cancel ?? cancelPairingCode;
  const native = dependencies.native ?? isTauri();
  const region = document.createElement('div'); region.className = 'pairing-scan';
  const help = document.createElement('p'); help.className = 'pairing-scan-help';
  help.textContent = 'Abre el QR de vinculación en Gentle Dot, en tu laptop. Puedes fotografiarlo o elegir una captura.';
  const controls = document.createElement('div'); controls.className = 'pairing-scan-controls';
  const status = document.createElement('p'); status.className = 'pairing-scan-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const button = (label: string) => { const value = document.createElement('button'); value.type = 'button'; value.textContent = label; return value; };
  const camera = button('Fotografiar QR'), photo = button('Elegir foto del QR'), stop = button('Cancelar lectura'); stop.hidden = true;
  const pickers = [true, false].map(capture => {
    const picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/png,image/jpeg,image/heic,image/heif,image/webp,image/tiff';
    picker.hidden = true; picker.setAttribute('aria-label', capture ? 'Foto de cámara para leer QR' : 'Foto guardada para leer QR');
    if (capture) { picker.accept = 'image/*'; picker.setAttribute('capture', 'environment'); }
    return picker;
  });
  controls.append(camera, photo, stop); region.append(help, controls, ...pickers, status);
  const heading = form.querySelector('h2'); if (heading) heading.after(region); else form.prepend(region);
  let epoch = 0, busy = false, disposed = false, controller: AbortController | undefined;
  const setBusy = (value: boolean) => { busy = value; camera.disabled = photo.disabled = value || !native; stop.hidden = !value; region.setAttribute('aria-busy', String(value)); };
  setBusy(false);
  if (!native) status.textContent = 'La cámara y lectura de QR funcionan en Capri instalada. Aquí puedes pegar la invitación.';
  const clearCandidate = () => { epoch++; if (busy) status.textContent = 'Conservando la invitación que escribiste.'; };
  input.addEventListener('input', clearCandidate);
  const blockSubmit = (event: SubmitEvent) => { if (busy) { event.preventDefault(); event.stopImmediatePropagation(); status.textContent = 'Espera a que termine la lectura o cancélala antes de vincular.'; } };
  form.addEventListener('submit', blockSubmit, true);
  const read = async (picker: HTMLInputElement) => {
    const file = picker.files?.[0]; picker.value = ''; if (!file || busy || disposed) return;
    const current = ++epoch, original = input.value; const operation = new AbortController(); controller = operation;
    setBusy(true); status.textContent = 'Leyendo el QR en este iPhone…';
    try {
      const found = await scan(file, operation.signal);
      if (disposed || current !== epoch || input.value !== original) return;
      input.value = found.link; input.dispatchEvent(new Event('input', { bubbles: true }));
      status.textContent = `Invitación de ${found.invitation.name}\n${found.invitation.origin}\nRevisa el equipo y pulsa Vincular iPhone para continuar.`;
      input.focus();
    } catch (error) {
      if (!disposed && current === epoch) status.textContent = error instanceof Error ? error.message : 'No pude leer el QR. Puedes pegar la invitación.';
    } finally { if (controller === operation) controller = undefined; if (!disposed) setBusy(false); }
  };
  pickers.forEach(picker => picker.addEventListener('change', () => void read(picker)));
  camera.onclick = () => pickers[0]!.click(); photo.onclick = () => pickers[1]!.click();
  const cancelCurrent = () => { if (!busy) return; epoch++; controller?.abort(); status.textContent = 'Lectura cancelada. No se vinculó ningún equipo.'; stop.disabled = true; void cancel().catch(() => {}).finally(() => { stop.disabled = false; }); };
  stop.onclick = cancelCurrent;
  const visibility = () => { if (document.hidden) cancelCurrent(); }; document.addEventListener('visibilitychange', visibility);
  const mount: PairingMount = { dispose() { if (disposed) return; disposed = true; epoch++; controller?.abort(); if (busy) void cancel().catch(() => {});
    document.removeEventListener('visibilitychange', visibility); input.removeEventListener('input', clearCandidate); form.removeEventListener('submit', blockSubmit, true); region.remove(); mounted.delete(form); } };
  mounted.set(form, mount); return mount;
}
