import { isTauri } from '@tauri-apps/api/core';
import { exportFileName, exportNativeFile } from './file-export.ts';
import { conversationArchive, archiveScope } from './conversation-archive.ts';
import type { ChatEntry } from './conversation.ts';
import type { PersistenceStatus } from './conversation-persistence.ts';

/** Local archive controls live in Archivo; model retrieval is provided separately. */
export function mountMemoryView(options: { status(): PersistenceStatus; pending(): ChatEntry[]; visible(): ChatEntry[]; draft(): string; retry(): Promise<void> }) {
  const parent = document.getElementById('panel-inbox');
  if (!parent) throw new Error('Falta la sección Archivo.');
  const root = document.createElement('section'); root.className = 'settings-section'; root.id = 'conversation-memory';
  root.innerHTML = `<h2>Historial de conversación</h2><p class="hint">Busca o exporta los mensajes que Capri guardó en este iPhone, incluidos los que ya no aparecen en la conversación. Esto no confirma que el historial de la laptop esté sincronizado.</p><p id="memory-status" class="hint" role="status" aria-live="polite"></p><div class="actions"><button id="memory-retry" type="button" hidden>Reintentar guardado</button><button id="memory-export" type="button">Exportar historial</button></div><details><summary>Consultar mensajes anteriores</summary><p class="hint">Los registros parecidos pueden ser eventos distintos o copias. Capri los conserva por separado.</p><form id="memory-search"><label>Buscar texto<input id="memory-query" maxlength="200" placeholder="Palabras del mensaje" /></label><button type="submit">Buscar</button></form><div id="memory-entries"></div><button id="memory-older" type="button" hidden>Ver anteriores</button></details>`;
  parent.append(root);
  const element = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  const statusElement = element('memory-status'); let cursor: string | undefined, query = '', busy = false, pendingReset = false, renderEpoch = 0, exporting = false, exportResult = '';
  const describe = (error: unknown) => error instanceof Error ? error.message : 'No se pudo consultar el archivo.';
  function updateStatus(message?: string, exportUpdate = false) {
    const state = options.status();
    element('memory-retry').hidden = !state.blocked && !state.pending;
    if (exporting && !exportUpdate) return;
    if (exportResult && !exportUpdate) {
      statusElement.textContent = exportResult + (state.blocked ? ' El guardado local sigue sin confirmarse.' : '');
      return;
    }
    statusElement.textContent = message ?? (state.blocked ? `No se confirmó el guardado. ${state.archiveError ?? state.conversationError} ${state.pending} mensajes pendientes en memoria. Reintenta o exporta antes de cerrar Capri. Los envíos están detenidos.` : state.pending ? `${state.pending} mensajes pendientes de guardar en el archivo local.` : 'Archivo local disponible. Exportar no borra los mensajes.');
  }
  async function refresh() {
    const epoch = ++renderEpoch;
    try {
      const stats = await conversationArchive.stats();
      if (epoch !== renderEpoch) return;
      if (options.status().blocked || options.status().pending) updateStatus();
      else updateStatus(`${stats.entries} mensajes · ${(stats.bytes / 1024 / 1024).toFixed(2)} MiB locales. Límite: ${stats.maximumEntries} mensajes / ${stats.maximumBytes / 1024 / 1024} MiB. No se borran automáticamente.`);
    } catch (error) { if (epoch === renderEpoch) updateStatus(describe(error)); }
  }
  async function page(reset: boolean) {
    if (busy) { if (reset) pendingReset = true; return; } busy = true;
    try {
      if (reset) { cursor = undefined; query = element<HTMLInputElement>('memory-query').value.trim(); element('memory-entries').replaceChildren(); }
      const result = query ? await conversationArchive.search(query, { cursor, limit: 20 }) : await conversationArchive.page({ cursor, limit: 20 });
      const nodes = result.entries.map(entry => {
        const article = document.createElement('article'); article.className = 'chat-card';
        const label = document.createElement('p'); label.className = 'hint'; label.textContent = `${new Date(entry.at).toLocaleString('es-MX')} · ${entry.engine === 'iphone' ? 'iPhone' : 'Gentle Dot'} · ${entry.role} · ${entry.state}`;
        const body = document.createElement('p'); body.textContent = entry.text;
        const details = document.createElement('details');
        const summary = document.createElement('summary'); summary.textContent = 'Detalles de origen';
        const source = document.createElement('small'); source.textContent = `Origen: ${entry.scope}\nIdentificador: ${entry.id}`; source.style.whiteSpace = 'pre-wrap';
        details.append(summary, source); article.append(label, body, details); return article;
      });
      element('memory-entries').prepend(...nodes); cursor = result.cursor;
      element('memory-older').hidden = !result.hasMore;
      if (!nodes.length) updateStatus(result.hasMore ? 'Esta página no contiene coincidencias; puedes seguir buscando en los mensajes anteriores.' : 'No hay más mensajes que coincidan.');
    } catch (error) { updateStatus(describe(error)); }
    finally { busy = false; if (pendingReset) { pendingReset = false; void page(true); } }
  }
  element('memory-retry').addEventListener('click', async () => { exportResult = ''; await options.retry(); await refresh(); });
  element('memory-search').addEventListener('submit', event => { event.preventDefault(); exportResult = ''; void page(true); });
  element('memory-older').addEventListener('click', () => { exportResult = ''; void page(false); });
  root.querySelector('details')!.addEventListener('toggle', event => { if ((event.target as HTMLDetailsElement).open && !element('memory-entries').children.length) void page(true); });
  element('memory-export').addEventListener('click', async () => {
    const button = element<HTMLButtonElement>('memory-export'); button.disabled = true; exporting = true; exportResult = '';
    updateStatus('Preparando copia del historial…', true);
    try {
      // Capture before any asynchronous storage operation. Export must remain
      // available even when a prior write or its callback is stuck.
      const state = options.status(), pending = structuredClone(options.pending()), visible = structuredClone(options.visible()), draft = options.draft();
      const chunks: BlobPart[] = []; let archiveFailed = false, timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const archive = await Promise.race([conversationArchive.export(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('El archivo local no respondió.')), 2000);
        })]);
        chunks.push(archive.blob);
      } catch {
        archiveFailed = true;
        chunks.push(JSON.stringify({ schema: 'capri-conversation-rescue/v1', archiveAvailable: false, error: 'No se pudo leer el archivo local.', exportedAt: Date.now() }) + '\n');
      } finally { clearTimeout(timer); }
      // Do not collapse different snapshots merely because their IDs match.
      // Transport wrappers are private and are never part of this projection.
      const copies = archiveFailed || state.blocked || pending.length ? [...pending, ...visible] : [];
      const unique = new Map<string, string>();
      for (const entry of copies) {
        const record = JSON.stringify({ id: entry.id, scope: archiveScope(entry), engine: entry.engine, role: entry.role, state: entry.state, text: entry.text, at: entry.at,
          ...(entry.replyTo ? { replyTo: entry.replyTo } : {}), ...(entry.localCancelled ? { localCancelled: true } : {}),
          ...(entry.activities ? { activities: entry.activities.map(activity => ({ id: activity.id, kind: activity.kind, title: activity.title, status: activity.status, detail: activity.detail })) } : {}) });
        unique.set(record, record);
      }
      if (unique.size) {
        chunks.push(JSON.stringify({ schema: 'capri-conversation-pending/v1', committed: false, source: 'visible-and-pending-rescue', entries: unique.size }) + '\n');
        for (const record of unique.values()) chunks.push(record + '\n');
      }
      if (draft) chunks.push(JSON.stringify({ schema: 'capri-conversation-draft/v1', source: 'visible-draft', submitted: false, text: draft }) + '\n');
      if (archiveFailed && !unique.size && !draft) throw new Error('El archivo no está disponible y no hay mensajes pendientes para rescatar. No se exportó un historial vacío.');
      const blob = new Blob(chunks, { type: 'application/x-ndjson' });
      const name = exportFileName(`capri-conversacion-${new Date().toISOString().slice(0,10)}.ndjson`);
      if (isTauri()) {
        updateStatus('Preparando copia del historial para Archivos…', true);
        const result = await exportNativeFile(blob, name);
        updateStatus(result.status === 'cancelled' ? 'Exportación cancelada. No se borró contenido de Capri.' : archiveFailed
          ? 'Copia parcial guardada en Archivos con el contenido visible y pendiente. El archivo guardado no pudo incluirse; no se borró contenido de Capri.'
          : unique.size ? 'Copia guardada en Archivos con el historial y las copias visibles o pendientes sin confirmar. No se borró contenido de Capri.'
          : 'Copia del historial guardada en Archivos. El historial y el borrador originales se conservan en Capri.', true);
        return;
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      updateStatus(archiveFailed ? 'Exportación parcial preparada con el contenido visible y pendiente; el archivo guardado no pudo incluirse. Comprueba el archivo descargado.'
        : unique.size ? 'Exportación preparada con el historial y las copias visibles o pendientes sin confirmar. Comprueba el archivo descargado.'
        : 'Exportación preparada. Comprueba el archivo descargado; el historial local se conserva.', true);
    } catch (error) { updateStatus(`No se confirmó la exportación: ${describe(error)} No se borró contenido de Capri.`, true); }
    finally { exporting = false; exportResult = statusElement.textContent ?? ''; button.disabled = false; }
  });
  return { refresh, updateStatus };
}
