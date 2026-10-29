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
  exportTranscript?(receipt: NativeVoiceReceipt): Promise<'exported' | 'cancelled'>;
  confirmRelease(): boolean;
  confirmDiscard(): boolean;
  onChange?(visible: boolean): void;
}) {
  root.classList.add('voice-receipt-recovery'); root.hidden = true;
  let generation = 0, renderGeneration = 0, disposed = false, renderedKey: string | undefined;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; return item; };
  const same = (a: NativeVoiceReceipt, b: NativeVoiceReceipt) => JSON.stringify(a) === JSON.stringify(b);
  async function refresh() {
    if (disposed) return;
    const epoch = ++generation;
    try {
      const list: { item: NativeVoiceReceiptEnvelope; delivered: boolean }[] = [];
      for (const item of await options.store.list()) {
        const delivered = item.receipt.audio.destination === 'chat' && await options.isDelivered(item.receipt);
        if (!delivered || item.releaseState !== 'released') list.push({ item, delivered });
      }
      if (disposed || generation !== epoch) return;
      // Concurrent refreshes are common while the panel opens. Do not replace
      // identical controls while a person is focusing them or exporting.
      const key = JSON.stringify(list);
      if (key === renderedKey) return;
      const viewEpoch = ++renderGeneration;
      const fragment = document.createDocumentFragment();
      for (const [index, { item, delivered }] of list.entries()) {
        const foreign = item.receipt.audio.destination !== 'chat';
        const label = foreign ? 'Dictado de otra sesión' : 'Dictado guardado';
        const group = node('details'), summary = node('summary', list.length === 1 ? label : `${label} ${index + 1}`);
        const text = node('p', item.receipt.transcript.text); text.className = 'voice-receipt-text';
        const actions = node('div'); actions.className = 'actions';
        const append = node('button', 'Añadir al mensaje'); append.type = 'button';
        append.hidden = foreign || delivered;
        const exportButton = node('button', 'Exportar texto'); exportButton.type = 'button'; exportButton.hidden = !foreign || !options.exportTranscript;
        const release = node('button', 'Eliminar audio'); release.type = 'button'; release.hidden = item.releaseState === 'released';
        const discard = node('button', 'Eliminar copia'); discard.type = 'button'; discard.disabled = item.releaseState !== 'released';
        const status = node('p'); status.className = 'hint'; status.setAttribute('role', 'status');
        if (item.receipt.transcript.text.length > 8000) status.textContent = 'El texto supera el espacio del mensaje. Selecciona y copia fragmentos.';
        let applied = false, busy = false;
        const update = () => { append.disabled = busy || applied || item.receipt.transcript.text.length > 8000; exportButton.disabled = busy; release.disabled = busy; discard.disabled = busy || item.releaseState !== 'released'; };
        async function exact() {
          const current = await options.store.get(item.receipt.audio.id);
          if (!current || !same(current.receipt, item.receipt)) throw new Error('El dictado cambió.');
          return current;
        }
        append.addEventListener('click', () => void (async () => {
          if (foreign || busy) return; busy = true; update();
          try { const current = await exact(); if (disposed || renderGeneration !== viewEpoch) return;
            if (await options.isDelivered(current.receipt)) { await refresh(); return; }
            if (disposed || renderGeneration !== viewEpoch) return;
            await options.append(current.receipt); applied = true; status.textContent = 'Añadido al mensaje. Revísalo antes de enviar.'; }
          catch { status.textContent = 'No pude añadirlo. Revisa el dictado y el espacio disponible.'; }
          finally { busy = false; update(); }
        })());
        exportButton.addEventListener('click', () => void (async () => {
          if (busy || !options.exportTranscript) return; busy = true; update();
          try { const current = await exact(); if (disposed || renderGeneration !== viewEpoch) return;
            const result = await options.exportTranscript(current.receipt);
            status.textContent = result === 'exported' ? 'Texto exportado.' : 'Exportación cancelada.';
          } catch { status.textContent = 'No pude confirmar la exportación. Vuelve a revisar el dictado.'; }
          finally { busy = false; update(); }
        })());
        release.addEventListener('click', () => void (async () => {
          if (busy || !options.confirmRelease()) return; busy = true; update();
          try { const current = await exact(); if (disposed || renderGeneration !== viewEpoch) return; await options.store.release(current.receipt); await refresh(); }
          catch { status.textContent = 'No pude confirmar la eliminación del audio. Revisa su estado y vuelve a intentarlo.'; }
          finally { busy = false; update(); }
        })());
        discard.addEventListener('click', () => void (async () => {
          if (busy || !options.confirmDiscard()) return; busy = true; update();
          try { const current = await exact(); if (disposed || renderGeneration !== viewEpoch) return; if (current.releaseState !== 'released') throw new Error('Audio retenido'); await options.store.discard(current.receipt); await refresh(); }
          catch { status.textContent = 'No pude confirmar que se eliminó la copia. Vuelve a intentarlo.'; }
          finally { busy = false; update(); }
        })());
        update(); actions.append(append, exportButton, release, discard); group.append(summary);
        if (foreign) group.append(node('p', 'Este dictado pertenece a una sesión de la laptop. No se añadirá a esta conversación.'));
        group.append(text, actions, status); fragment.append(group);
      }
      root.replaceChildren(fragment); renderedKey = key; root.hidden = list.length === 0;
      options.onChange?.(!root.hidden);
    } catch {
      if (disposed || generation !== epoch) return;
      renderedKey = undefined; renderGeneration++;
      const retry = node('button', 'Reintentar dictados'); retry.type = 'button';
      retry.addEventListener('click', () => void refresh());
      root.replaceChildren(node('p', 'No pude consultar los dictados guardados. Vuelve a intentarlo.'), retry); root.hidden = false;
      options.onChange?.(true);
    }
  }
  return { refresh, destroy() { disposed = true; generation++; renderGeneration++; root.replaceChildren(); root.hidden = true; } };
}
