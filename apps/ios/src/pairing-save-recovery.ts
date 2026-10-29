import { persistPairing, type PairedConnection } from './device-pairing.ts';

type Pending = { origin: string; connection: PairedConnection; epoch: number };
type RuntimeConnection = { url: string; token: string; deviceId?: string } | undefined;

/** Retry only local Keychain storage. Never redeem the one-use invitation again. */
export function mountPairingSaveRecovery(options: {
  status: HTMLElement;
  pairingBusy(value: boolean): void;
  manualForm: HTMLFormElement;
  disconnect: HTMLElement;
  current(): RuntimeConnection;
  epoch(): number;
  save?: typeof persistPairing;
}) {
  const save = options.save ?? persistPairing;
  const button = document.createElement('button');
  button.type = 'button'; button.id = 'retry-pairing-save'; button.textContent = 'Volver a guardar acceso'; button.hidden = true;
  options.status.after(button);
  let pending: Pending | undefined;
  let busy = false;
  const same = (item: Pending) => item.epoch === options.epoch() && options.current() === item.connection;
  const clear = () => { pending = undefined; button.hidden = true; };
  const block = (event: Event) => {
    if (!busy) return;
    event.preventDefault(); event.stopImmediatePropagation();
    options.status.textContent = 'Espera a que termine de guardarse el acceso.';
  };
  // A new connection cannot be installed while its predecessor is being
  // written. Otherwise a late Keychain write could overwrite the new pairing.
  options.manualForm.addEventListener('submit', block, true);
  options.disconnect.addEventListener('click', block, true);
  button.addEventListener('click', async () => {
    const item = pending;
    if (!item || busy) return;
    if (!same(item)) { clear(); options.status.textContent = 'La conexión cambió. Usa la conexión actual.'; return; }
    busy = true; button.disabled = true; options.pairingBusy(true);
    options.status.textContent = 'Guardando acceso en Keychain…';
    try {
      await save(item.origin, item.connection);
      if (pending === item && same(item)) { clear(); options.status.textContent = 'iPhone vinculado. Acceso guardado en Keychain.'; }
    } catch {
      if (pending === item && same(item)) options.status.textContent = 'No se pudo guardar el acceso. Puedes reintentarlo mientras Capri siga abierta.';
    } finally { busy = false; button.disabled = false; options.pairingBusy(false); }
  });
  return {
    offer(origin: string, connection: PairedConnection, epoch: number) { pending = { origin, connection, epoch }; button.hidden = false; },
    clear,
  };
}
