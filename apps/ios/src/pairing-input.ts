import { isTauri } from '@tauri-apps/api/core';
import { cancelPairingCode, scanPairingCode, type ScannedInvitation } from './pairing-qr.ts';
import { scanPairingCamera, cancelPairingCamera } from './pairing-camera.ts';
import { parseInvitation } from './device-pairing.ts';
import { localIdentifier } from './local-identifiers.ts';
import './pairing-input.css';

type PairingMount = { setSubmitting(value: boolean): void; dispose(): void };
const mounted = new WeakMap<HTMLFormElement, PairingMount>();

/** Release the UI when an abandoned native read never returns its callback. */
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException('Lectura cancelada', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

/** Native live camera or photo input. The form remains the sole explicit pairing action. */
export function mountPairingInput(form: HTMLFormElement, input: HTMLInputElement | HTMLTextAreaElement,
  dependencies: { scan?: (file: File, signal?: AbortSignal, requestId?: string) => Promise<ScannedInvitation>; cancel?: (requestId: string) => Promise<void>; liveScan?: (signal?: AbortSignal) => Promise<ScannedInvitation | null>; cancelLive?: () => Promise<void>; native?: boolean } = {}): PairingMount {
  const previous = mounted.get(form); if (previous) return previous;
  const scan = dependencies.scan ?? ((file, signal, requestId) => scanPairingCode(file, undefined, signal, requestId)), cancel = dependencies.cancel ?? cancelPairingCode;
  const liveScan = dependencies.liveScan ?? (signal => scanPairingCamera(undefined, signal)), cancelLive = dependencies.cancelLive ?? cancelPairingCamera;
  const native = dependencies.native ?? isTauri();
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const region = document.createElement('div'); region.className = 'pairing-scan';
  const help = document.createElement('p'); help.className = 'pairing-scan-help';
  help.textContent = 'Abre el QR de Gentle Dot en tu laptop y escanéalo.';
  const instructions = document.createElement('details'); instructions.className = 'pairing-instructions';
  const summary = document.createElement('summary'); summary.textContent = '¿Dónde está el QR?';
  const steps = document.createElement('ol');
  const first = document.createElement('li'); first.textContent = 'Abre Gentle Dot en la laptop y conecta ambos dispositivos a Tailscale.';
  const second = document.createElement('li'); second.append('En la terminal de la laptop, dentro de la carpeta del proyecto, ejecuta ');
  const command = document.createElement('code'); command.textContent = 'pnpm mobile:connect'; second.append(command, '.');
  const third = document.createElement('li'); third.textContent = 'Escanea el QR, revisa el equipo y pulsa Vincular iPhone. Si la laptop solicita aprobación, confírmala allí. El código vence en cinco minutos.';
  steps.append(first, second, third); instructions.append(summary, steps);
  const controls = document.createElement('div'); controls.className = 'pairing-scan-controls';
  const status = document.createElement('p'); status.className = 'pairing-scan-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const button = (label: string) => { const value = document.createElement('button'); value.type = 'button'; value.textContent = label; return value; };
  const camera = button('Escanear QR'), photo = button('Elegir foto del QR'), stop = button('Cancelar lectura'); stop.hidden = true;
  camera.className = 'primary'; camera.id = 'pairing-camera';
  const picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/png,image/jpeg,image/heic,image/heif,image/webp,image/tiff';
  picker.hidden = true; picker.setAttribute('aria-label', 'Foto guardada para leer QR');
  controls.append(camera, photo, stop); region.append(help, controls, instructions, picker, status);
  const heading = form.querySelector('.settings-pairing-heading') ?? form.querySelector('h2');
  if (heading) heading.after(region); else form.prepend(region);
  let epoch = 0, busy = false, cancelling = false, cancellationUncertain = false, submitting = false, disposed = false, controller: AbortController | undefined;
  const valid = () => { try { parseInvitation(input.value); return true; } catch { return false; } };
  const setBusy = (value: boolean) => { busy = value; const locked = value || cancelling || cancellationUncertain || submitting; if (submit) { submit.disabled = locked || !valid(); submit.hidden = !valid(); } camera.disabled = photo.disabled = locked || !native; input.disabled = submitting; stop.hidden = !value && !cancelling && !cancellationUncertain; stop.disabled = cancelling; stop.textContent = cancellationUncertain && !cancelling ? 'Reintentar cierre' : 'Cancelar lectura'; region.setAttribute('aria-busy', String(locked)); };
  setBusy(false);
  if (!native) { status.textContent = 'La cámara y lectura de QR funcionan en Capri instalada. Aquí puedes pegar la invitación.'; const manual = input.closest('details'); if (manual) manual.open = true; }
  const clearCandidate = () => { epoch++; setBusy(busy); if (busy) status.textContent = 'Conservando la invitación que escribiste.'; else if (valid()) showCandidate(); else status.textContent = '';  };
  const showCandidate = () => { const candidate = parseInvitation(input.value); status.textContent = `${candidate.name}\n${candidate.origin}\nRevisa el equipo y pulsa Vincular iPhone para continuar.`; };
  input.addEventListener('input', clearCandidate);
  const blockSubmit = (event: SubmitEvent) => { if (busy || cancelling || cancellationUncertain || submitting || !valid()) { event.preventDefault(); event.stopImmediatePropagation(); status.textContent = busy || cancelling || cancellationUncertain ? 'Espera a que termine la lectura o confirma su cierre antes de vincular.' : 'Escanea el QR o pega una invitación válida de Gentle Dot.'; } };
  form.addEventListener('submit', blockSubmit, true);
  let live = false, photoRequestId: string | undefined;
  const read = async (file?: File) => {
    if (busy || cancelling || cancellationUncertain || submitting || disposed) return;
    live = !file; photoRequestId = file ? localIdentifier() : undefined;
    const current = ++epoch, original = input.value; const operation = new AbortController(); controller = operation;
    setBusy(true); status.textContent = 'Leyendo el QR en este iPhone…';
    try {
      const found = await abortable(file ? scan(file, operation.signal, photoRequestId) : liveScan(operation.signal), operation.signal);
      if (disposed || current !== epoch || input.value !== original) return;
      if (!found) { status.textContent = 'Lectura cancelada. No se vinculó ningún equipo.'; return; }
      input.value = found.link; input.dispatchEvent(new Event('input', { bubbles: true }));
      showCandidate();
      setBusy(false); submit?.focus();
    } catch (error) {
      if (!disposed && current === epoch) status.textContent = error instanceof Error ? error.message : 'No pude leer el QR. Puedes pegar la invitación.';
    } finally { if (controller === operation) { controller = undefined; if (!cancelling && !cancellationUncertain) photoRequestId = undefined; if (!disposed) setBusy(false); } }
  };
  picker.addEventListener('change', () => { const file = picker.files?.[0]; picker.value = ''; if (file) void read(file); });
  camera.onclick = () => void read(); photo.onclick = () => picker.click();
  const cancelCurrent = () => {
    if ((!busy && !cancellationUncertain) || cancelling) return;
    epoch++; cancelling = true; cancellationUncertain = true; setBusy(busy); controller?.abort();
    status.textContent = 'Cancelando lectura…';
    const warning = setTimeout(() => {
      if (!disposed && cancelling) status.textContent = 'No se ha confirmado el cierre de la cámara. Espera o vuelve a abrir Capri antes de escanear.';
    }, 3000);
    void (live ? cancelLive() : cancel(photoRequestId!)).then(() => {
      cancellationUncertain = false; photoRequestId = undefined;
      if (!disposed) status.textContent = 'Lectura cancelada. No se vinculó ningún equipo.';
    }).catch(() => {
      if (!disposed) status.textContent = 'No pude confirmar que terminó la lectura. Reintenta el cierre antes de volver a escanear.';
    }).finally(() => { clearTimeout(warning); cancelling = false; if (!disposed) setBusy(busy); });
  };
  stop.onclick = cancelCurrent;
  // UIKit may obscure the web view while requesting camera permission or
  // presenting the scanner. Native PairingScanner cancels on a real app
  // background transition; treating WebView visibility as background here
  // would cancel a first-time scan before the user can grant permission.
  const visibility = () => { if (document.hidden && !live) cancelCurrent(); }; document.addEventListener('visibilitychange', visibility);
  const mount: PairingMount = { setSubmitting(value) { submitting = value; setBusy(busy); }, dispose() { if (disposed) return; disposed = true; epoch++; controller?.abort(); if (busy || cancellationUncertain) void (live ? cancelLive() : photoRequestId ? cancel(photoRequestId) : Promise.resolve()).catch(() => {});
    document.removeEventListener('visibilitychange', visibility); input.removeEventListener('input', clearCandidate); form.removeEventListener('submit', blockSubmit, true); region.remove(); mounted.delete(form); } };
  mounted.set(form, mount); return mount;
}
