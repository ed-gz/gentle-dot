import {
  addWorkVersion, approveMinute, createWork, deleteWork, listWork, readWorkFile, readWorkFileInfo, readWorkFileSlice, reviseWork, validMinuteApproval, isImportedNotesVersion,
  WORK_LIMITS, type WorkItem, type WorkStatus,
} from './work-inbox.ts';
import { isTauri } from '@tauri-apps/api/core';
import { exportFileName, exportNativeFileRanges } from './file-export.ts';
import { parseWorkResult, type WorkResult } from '@gentle-dot/protocol';
import { cancelMinuteActionReview, deleteMinuteProposal, listMinuteProposals } from './minute-proposals.ts';
import { getConnection } from './external-connections.ts';

const statusLabels: Record<WorkStatus, string> = {
  local: 'Solo en este iPhone',
  prepared: 'Preparado · pendiente de revisión',
  approved: 'Aprobado · aún no enviado',
  sending: 'Envío pendiente de confirmar',
  sent: 'Entrega confirmada por Gentle Dot',
  uncertain: 'Entrega sin confirmar',
  failed: 'Envío fallido',
};

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(text: string): HTMLButtonElement {
  const element = node('button', text);
  element.type = 'button';
  return element;
}

function errorText(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (error.name === 'QuotaExceededError') return 'No queda espacio para guardar este trabajo. Elimina archivos o trabajos que ya no necesites.';
  if (error.message.startsWith('El trabajo cambió.')) return 'El trabajo cambió en otra vista. Recarga la bandeja y vuelve a revisar tus cambios.';
  if (error.message === 'El trabajo ya no existe.') return 'Este trabajo ya fue eliminado. Recarga la bandeja.';
  if (error.message === 'La bandeja local no está disponible.' || error.name === 'SecurityError') {
    return 'La bandeja local no está disponible. Comprueba que este iPhone permite guardar datos de Capri.';
  }
  const safeMessages = [
    'Máximo 10 archivos por trabajo.',
    'Adjunta archivos válidos.',
    'El nombre del archivo no es válido.',
    'Adjunta audio, texto, PDF o imágenes con un tipo de archivo reconocido.',
    'Cada archivo debe contener datos.',
    'Cada audio admite hasta 128 MiB; los demás archivos, hasta 25 MiB.',
    'Los archivos de un trabajo pueden sumar hasta 256 MiB.',
    'La bandeja admite 100 trabajos. Elimina uno antes de crear otro.',
    'Este trabajo ya tiene 100 versiones.',
    'La bandeja local no respondió.',
    'No hay espacio suficiente en este iPhone. Libera espacio y vuelve a intentarlo; los originales se conservan.',
    'La bandeja está ocupada. Cierra otras ventanas de Capri.',
  ];
  if (safeMessages.includes(error.message) || /^(Título|Instrucción|Versión): (de 1 a|máximo) \d+ caracteres\.$/.test(error.message)) {
    return error.message;
  }
  return fallback;
}

