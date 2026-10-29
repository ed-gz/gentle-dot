import type { VoiceChatCommit } from './voice-chat-commit.ts';
import './voice-receipt-recovery.css';

type ReceiptReader = {
  list(): Promise<VoiceChatCommit[]>;
  inspect(sessionId: string): Promise<VoiceChatCommit | undefined>;
};

/** Read-only view of the real chat's committed voice receipts. It is not
 * mounted by the app yet. A receipt alone does not prove that it still needs
 * recovery. A future coordinator must classify and revalidate that state from
 * durable evidence; this view never infers it, writes a draft, or ACKs audio. */
export function createVoiceReceiptRecovery(root: HTMLElement, options: {
  store: ReceiptReader;
  /** Must use an authoritative durable recovery marker, not draft text or
   * revision alone. No such production classifier is connected yet. */
  isRecoverable(receipt: VoiceChatCommit): Promise<boolean>;
  /** Optional platform provider; resolves only when it confirms the exact copy.
   * Without one, users may still select the visible text themselves. */
  copyText?(text: string): Promise<void>;
  onError(message: string): void;
}) {
  root.hidden = true;
  root.classList.add('voice-receipt-recovery');
  let generation = 0, disposed = false, busy = false;
  const actions = new Set<HTMLButtonElement>();
  const same = (a: VoiceChatCommit, b: VoiceChatCommit) => a.schema === b.schema
    && a.inputSHA256 === b.inputSHA256 && a.baseRevision === b.baseRevision
    && a.baseDraftSHA256 === b.baseDraftSHA256 && a.appliedRevision === b.appliedRevision
    && a.committedDraftSHA256 === b.committedDraftSHA256
    && JSON.stringify(a.input) === JSON.stringify(b.input);
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function show(records: VoiceChatCommit[]) {
    const fragment = document.createDocumentFragment();
    actions.clear();
    for (const [index, receipt] of records.entries()) {
      const group = element('details');
      const label = element('summary', records.length > 1 ? `Dictado guardado ${index + 1}` : 'Dictado guardado');
      const transcript = element('p', receipt.input.transcript.text);
      transcript.className = 'voice-receipt-text';
      const copyText = options.copyText;
      if (!copyText) { group.append(label, transcript); fragment.append(group); continue; }
      const button = element('button', 'Copiar texto');
      button.type = 'button'; button.disabled = busy;
      const status = element('p');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-atomic', 'true');
      status.className = 'hint';
      actions.add(button);
      button.addEventListener('click', () => void (async () => {
        if (busy || disposed) return;
        busy = true;
        const captured = generation;
        for (const action of actions) action.disabled = true;
        status.textContent = 'Preparando…';
        try {
          // A receipt may have changed between rendering and a tap. The
          // inspection itself is a snapshot, so it never authorizes an ACK.
          const current = await options.store.inspect(receipt.input.transcript.sessionId);
          if (disposed || captured !== generation) return;
          if (!current || !same(current, receipt)) {
            status.textContent = 'El dictado cambió. Vuelve a revisar el archivo.';
            return;
          }
          const stillRecoverable = await options.isRecoverable(structuredClone(current));
          if (disposed || captured !== generation) return;
          if (stillRecoverable !== true) {
            status.textContent = 'El dictado cambió. Vuelve a revisar el archivo.';
            return;
          }
          await copyText(current.input.transcript.text);
          if (!disposed && captured === generation) status.textContent = 'Texto copiado.';
        } catch {
          if (!disposed && captured === generation) status.textContent = 'No pude confirmar la copia. Puedes seleccionar el texto.';
        } finally {
          busy = false;
          if (!disposed) for (const action of actions) action.disabled = false;
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
        const all = await options.store.list();
        if (disposed || captured !== generation) return;
        const recoverable: VoiceChatCommit[] = [];
        for (const item of all) {
          if (item.input.destination !== 'chat') continue;
          // Listing and hashing are snapshots. Re-read the exact record before
          // showing even a classified receipt; disappearing or changing data
          // is an error, not an empty or trustworthy view.
          const current = await options.store.inspect(item.input.transcript.sessionId);
          if (disposed || captured !== generation) return;
          if (!current || !same(current, item)) throw new Error('El dictado cambió durante la consulta.');
          const result = await options.isRecoverable(structuredClone(current));
          if (disposed || captured !== generation) return;
          if (typeof result !== 'boolean') throw new Error('No se pudo verificar el estado del dictado.');
          if (result) recoverable.push(current);
        }
        show(recoverable);
      } catch {
        if (disposed || captured !== generation) return;
        actions.clear(); root.replaceChildren(); root.hidden = true;
        options.onError('No pude comprobar los dictados guardados.');
      }
    },
    destroy(): void { disposed = true; generation++; actions.clear(); root.replaceChildren(); root.classList.remove('voice-receipt-recovery'); root.hidden = true; },
  };
}

/** Future explicit mounting point for Archivo. It inserts no section until the
 * caller verifies at least one receipt needs recovery, and removes it when
 * none do. Not called by the app: the durable classifier, native source
 * verification, retention and tested iOS clipboard provider remain open. */
export function prepareVoiceReceiptArchive(archive: HTMLElement, options: Parameters<typeof createVoiceReceiptRecovery>[1], before?: Element) {
  if (before && before.parentElement !== archive) throw new Error('El destino del archivo no es válido.');
  const root = document.createElement('section');
  const view = createVoiceReceiptRecovery(root, options);
  let disposed = false;
  return {
    root,
    async refresh(): Promise<void> {
      if (disposed) return;
      await view.refresh();
      if (disposed) return;
      if (root.hidden) root.remove();
      else if (root.parentElement !== archive) archive.insertBefore(root, before ?? null);
    },
    destroy(): void { disposed = true; view.destroy(); root.remove(); },
  };
}
