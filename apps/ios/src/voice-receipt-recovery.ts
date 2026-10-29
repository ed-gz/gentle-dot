import type { StoredVoiceReceipt, VoiceReceipt } from './voice-receipt-store.ts';
import './voice-receipt-recovery.css';

type ReceiptReader = {
  list(destination: string): Promise<StoredVoiceReceipt[]>;
  get(sessionId: string): Promise<StoredVoiceReceipt | undefined>;
};

/** This view is intentionally not mounted by the application yet. The caller
 * must atomically revalidate the exact receipt and real destination, merge
 * only its displayed transcript without overwriting the draft, and resolve
 * only once the result is durably saved. Repeated calls after a lost callback
 * or restart must be idempotent. This view neither writes a draft nor sends an
 * acknowledgement to the native recorder. */
export function createVoiceReceiptRecovery(root: HTMLElement, options: {
  store: ReceiptReader;
  useInChat(receipt: VoiceReceipt): Promise<void>;
  onError(message: string): void;
}) {
  root.hidden = true;
  root.classList.add('voice-receipt-recovery');
  let generation = 0, disposed = false, busy = false;
  const used = new Set<string>();
  const actions = new Map<string, { button: HTMLButtonElement; status: HTMLParagraphElement }>();
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function show(records: VoiceReceipt[]) {
    const fragment = document.createDocumentFragment();
    actions.clear();
    for (const [index, receipt] of records.entries()) {
      const key = `${receipt.sessionId}|${receipt.inputSHA256}`;
      const group = element('details');
      const label = element('summary', records.length > 1 ? `Dictado por recuperar ${index + 1}` : 'Dictado por recuperar');
      const transcript = element('p', receipt.transcript.text);
      transcript.className = 'voice-receipt-text';
      const button = element('button', 'Usar en conversación');
      button.type = 'button';
      const status = element('p');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-atomic', 'true');
      status.className = 'hint';
      actions.set(key, { button, status });
      button.disabled = busy || used.has(key);
      button.hidden = used.has(key);
      if (used.has(key)) status.textContent = 'Texto listo para revisar en la conversación.';
      button.addEventListener('click', () => void (async () => {
        if (busy || disposed || used.has(key)) return;
        busy = true;
        const captured = generation;
        for (const action of actions.values()) action.button.disabled = true;
        status.textContent = 'Preparando…';
        try {
          // Re-read exactly what was displayed, including its version and full
          // content. The caller must still do its own transactional check.
          const current = await options.store.get(receipt.sessionId);
          if (disposed || captured !== generation) return;
          if (!current || current.state === 'discarded' || !same(current, receipt)) {
            status.textContent = 'El dictado cambió. Vuelve a revisar el archivo.';
            return;
          }
          await options.useInChat(structuredClone(current));
          used.add(key);
          if (!disposed) {
            const shown = actions.get(key);
            if (shown) { shown.button.hidden = true; shown.status.textContent = 'Texto listo para revisar en la conversación.'; }
          }
        } catch {
          if (!disposed && captured === generation) status.textContent = 'No pude confirmar que se guardó. Revisa la conversación antes de reintentar.';
        } finally {
          busy = false;
          if (!disposed) for (const [key, action] of actions) action.button.disabled = used.has(key);
        }
      })());
      group.append(label, transcript, button, status);
      fragment.append(group);
    }
    root.replaceChildren(fragment);
    root.hidden = records.length === 0;
  }
  return {
    async refresh(): Promise<void> {
      if (disposed) return;
      const captured = ++generation;
      try {
        const all = await options.store.list('chat');
        if (disposed || captured !== generation) return;
        // `applied` currently refers to a separate draft, not the real chat.
        // Both states remain recoverable until a future integration records
        // an exact, durable delivery to the real composer.
        show(all.filter((item): item is VoiceReceipt => item.destination === 'chat' && item.state !== 'discarded'));
      } catch {
        if (disposed || captured !== generation) return;
        // Do not leave a stale transcript visible or treat the failure as an
        // empty/success state. The caller must surface this contextual error.
        actions.clear(); root.replaceChildren(); root.hidden = true;
        options.onError('No pude comprobar los dictados guardados.');
      }
    },
    destroy(): void { disposed = true; generation++; actions.clear(); used.clear(); root.replaceChildren(); root.classList.remove('voice-receipt-recovery'); root.hidden = true; },
  };
}