function dateLabel(timestamp: number): string {
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

function sizeLabel(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function timeLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), remainder = seconds % 60;
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

/** The host result is untrusted text. Cite its stored source without implying
 * that the user has approved the draft or that imported timecodes were verified. */
function renderMinute(result: WorkResult, item: WorkItem): HTMLElement {
  const content = node('div');
  content.append(node('p', result.minutes.title), node('p', result.minutes.summary));
  if (result.minutes.items.length) {
    const list = node('ul');
    const kinds = { agreement: 'Acuerdo', task: 'Pendiente', risk: 'Riesgo', question: 'Pregunta' } as const;
    const certainty = { confirmed: 'confirmado', proposal: 'propuesta', inference: 'inferencia' } as const;
    for (const entry of result.minutes.items) {
      const row = node('li');
      row.append(node('strong', `${kinds[entry.kind]} · ${certainty[entry.certainty]}`), node('p', entry.text));
      if (entry.owner !== null || entry.due !== null) row.append(node('p', [entry.owner !== null ? `Responsable: ${entry.owner}` : '', entry.due !== null ? `Fecha: ${entry.due}` : ''].filter(Boolean).join(' · '), 'hint'));
      const citations = node('details'); citations.append(node('summary', 'Ver evidencia'));
      for (const id of entry.evidenceIds) {
        const evidence = result.evidence.find(candidate => candidate.id === id);
        if (!evidence) continue;
        const file = item.files.find(candidate => candidate.id === evidence.fileId);
        const source = evidence.source === 'desktop-transcriber' ? 'Transcripción de la computadora' : 'Texto importado';
        const time = evidence.startMs !== undefined && evidence.endMs !== undefined ? ` · ${timeLabel(evidence.startMs)}–${timeLabel(evidence.endMs)}${evidence.source === 'imported-text' ? ' (tiempos declarados)' : ''}` : '';
        citations.append(node('p', `${source} · ${file?.name ?? 'archivo no disponible'}${time}`, 'hint'), node('p', evidence.text));
      }
      row.append(citations); list.append(row);
    }
    content.append(list);
  }
  if (result.transcriptComparison) {
    const comparison = node('details'); comparison.append(node('summary', 'Comparación de transcripciones'), node('p', result.transcriptComparison)); content.append(comparison);
  }
  return content;
}

export function mountInbox(onUse: (text: string) => void): { refresh(): Promise<void>; saveDraft(text: string): Promise<void>; openWork(id: string): Promise<void>; openAll(): Promise<void> } {
  const find = <T extends HTMLElement>(id: string) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Falta un elemento de la bandeja: ${id}`);
    return element as T;
  };
  const form = find<HTMLFormElement>('work-form');
  const title = find<HTMLInputElement>('work-title');
  const kind = find<HTMLSelectElement>('work-kind');
  const instruction = find<HTMLTextAreaElement>('work-instruction');
  const files = find<HTMLInputElement>('work-files');
  const status = find<HTMLElement>('work-status');
  const list = find<HTMLElement>('work-list');
  const count = find<HTMLElement>('work-count');
  const saveButton = find<HTMLButtonElement>('save-draft');
  const prompt = find<HTMLTextAreaElement>('prompt');
  let loadingRevision = 0;
  let selectedWork: string | undefined;
  let savingNew = false;
  const busyItems = new Set<string>();
  const downloadUrls = new Set<string>();

  function setSaving(saving: boolean) {
    savingNew = saving;
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input, button, select, textarea')) {
      control.disabled = saving;
    }
    form.setAttribute('aria-busy', String(saving));
    saveButton.disabled = saving;
  }

  function report(error: unknown, fallback: string) {
    status.textContent = errorText(error, fallback);
  }

  function useInstructions(text: string) {
    try {
      onUse(text);
      status.textContent = 'Instrucciones copiadas al mensaje. Revísalas y elige cuándo enviarlas.';
    } catch {
      status.textContent = 'No se pudieron cargar las instrucciones en la conversación.';
    }
  }

  async function download(item: WorkItem, file: WorkItem['files'][number], trigger: HTMLButtonElement) {
    trigger.disabled = true;
    try {
      if (isTauri()) {
        const info = await readWorkFileInfo(item.id, file.id);
        if (!info || info.size !== file.size) throw new Error('missing attachment');
        status.textContent = 'Preparando copia para Archivos…';
        const result = await exportNativeFileRanges({ size: file.size, read: (offset, length) => readWorkFileSlice(item.id, file.id, offset, length) }, exportFileName(file.name), { ...(info.sha256 ? { expectedSHA256: info.sha256 } : {}) });
        status.textContent = result.status === 'exported'
          ? 'Copia guardada en Archivos. El adjunto original se conserva en Capri.'
          : 'Exportación cancelada. El adjunto original se conserva en Capri.';
        return;
      }
      const blob = await readWorkFile(item.id, file.id);
      if (!blob) throw new Error('missing attachment');
      // Keep HTML/SVG attachments inert even if a browser ignores the download attribute.
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
      downloadUrls.add(url);
      const link = node('a');
      link.href = url;
      link.download = file.name.replace(/[\\/]/g, '_');
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 30_000);
      status.textContent = 'Archivo preparado para descargar. Comprueba el archivo guardado por el navegador.';
    } catch (error) {
      report(error, 'No se pudo recuperar el archivo de este iPhone.');
    } finally {
      trigger.disabled = false;
    }
  }

  async function changeItem(item: WorkItem, article: HTMLElement, action: () => Promise<unknown>, success: string) {
    if (busyItems.has(item.id)) return;
    busyItems.add(item.id);
    const controls = Array.from(article.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>('input, button, textarea'));
    const disabledBefore = controls.map(control => control.disabled);
    for (const control of controls) control.disabled = true;
    article.setAttribute('aria-busy', 'true');
    try {
      await action();
      status.textContent = success;
      await refresh();
    } catch (error) {
      report(error, 'No se pudo guardar el cambio. Tus datos anteriores siguen en la bandeja.');
    } finally {
      busyItems.delete(item.id);
      controls.forEach((control, index) => { control.disabled = disabledBefore[index] ?? false; });
      article.removeAttribute('aria-busy');
    }
  }

  function renderItem(item: WorkItem): HTMLElement {
    const article = node('article', undefined, 'work-item');
    article.dataset.workId = item.id;
    const heading = node('h3', item.title);
    const meta = node('p', `${item.kind === 'meeting' ? 'Reunión' : 'Solicitud'} · ${statusLabels[item.status] ?? 'Estado pendiente de revisar'} · ${dateLabel(item.updatedAt)}`, 'hint');
    const body = node('p', item.instruction || 'Sin instrucciones adicionales.');
    const actions = node('div', undefined, 'actions');
    const use = button('Usar instrucciones');
    use.disabled = !item.instruction.trim();
    use.addEventListener('click', () => useInstructions(item.instruction));
    actions.append(use);
    article.append(heading, meta, body, actions);

    if (item.minuteActionLock) article.append(node('p', 'Una acción de esta minuta sigue en revisión o sin confirmación. Puedes consultar y copiar la minuta. Contrasta el estado con el servicio; no se reenvía automáticamente.', 'hint'));
    if (item.status === 'sending' || item.status === 'uncertain') {
      article.append(node('p', 'La entrega anterior no está confirmada. La bandeja conserva este estado y no reintenta el envío.', 'hint'));
    }
    if (item.files.length) {
      const attachments = node('details');
      attachments.append(node('summary', `Archivos (${item.files.length})`));
      const fileList = node('ul');
      for (const file of item.files) {
        const row = node('li');
        const downloadButton = button(`Descargar ${file.name} · ${sizeLabel(file.size)}`);
        downloadButton.addEventListener('click', () => { void download(item, file, downloadButton); });
        row.append(downloadButton);
        fileList.append(row);
      }
      attachments.append(fileList);
      article.append(attachments);
    }

    if (item.result) {
      const current = parseWorkResult(item.result);
      const history = item.resultHistory === undefined ? [] : Array.isArray(item.resultHistory) && item.resultHistory.length <= WORK_LIMITS.resultHistory ? item.resultHistory.map(parseWorkResult) : undefined;
      if (current && history && history.every(Boolean)) {
        const drafts = [...history as WorkResult[], current];
        const minutes = node('details');
        const resultApproved = validMinuteApproval(item) && item.minuteApproval?.kind === 'result';
        minutes.append(node('summary', drafts.length === 1 ? `Minuta · ${resultApproved ? 'aprobada en este iPhone' : 'pendiente de revisión'}` : `Minutas (${drafts.length}) · ${resultApproved ? 'última aprobada en este iPhone' : 'pendientes de revisión'}`));
        let rendered = false;
        minutes.addEventListener('toggle', () => {
          if (!minutes.open || rendered) return;
          rendered = true;
          for (const [index, draft] of drafts.entries()) {
            const version = node('details');
            let when = 'fecha no disponible';
            try { when = dateLabel(draft.createdAt); } catch { /* Keep malformed dates from hiding the stored draft. */ }
            version.append(node('summary', `Borrador ${index + 1} · ${when}`));
            let built = false;
            version.addEventListener('toggle', () => {
              if (!version.open || built) return;
              built = true; version.append(renderMinute(draft, item));
              if (index === drafts.length - 1 && item.kind === 'meeting' && item.status === 'sent' && item.transfer?.receipt) {
                if (resultApproved) version.append(node('p', 'Aprobada en este iPhone. Esto no envía ni autoriza acciones externas.', 'hint'));
                else {
                  const approve = button('Aprobar esta minuta');
                  approve.addEventListener('click', () => { void changeItem(item, article, () => approveMinute(item.id, item.revision, 'result'), 'Minuta aprobada en este iPhone. Ninguna acción externa fue autorizada.'); });
                  version.append(approve);
                }
              }
            });
            minutes.append(version);
          }
        });
        article.append(minutes);
      } else article.append(node('p', 'No se pudo leer la minuta guardada. Los datos originales se conservan.', 'hint'));
    }

    if (item.versions.length) {
      const versions = node('details');
      versions.append(node('summary', `Versiones guardadas (${item.versions.length})`));
      for (const [index, version] of item.versions.entries()) {
        const detail = node('details');
        const text = node('p');
        detail.append(node('summary', `${isImportedNotesVersion(version) ? 'Notas importadas' : `Versión ${index + 1}`} · ${dateLabel(version.createdAt)}`), text);
        detail.addEventListener('toggle', () => { text.textContent = detail.open ? version.text : ''; });
        if (item.kind === 'meeting' && item.result && !isImportedNotesVersion(version) && item.status !== 'sent' && item.status !== 'sending' && index === item.versions.length - 1) {
          if (validMinuteApproval(item) && item.minuteApproval?.kind === 'version') detail.append(node('p', 'Versión aprobada en este iPhone. Esto no envía ni autoriza acciones externas.', 'hint'));
          else {
            const approve = button('Aprobar esta versión');
            approve.addEventListener('click', () => { void changeItem(item, article, () => approveMinute(item.id, item.revision, 'version', version.id), 'Versión aprobada en este iPhone. Ninguna acción externa fue autorizada.'); });
            detail.append(approve);
          }
        }
        versions.append(detail);
      }
      article.append(versions);
    }

    if (item.kind === 'meeting' && item.result) {
      // Proposals are local drafts. Loading them never connects to a service.
      void listMinuteProposals(item.id).then(async proposals => {
        if (!article.isConnected || !proposals.length) return;
        const details = node('details'); details.append(node('summary', `Acciones propuestas (${proposals.length})`));
        for (const proposal of proposals) {
          const row = node('div');
          let label = 'Servicio no disponible';
          try { label = (await getConnection(proposal.connectionId))?.label ?? label; } catch { /* Keep the proposal visible if settings cannot be read. */ }
          const actionState = proposal.state === 'responded' ? 'respuesta del servicio recibida' : proposal.state === 'uncertain' ? 'resultado sin confirmar' : proposal.state === 'executing' ? 'ejecución sin confirmar' : proposal.state === 'reviewing' ? 'revisión en curso' : 'acción sin aprobar';
          row.append(node('strong', proposal.description), node('p', `${label} · ${proposal.current ? 'Minuta vigente al consultar' : 'Vigencia sin confirmar'} · ${actionState}`, 'hint'));
          const content = node('details'), preview = node('pre', proposal.argumentsJSON); preview.style.whiteSpace = 'pre-wrap'; preview.style.overflowWrap = 'anywhere';
          content.append(node('summary', 'Ver contenido propuesto'), preview);
          const removeProposal = button('Eliminar propuesta'); removeProposal.disabled = Boolean(item.minuteActionLock) || proposal.state === 'uncertain' || proposal.state === 'executing' || proposal.state === 'reviewing';
          removeProposal.addEventListener('click', () => {
            if (!window.confirm('¿Eliminar esta propuesta local? La minuta y los servicios no se modificarán.')) return;
            removeProposal.disabled = true;
            void deleteMinuteProposal(proposal.id, item.id).then(() => { row.remove(); if (details.querySelectorAll('div').length === 0) details.remove(); status.textContent = 'Propuesta eliminada de este iPhone.'; }).catch(() => { status.textContent = 'No se pudo eliminar la propuesta.'; removeProposal.disabled = false; });
          });
          row.append(content, removeProposal);
          if (proposal.state === 'reviewing' && item.minuteActionLock?.proposalId === proposal.id) {
            const cancelReview = button('Cancelar revisión pendiente');
            cancelReview.addEventListener('click', () => {
              cancelReview.disabled = true;
              void cancelMinuteActionReview(item.id, proposal.id, item.minuteActionLock!.leaseId).then(async () => { status.textContent = 'Revisión cancelada. La acción no fue enviada.'; await refresh(); }).catch(() => { status.textContent = 'No se pudo confirmar la cancelación. Revisa el estado antes de continuar.'; cancelReview.disabled = false; });
            });
            row.append(cancelReview);
          }
          details.append(row);
        }
        if (article.isConnected) article.append(details);
      }).catch(() => { if (article.isConnected) article.append(node('p', 'No se pudieron leer las acciones propuestas.', 'hint')); });
    }

    if (item.status !== 'sending' && item.status !== 'sent') {
      const edit = node('details');
      edit.append(node('summary', 'Editar instrucciones'));
      const editForm = node('form');
      const label = node('label', 'Instrucciones de este trabajo');
      const input = node('textarea');
      input.rows = 4;
      input.maxLength = WORK_LIMITS.instruction;
      input.value = item.instruction;
      label.append(input);
      const save = node('button', 'Guardar instrucciones');
      save.type = 'submit';
      editForm.append(label, node('p', 'El cambio se guarda en este iPhone y requiere una nueva revisión antes de enviarse.', 'hint'), save);
      editForm.addEventListener('submit', event => {
        event.preventDefault();
        void changeItem(item, article, () => reviseWork(item.id, item.revision, input.value), 'Instrucciones actualizadas en este iPhone.');
      });
      edit.append(editForm);
      article.append(edit);

      const versionEditor = node('details');
      versionEditor.append(node('summary', 'Guardar una versión de texto'));
      const versionForm = node('form');
      const versionLabel = node('label', 'Borrador, transcripción o resultado');
      const versionInput = node('textarea');
      versionInput.rows = 4;
      versionInput.required = true;
      versionInput.maxLength = WORK_LIMITS.versionText;
      versionLabel.append(versionInput);
      const versionSave = node('button', 'Guardar versión');
      versionSave.type = 'submit';
      versionSave.disabled = item.versions.length >= WORK_LIMITS.versions;
      versionForm.append(versionLabel, node('p', 'Conserva las versiones anteriores. Esta acción no genera ni envía una respuesta.', 'hint'), versionSave);
      versionForm.addEventListener('submit', event => {
        event.preventDefault();
        void changeItem(item, article, () => addWorkVersion(item.id, item.revision, versionInput.value), 'Nueva versión guardada en este iPhone.');
      });
      versionEditor.append(versionForm);
      article.append(versionEditor);
    }

    if (item.status !== 'sending') {
      const remove = button('Eliminar');
      const confirmation = node('div', undefined, 'surface');
      confirmation.hidden = true;
      const draftCount = item.result ? 1 + (Array.isArray(item.resultHistory) ? item.resultHistory.length : 0) : 0;
      const warning = node('p', `Eliminar “${item.title}” de este iPhone también borrará sus ${item.files.length} archivos, ${item.versions.length} versiones de texto y ${draftCount} minutas. Esta acción no se puede deshacer.`);
      const confirmActions = node('div', undefined, 'actions');
      const confirm = button('Confirmar eliminación');
      confirm.setAttribute('aria-label', `Confirmar eliminación de ${item.title}`);
      const cancel = button('Conservar trabajo');
      confirmActions.append(confirm, cancel);
      confirmation.append(warning, confirmActions);
      remove.addEventListener('click', () => { confirmation.hidden = false; confirm.focus(); });
      cancel.addEventListener('click', () => { confirmation.hidden = true; remove.focus(); });
      confirm.addEventListener('click', () => {
        void changeItem(item, article, () => deleteWork(item.id, item.revision), 'Trabajo, archivos y versiones eliminados de este iPhone.');
      });
      actions.append(remove);
      article.append(confirmation);
    }
    return article;
  }

  async function refresh(): Promise<void> {
    const revision = ++loadingRevision;
    list.setAttribute('aria-busy', 'true');
    try {
      const items = await listWork();
      if (revision !== loadingRevision) return;
      const content = document.createDocumentFragment();
      if (selectedWork) {
        content.append(node('h1', 'Material guardado'));
        const selected = items.find(item => item.id === selectedWork);
        if (selected) content.append(renderItem(selected));
        else content.append(node('p', 'El material seleccionado ya no está disponible en el iPhone.', 'hint'));
        const remaining = items.filter(item => item.id !== selectedWork);
        if (remaining.length) {
          content.append(node('h2', 'Otros trabajos guardados'));
          for (const item of remaining) content.append(renderItem(item));
        }
      } else {
        if (!items.length) content.append(node('p', 'Aún no tienes trabajos. Puedes crear uno aquí, guardar el texto que estás escribiendo o compartir material con Capri.', 'hint'));
        for (const item of items) content.append(renderItem(item));
      }
      list.replaceChildren(content);
      count.textContent = String(items.length);
      count.setAttribute('aria-label', `${items.length} trabajos guardados`);
    } catch (error) {
      if (revision === loadingRevision) report(error, 'No se pudo actualizar la bandeja. Vuelve a intentarlo antes de editar tus trabajos.');
    } finally {
      if (revision === loadingRevision) list.removeAttribute('aria-busy');
    }
  }

  async function saveDraft(text: string): Promise<void> {
    if (savingNew) return;
    if (!text.trim()) {
      status.textContent = 'Escribe instrucciones en la conversación antes de guardarlas.';
      saveButton.textContent = 'Escribe un mensaje primero';
      prompt.focus();
      return;
    }
    setSaving(true);
    saveButton.textContent = 'Guardando…';
    try {
      const trimmed = text.trim();
      const draftTitle = (trimmed.split(/\r?\n/, 1)[0] ?? trimmed).slice(0, WORK_LIMITS.title);
      await createWork({ title: draftTitle, kind: 'task', instruction: trimmed });
      status.textContent = 'Instrucciones guardadas en este iPhone. Puedes encontrarlas en Trabajos.';
      saveButton.textContent = 'Guardado en Trabajos';
      await refresh();
    } catch (error) {
      report(error, 'No se pudo guardar el trabajo. El mensaje sigue en la conversación.');
      saveButton.textContent = 'No se guardó · reintentar';
    } finally {
      setSaving(false);
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (savingNew) return;
    const input = { title: title.value, kind: kind.value as WorkItem['kind'], instruction: instruction.value, files: Array.from(files.files ?? []) };
    setSaving(true);
    status.textContent = 'Guardando en este iPhone…';
    void (async () => {
      try {
        await createWork(input);
        form.reset();
        status.textContent = 'Trabajo guardado en este iPhone. Puedes abrir sus instrucciones y archivos abajo.';
        await refresh();
      } catch (error) {
        report(error, 'No se pudo guardar el trabajo. Revisa los datos y vuelve a intentarlo.');
      } finally {
        setSaving(false);
      }
    })();
  });
  saveButton.addEventListener('click', () => { void saveDraft(prompt.value); });
  prompt.addEventListener('input', () => { if (!savingNew) saveButton.textContent = 'Guardar el texto del mensaje como trabajo'; });
  window.addEventListener('pagehide', () => {
    for (const url of downloadUrls) URL.revokeObjectURL(url);
    downloadUrls.clear();
  });
  void refresh();
  return {
    refresh, saveDraft,
    openWork(id) { selectedWork = id; document.getElementById('panel-inbox')!.dataset.contextual = 'true'; return refresh(); },
    openAll() { selectedWork = undefined; delete document.getElementById('panel-inbox')!.dataset.contextual; return refresh(); },
  };
}
