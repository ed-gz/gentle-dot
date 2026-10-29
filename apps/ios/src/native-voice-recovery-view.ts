import type { NativeVoiceReceipt, NativeVoiceReceiptEnvelope } from './native-voice-receipts.ts';
import './voice-receipt-recovery.css';

type Store = {
  list(): Promise<NativeVoiceReceiptEnvelope[]>;
  get(sessionId: string): Promise<NativeVoiceReceiptEnvelope | undefined>;
  release(receipt: NativeVoiceReceipt): Promise<void>;
  discard(receipt: NativeVoiceReceipt): Promise<void>;
};

/** Full transcripts remain selectable and are only inserted on a deliberate
 * gesture. A view can never infer whether an older insertion is still wanted. */
export function mountNativeVoiceRecovery(root: HTMLElement, options: {
  store: Store;
  isDelivered(receipt: NativeVoiceReceipt): Promise<boolean>;
  append(receipt: NativeVoiceReceipt): Promise<void> | void;
  confirmRelease(): boolean;
  confirmDiscard(): boolean;
  onChange?(visible: boolean): void;
}) {
  root.classList.add('voice-receipt-recovery'); root.hidden = true;
  let generation = 0, disposed = false;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; return item; };
  const same = (a: NativeVoiceReceipt, b: NativeVoiceReceipt) => JSON.stringify(a) === JSON.stringify(b);
  async function refresh() {
    if (disposed) return;
    const epoch = ++generation;
    try {
      const list: { item: NativeVoiceReceiptEnvelope; delivered: boolean }[] = [];
      for (const item of await options.store.list()) {
        if (item.receipt.audio.destination !== 'chat') continue;
        const delivered = await options.isDelivered(item.receipt);
        if (!delivered || item.releaseState !== 'released') list.push({ item, delivered });
      }
      if (disposed || generation !== epoch) return;
      const fragment = document.createDocumentFragment();
      for (const [index, { item, delivered }] of list.entries()) {
        const group = node('details'), summary = node('summary', list.length === 1 ? 'Dictado guardado' : `Dictado guardado ${index + 1}`);
        const text = node('p', item.receipt.transcript.text); text.className = 'voice-receipt-text';
        const actions = node('div'); actions.className = 'actions';
        const append = node('button', 'Añadir al mensaje'); append.type = 'button';
        append.hidden = delivered;
        const release = node('button', 'Eliminar audio'); release.type = 'button'; release.hidden = item.releaseState === 'released';
        const discard = node('button', 'Eliminar copia'); discard.type = 'button'; discard.disabled = item.releaseState !== 'released';
        const status = node('p'); status.className = 'hint'; status.setAttribute('role', 'status');
        if (item.receipt.transcript.text.length > 8000) status.textContent = 'El texto supera el espacio del mensaje. Selecciona y copia fragmentos.';
        let applied = false, busy = false;
        const update = () => { append.disabled = busy || applied || item.receipt.transcript.text.length > 8000; release.disabled = busy; discard.disabled = busy || item.releaseState !== 'released'; };
        async function exact() {
          const current = await options.store.get(item.receipt.audio.id);
          if (!current || !same(current.receipt, item.receipt)) throw new Error('El dictado cambió.');
          return current;
        }
        append.addEventListener('click', () => void (async () => {
          if (busy) return; busy = true; update();
          try { const current = await exact(); if (disposed || generation !== epoch) return;
            if (await options.isDelivered(current.receipt)) { await refresh(); return; }
            if (disposed || generation !== epoch) return;
            await options.append(current.receipt); applied = true; status.textContent = 'Añadido al mensaje. Revísalo antes de enviar.'; }
          catch { status.textContent = 'No pude añadirlo. Revisa el dictado y el espacio disponible.'; }
          finally { busy = false; update(); }
        })());
        release.addEventListener('click', () => void (async () => {
          if (busy || !options.confirmRelease()) return; busy = true; update();
          try { const current = await exact(); if (disposed || generation !== epoch) return; await options.store.release(current.receipt); await refresh(); }
          catch { status.textContent = 'No pude confirmar la eliminación del audio. Revisa su estado y vuelve a intentarlo.'; }
          finally { busy = false; update(); }
        })());
        discard.addEventListener('click', () => void (async () => {
          if (busy || !options.confirmDiscard()) return; busy = true; update();
          try { const current = await exact(); if (disposed || generation !== epoch) return; if (current.releaseState !== 'released') throw new Error('Audio retenido'); await options.store.discard(current.receipt); await refresh(); }
          catch { status.textContent = 'No pude confirmar que se eliminó la copia. Vuelve a intentarlo.'; }
          finally { busy = false; update(); }
        })());
        update(); actions.append(append, release, discard); group.append(summary, text, actions, status); fragment.append(group);
      }
      root.replaceChildren(fragment); root.hidden = list.length === 0;
      options.onChange?.(!root.hidden);
    } catch {
      if (disposed || generation !== epoch) return;
      const retry = node('button', 'Reintentar dictados'); retry.type = 'button';
      retry.addEventListener('click', () => void refresh());
      root.replaceChildren(node('p', 'No pude consultar los dictados guardados. Vuelve a intentarlo.'), retry); root.hidden = false;
      options.onChange?.(true);
    }
  }
  return { refresh, destroy() { disposed = true; generation++; root.replaceChildren(); root.hidden = true; } };
}
