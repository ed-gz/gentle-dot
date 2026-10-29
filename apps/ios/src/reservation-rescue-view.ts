import { isTauri } from '@tauri-apps/api/core';
import { exportNativeFile } from './file-export.ts';
import type { ConversationJournal } from './conversation-journal.ts';
import type { ChatEntry } from './conversation.ts';

/** Export an unconfirmed reservation without its private transport wrapper.
 * This never modifies the reservation or claims an archive/host ACK. */
export function reservationRescueBlob(journal: ConversationJournal): Blob {
  const clean = (entry: ChatEntry) => ({ id: entry.id, engine: entry.engine, role: entry.role, state: entry.state, text: entry.text, at: entry.at,
    ...(entry.replyTo ? { replyTo: entry.replyTo } : {}), ...(entry.localCancelled ? { localCancelled: true } : {}),
    ...(entry.activities ? { activities: entry.activities.map(({ id, title, kind, status, detail }) => ({ id, title, kind, status, ...(detail === undefined ? {} : { detail }) })) } : {}) });
  const lines = [JSON.stringify({ schema: 'capri-conversation-reservation-rescue/v1', committed: false,
    baseRevision: journal.baseRevision, revision: journal.revision, visibleEntries: journal.snapshot.entries.length, pendingEntries: journal.pending.length }),
    JSON.stringify({ schema: 'capri-conversation-draft/v1', source: 'unconfirmed-reservation', submitted: false, text: journal.snapshot.draft,
      ...(journal.snapshot.attachedWork ? { attachedWork: journal.snapshot.attachedWork } : {}) }),
    ...journal.snapshot.entries.map(entry => JSON.stringify({ source: 'reserved-window', ...clean(entry) })),
    ...journal.pending.map(entry => JSON.stringify({ source: 'pending-archive-write', ...clean(entry) }))];
  return new Blob([lines.join('\n'), '\n'], { type: 'application/x-ndjson' });
}

async function deliver(blob: Blob): Promise<'exported' | 'cancelled' | 'prepared'> {
  const name = 'capri-reserva-recuperacion.ndjson';
  if (isTauri()) return (await exportNativeFile(blob, name)).status;
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'prepared';
}

export function mountReservationRescue(root: HTMLElement, options: {
  pending(): Promise<ConversationJournal | undefined>;
  deliver?(blob: Blob): Promise<'exported' | 'cancelled' | 'prepared'>;
}) {
  let visible: ConversationJournal | undefined, busy = false;
  const button = document.createElement('button'), status = document.createElement('p');
  button.type = 'button'; button.textContent = 'Exportar reserva pendiente';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  root.append(button, status); root.hidden = true;
  button.addEventListener('click', () => void (async () => {
    if (!visible || busy) return;
    const expected = structuredClone(visible); busy = true; button.disabled = true; status.textContent = 'Preparando copia…';
    try {
      const current = await options.pending();
      if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
        status.textContent = 'La reserva cambió. Reintenta la recuperación antes de exportar.'; return;
      }
      const result = await (options.deliver ?? deliver)(reservationRescueBlob(current));
      status.textContent = result === 'exported' ? 'Copia guardada en Archivos. La reserva se conserva.'
        : result === 'cancelled' ? 'Exportación cancelada. La reserva se conserva.'
        : 'Copia preparada. Comprueba la descarga; la reserva se conserva.';
    } catch { status.textContent = 'No pude confirmar la exportación. La reserva se conserva.'; }
    finally { busy = false; button.disabled = false; }
  })());
  return {
    show(journal: ConversationJournal) { visible = structuredClone(journal); root.hidden = false; status.textContent = ''; },
    clear() { visible = undefined; root.hidden = true; status.textContent = ''; },
  };
}
