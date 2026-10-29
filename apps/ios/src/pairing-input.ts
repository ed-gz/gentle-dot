import { isTauri } from '@tauri-apps/api/core';
import { cancelPairingCode, scanPairingCode, type ScannedInvitation } from './pairing-qr.ts';
import { scanPairingCamera, cancelPairingCamera } from './pairing-camera.ts';
import { parseInvitation } from './device-pairing.ts';
import './pairing-input.css';

type PairingMount = { setSubmitting(value: boolean): void; dispose(): void };
const mounted = new WeakMap<HTMLFormElement, PairingMount>();

/** Native live camera or photo input. The form remains the sole explicit pairing action. */
export function mountPairingInput(form: HTMLFormElement, input: HTMLInputElement | HTMLTextAreaElement,
  dependencies: { scan?: (file: File, signal?: AbortSignal) => Promise<ScannedInvitation>; cancel?: () => Promise<void>; liveScan?: (signal?: AbortSignal) => Promise<ScannedInvitation | null>; cancelLive?: () => Promise<void>; native?: boolean } = {}): PairingMount {
  const previous = mounted.get(form); if (previous) return previous;
  const scan = dependencies.scan ?? ((file, signal) => scanPairingCode(file, undefined, signal)), cancel = dependencies.cancel ?? cancelPairingCode;
  const liveScan = dependencies.liveScan ?? (signal => scanPairingCamera(undefined, signal)), cancelLive = dependencies.cancelLive ?? cancelPairingCamera;
  const native = dependencies.native ?? isTauri();
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const region = document.createElement('div'); region.className = 'pairing-scan';
  const help = document.createElement('p'); help.className = 'pairing-scan-help';
  help.textContent = 'Abre el QR de Gentle Dot en tu laptop y escanéalo.';
  const controls = document.createElement('div'); controls.className = 'pairing-scan-controls';
  const status = document.createElement('p'); status.className = 'pairing-scan-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const button = (label: string) => { const value = document.createElement('button'); value.type = 'button'; value.textContent = label; return value; };
  const camera = button('Escanear QR'), photo = button('Elegir foto del QR'), stop = button('Cancelar lectura'); stop.hidden = true;
  camera.className = 'primary'; camera.id = 'pairing-camera';
  const picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/png,image/jpeg,image/heic,image/heif,image/webp,image/tiff';
  picker.hidden = true; picker.setAttribute('aria-label', 'Foto guardada para leer QR');
  controls.append(camera, photo, stop); region.append(help, controls, picker, status);
  const heading = form.querySelector('.settings-pairing-heading') ?? form.querySelector('h2');
  if (heading) heading.after(region); else form.prepend(region);
  let epoch = 0, busy = false, submitting = false, disposed = false, controller: AbortController | undefined;
  const valid = () => { try { parseInvitation(input.value); return true; } catch { return false; } };
  const setBusy = (value: boolean) => { busy = value; const locked = value || submitting; if (submit) { submit.disabled = locked || !valid(); submit.hidden = !valid(); } camera.disabled = photo.disabled = locked || !native; input.disabled = submitting; stop.hidden = !value; region.setAttribute('aria-busy', String(locked)); };
  setBusy(false);
  if (!native) { status.textContent = 'La cámara y lectura de QR funcionan en Capri instalada. Aquí puedes pegar la invitación.'; const manual = input.closest('details'); if (manual) manual.open = true; }
  const clearCandidate = () => { epoch++; setBusy(busy); if (busy) status.textContent = 'Conservando la invitación que escribiste.'; else if (valid()) showCandidate(); else status.textContent = '';  };
  const showCandidate = () => { const candidate = parseInvitation(input.value); status.textContent = `${candidate.name}\n${candidate.origin}\nRevisa el equipo y pulsa Vincular iPhone para continuar.`; };
  input.addEventListener('input', clearCandidate);
  const blockSubmit = (event: SubmitEvent) => { if (busy || submitting || !valid()) { event.preventDefault(); event.stopImmediatePropagation(); status.textContent = busy ? 'Espera a que termine la lectura o cancélala antes de vincular.' : 'Escanea el QR o pega una invitación válida de Gentle Dot.'; } };
  form.addEventListener('submit', blockSubmit, true);
  let live = false;
  const read = async (file?: File) => {
    if (busy || submitting || disposed) return;
    live = !file;
    const current = ++epoch, original = input.value; const operation = new AbortController(); controller = operation;
    setBusy(true); status.textContent = 'Leyendo el QR en este iPhone…';
    try {
      const found = file ? await scan(file, operation.signal) : await liveScan(operation.signal);
      if (disposed || current !== epoch || input.value !== original) return;
      if (!found) { status.textContent = 'Lectura cancelada. No se vinculó ningún equipo.'; return; }
      input.value = found.link; input.dispatchEvent(new Event('input', { bubbles: true }));
      showCandidate();
      setBusy(false); submit?.focus();
    } catch (error) {
      if (!disposed && current === epoch) status.textContent = error instanceof Error ? error.message : 'No pude leer el QR. Puedes pegar la invitación.';
    } finally { if (controller === operation) controller = undefined; if (!disposed) setBusy(false); }
  };
  picker.addEventListener('change', () => { const file = picker.files?.[0]; picker.value = ''; if (file) void read(file); });
  camera.onclick = () => void read(); photo.onclick = () => picker.click();
  const cancelCurrent = () => { if (!busy) return; epoch++; controller?.abort(); status.textContent = 'Lectura cancelada. No se vinculó ningún equipo.'; stop.disabled = true; void (live ? cancelLive() : cancel()).catch(() => {}).finally(() => { stop.disabled = false; }); };
  stop.onclick = cancelCurrent;
  // UIKit may obscure the web view while requesting camera permission or
  // presenting the scanner. Native PairingScanner cancels on a real app
  // background transition; treating WebView visibility as background here
  // would cancel a first-time scan before the user can grant permission.
  const visibility = () => { if (document.hidden && !live) cancelCurrent(); }; document.addEventListener('visibilitychange', visibility);
  const mount: PairingMount = { setSubmitting(value) { submitting = value; setBusy(busy); }, dispose() { if (disposed) return; disposed = true; epoch++; controller?.abort(); if (busy) void (live ? cancelLive() : cancel()).catch(() => {});
    document.removeEventListener('visibilitychange', visibility); input.removeEventListener('input', clearCandidate); form.removeEventListener('submit', blockSubmit, true); region.remove(); mounted.delete(form); } };
  mounted.set(form, mount); return mount;
}
