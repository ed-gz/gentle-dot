import type { createConversationDraftRescue, DraftRescue } from './conversation-draft-rescue.ts';

/** Explicit recovery; a backup is never silently inserted or sent. */
export function mountConversationDraftRecovery(root: HTMLElement, options: {
  store: Pick<ReturnType<typeof createConversationDraftRescue>, 'list' | 'discard' | 'retireIfCurrent'>;
  append(record: DraftRescue): Promise<void> | void;
  confirmDiscard(): boolean;
}) {
  let generation = 0, disposed = false;
  root.hidden = true;
  const same = (a: DraftRescue, b: DraftRescue) => a.owner === b.owner && a.sequence === b.sequence && a.baseRevision === b.baseRevision
    && a.draft === b.draft && a.attachedWork === b.attachedWork;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
  async function refresh(): Promise<void> {
    if (disposed) return;
    const epoch = ++generation;
    try {
      const candidates = await options.store.list();
      const visible: DraftRescue[] = [];
      for (const record of candidates) {
        // The store removes only an exact backup already present in current.
        if (!(await options.store.retireIfCurrent(record))) visible.push(record);
        if (disposed || epoch !== generation) return;
      }
      const fragment = document.createDocumentFragment();
      for (const record of visible) {
        const section = element('details'), summary = element('summary', 'Borrador para recuperar');
        const text = element('p', record.draft || 'Sin texto'); text.style.whiteSpace = 'pre-wrap';
        const attachment = record.attachedWork ? element('p', 'Incluye material guardado en este iPhone.') : undefined;
        const append = element('button', 'Añadir al mensaje'); append.type = 'button';
        const discard = element('button', 'Descartar copia'); discard.type = 'button';
        const status = element('p'); status.setAttribute('role', 'status');
        let appended = false;
        append.addEventListener('click', () => void (async () => {
          append.disabled = true; discard.disabled = true;
          try {
            const current = (await options.store.list()).find(value => value.owner === record.owner);
            if (!current || !same(current, record)) { status.textContent = 'El borrador cambió; vuelve a revisarlo.'; return; }
            await options.append(current);
            appended = true;
            status.textContent = 'Añadido al mensaje. Revisa el contenido antes de enviarlo.';
          } catch { status.textContent = 'No pude añadir el borrador. La copia se conserva.'; }
          finally { append.disabled = appended; discard.disabled = false; }
        })());
        discard.addEventListener('click', () => void (async () => {
          if (!options.confirmDiscard()) return;
          append.disabled = true; discard.disabled = true;
          try {
            if (!await options.store.discard(record)) { status.textContent = 'El borrador cambió; vuelve a revisarlo.'; return; }
            await refresh();
          } catch { status.textContent = 'No pude descartar la copia. Se conserva para revisión.'; }
          finally { append.disabled = false; discard.disabled = false; }
        })());
        section.append(summary, text); if (attachment) section.append(attachment); section.append(append, discard, status); fragment.append(section);
      }
      if (disposed || epoch !== generation) return;
      root.replaceChildren(fragment); root.hidden = visible.length === 0;
    } catch {
      if (disposed || epoch !== generation) return;
      root.replaceChildren(element('p', 'No pude revisar los borradores guardados. Se conservan para revisión.')); root.hidden = false;
    }
  }
  return { refresh, destroy() { disposed = true; generation++; root.replaceChildren(); root.hidden = true; } };
}
