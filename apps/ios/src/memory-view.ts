import { conversationArchive, archiveScope } from './conversation-archive.ts';
import type { ChatEntry } from './conversation.ts';
import type { PersistenceStatus } from './conversation-persistence.ts';

/** Local archive controls live in Archivo; model retrieval is provided separately. */
export function mountMemoryView(options: { status(): PersistenceStatus; pending(): ChatEntry[]; visible(): ChatEntry[]; draft(): string; retry(): Promise<void> }) {
  const parent = document.getElementById('panel-inbox');
  if (!parent) throw new Error('Falta la sección Archivo.');
  const root = document.createElement('section'); root.className = 'settings-section'; root.id = 'conversation-memory';
  root.innerHTML = `<h2>Historial local</h2><p class="hint">Tu conversación se conserva en este iPhone aunque la vista muestre sólo los últimos 120 mensajes. No confirma una sincronización con la laptop.</p><p id="memory-status" class="hint" role="status" aria-live="polite"></p><div class="actions"><button id="memory-retry" type="button">Reintentar guardado</button><button id="memory-export" type="button">Exportar historial</button></div><details><summary>Consultar mensajes anteriores</summary><form id="memory-search"><label>Buscar texto<input id="memory-query" maxlength="200" placeholder="Palabras del mensaje" /></label><button type="submit">Buscar</button></form><div id="memory-entries"></div><button id="memory-older" type="button" hidden>Ver anteriores</button></details>`;
  parent.append(root);
  const element = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  const statusElement = element('memory-status'); let cursor: string | undefined, query = '', busy = false, renderEpoch = 0;
  const describe = (error: unknown) => error instanceof Error ? error.message : 'No se pudo consultar el archivo.';
  function updateStatus(message?: string) {
    const state = options.status();
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
    if (busy) return; busy = true;
    try {
      if (reset) { cursor = undefined; query = element<HTMLInputElement>('memory-query').value.trim(); element('memory-entries').replaceChildren(); }
      const result = query ? await conversationArchive.search(query, { cursor, limit: 20 }) : await conversationArchive.page({ cursor, limit: 20 });
      const nodes = result.entries.map(entry => {
        const article = document.createElement('article'); article.className = 'chat-card';
        const label = document.createElement('p'); label.className = 'hint'; label.textContent = `${new Date(entry.at).toLocaleString('es-MX')} · ${entry.engine === 'iphone' ? 'iPhone' : 'Gentle Dot'} · ${entry.role} · ${entry.state}`;
        const body = document.createElement('p'); body.textContent = entry.text;
        const source = document.createElement('small'); source.textContent = entry.scope;
        article.append(label, body, source); return article;
      });
      element('memory-entries').prepend(...nodes); cursor = result.cursor;
      element('memory-older').hidden = !result.hasMore;
      if (!nodes.length) updateStatus(result.hasMore ? 'Esta página no contiene coincidencias; puedes seguir buscando en los mensajes anteriores.' : 'No hay más mensajes que coincidan.');
    } catch (error) { updateStatus(describe(error)); }
    finally { busy = false; }
  }
  element('memory-retry').addEventListener('click', async () => { await options.retry(); await refresh(); });
  element('memory-search').addEventListener('submit', event => { event.preventDefault(); void page(true); });
  element('memory-older').addEventListener('click', () => void page(false));
  root.querySelector('details')!.addEventListener('toggle', event => { if ((event.target as HTMLDetailsElement).open && !element('memory-entries').children.length) void page(true); });
  element('memory-export').addEventListener('click', async () => {
    const button = element<HTMLButtonElement>('memory-export'); button.disabled = true;
    try {
      await options.retry();
      let pending = options.pending(); const draft = options.draft(); const chunks: BlobPart[] = []; let archiveFailed = false;
      try { chunks.push((await conversationArchive.export()).blob); }
      catch (error) { archiveFailed = true; pending = [...new Map([...options.visible(), ...pending].map(entry => [JSON.stringify([entry.engine, entry.id]), entry])).values()]; chunks.push(JSON.stringify({ schema: 'capri-conversation-rescue/v1', archiveAvailable: false, error: describe(error), exportedAt: Date.now() }) + '\n'); }
      // Pending entries are explicitly distinguished from records confirmed by IndexedDB.
      if (pending.length) {
        chunks.push(JSON.stringify({ schema: 'capri-conversation-pending/v1', committed: false, source: archiveFailed ? 'visible-and-pending-rescue' : 'pending-archive-write', entries: pending.length }) + '\n');
        for (const entry of pending) chunks.push(JSON.stringify({ id: entry.id, scope: archiveScope(entry), engine: entry.engine, role: entry.role, state: entry.state, text: entry.text, at: entry.at,
          ...(entry.activities ? { activities: entry.activities.map(activity => ({ id: activity.id, kind: activity.kind, title: activity.title, status: activity.status, detail: activity.detail })) } : {}) }) + '\n');
      }
      if (draft) chunks.push(JSON.stringify({ schema: 'capri-conversation-draft/v1', source: 'visible-draft', submitted: false, text: draft }) + '\n');
      if (archiveFailed && !pending.length && !draft) throw new Error('El archivo no está disponible y no hay mensajes pendientes para rescatar. No se exportó un historial vacío.');
      const url = URL.createObjectURL(new Blob(chunks, { type: 'application/x-ndjson' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `capri-conversacion-${new Date().toISOString().slice(0,10)}.ndjson`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      updateStatus(archiveFailed ? 'Exportación parcial preparada con el contenido visible y pendiente; el archivo guardado no pudo incluirse. Comprueba el archivo descargado.' : 'Exportación preparada. Comprueba el archivo descargado; el historial local se conserva.');
    } catch (error) { updateStatus(describe(error)); }
    finally { button.disabled = false; }
  });
  return { refresh, updateStatus };
}
