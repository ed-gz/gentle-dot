import { askSnapshot } from './linked-chat.ts';
import type { Ask } from '@gentle-dot/protocol';
import type { ToolApprovalRequest } from './agent-tools.ts';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
  const element = document.createElement(tag); element.textContent = text; return element;
};
export function createConversationRequests(container: HTMLElement, options: { append?: (section: HTMLElement, mutate: () => void) => void } = {}) {
  const announcement = node('p'); announcement.className = 'sr-only'; announcement.setAttribute('role', 'status');
  container.append(announcement);
  const hostCards = new Map<string, { card: HTMLElement; sent: boolean; ask: Ask }>();
  let connected = false;
  function card(title: string, details: string) {
    const section = node('section'); section.className = 'review-card';
    const eyebrow = node('span', 'CAPRI / NECESITO TU REVISIÓN'); eyebrow.className = 'eyebrow';
    section.append(eyebrow, node('h3', title));
    if (details) { const preview = node('pre', details); preview.tabIndex = 0; section.append(preview); }
    const actions = node('div'); actions.className = 'actions';
    const status = node('p'); status.className = 'hint'; status.setAttribute('role', 'status');
    section.append(actions, status);
    const append = () => { container.append(section); announcement.textContent = `Capri necesita tu revisión: ${title}`; };
    const mount = () => { if (options.append) options.append(section, append); else append(); };
    return { section, actions, status, mount };
  }
  function button(label: string, action: () => void) {
    const element = node('button', label); element.type = 'button'; element.addEventListener('click', action); return element;
  }
  return {
    approve(request: ToolApprovalRequest, signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) return Promise.resolve(false);
      // Only this human interaction can resolve approval; model output has no path here.
      const view = card(request.title, request.details);
      return new Promise(resolve => {
        let settled = false;
        const finish = (approved: boolean) => {
          if (settled) return; settled = true;
          signal.removeEventListener('abort', abort);
          view.actions.replaceChildren();
          view.status.textContent = approved ? 'Aprobaste esta operación y este contenido.' : 'Operación no autorizada.';
          resolve(approved);
        };
        const abort = () => finish(false);
        signal.addEventListener('abort', abort, { once: true });
        const approve = button('Aprobar esta operación', () => finish(true)); approve.className = 'primary';
        view.actions.append(button('Rechazar', () => finish(false)), approve);
        view.mount();
      });
    },
    host(ask: Ask, send: (fields: { value?: string; confirmed?: boolean; cancelled?: boolean }) => boolean | Promise<{ confirmed: true }>, trusted = false) {
      const previous = hostCards.get(ask.requestId);
      if (previous && askSnapshot(previous.ask) === askSnapshot(ask)) return;
      if (previous) {
        previous.card.querySelector('.actions')?.replaceChildren();
        const status = previous.card.querySelector('[role="status"]'); if (status) status.textContent = 'La solicitud cambió. Revisa la versión actual debajo.';
      }
      const view = card(ask.title, ask.message ?? '');
      const state = { card: view.section, sent: false, ask }; hostCards.set(ask.requestId, state);
      const expired = () => ask.expiresAt !== undefined && (!Number.isFinite(Date.parse(ask.expiresAt)) || Date.parse(ask.expiresAt) <= Date.now());
      const answer = async (fields: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
        if (!connected || hostCards.get(ask.requestId) !== state || state.sent || expired()) { view.status.textContent = 'La solicitud perdió vigencia o conexión. Revisa el estado del host.'; return; }
        state.sent = true;
        for (const control of view.section.querySelectorAll<HTMLButtonElement>('button')) control.disabled = true;
        try {
          const sent = await send(fields);
          if (!sent) throw new Error('No se pudo enviar tu respuesta.');
          view.status.textContent = typeof sent === 'object' ? 'Decisión recibida por el host. La operación continuará con su propio estado.' : 'Respuesta enviada; esperando confirmación del host.';
        } catch (error) {
          view.status.textContent = error instanceof Error ? error.message : 'Respuesta sin confirmar. Consulta la solicitud antes de repetirla.';
          // No automatic retry after a possibly delivered decision.
        }
      };
      if (ask.method === 'confirm' || (ask.method === 'app' && trusted)) {
        const approve = button('Permitir', () => answer({ confirmed: true })); approve.className = 'primary';
        view.actions.append(button('Rechazar', () => answer({ confirmed: false })), approve);
      }
      else if (ask.method === 'select') for (const option of ask.options ?? []) view.actions.append(button(option, () => answer({ value: option })));
      else if (ask.method === 'input' || ask.method === 'editor') {
        const input = node('textarea'); input.value = ask.prefill ?? ''; input.maxLength = 32000; input.setAttribute('aria-label', ask.title);
        view.actions.append(input, button('Responder', () => answer({ value: input.value })));
      } else {
        view.status.textContent = ask.method === 'app' ? 'Esta autorización requiere el canal del dispositivo vinculado. Por ahora revísala en Gentle Dot.' : 'Esta autorización requiere el PIN del servidor. Revísala en Gentle Dot.';
      }
      if (!['app', 'pin'].includes(ask.method)) view.actions.append(button('Cancelar', () => answer({ cancelled: true })));
      if (expired()) { view.actions.replaceChildren(); view.status.textContent = 'Esta solicitud venció.'; }
      view.mount();
    },
    resolved(requestId: string) {
      const state = hostCards.get(requestId);
      if (!state) return;
      state.card.querySelector('.actions')?.replaceChildren();
      const status = state.card.querySelector('[role="status"]');
      if (status) status.textContent = 'Solicitud cerrada por el host.';
    },
    connection(ready: boolean) {
      connected = ready;
      if (!ready) {
        for (const { card } of hostCards.values()) {
          for (const control of card.querySelectorAll<HTMLButtonElement>('button')) control.disabled = true;
          const status = card.querySelector('[role="status"]'); if (status) status.textContent = 'Sin conexión. Esperando que el host vuelva a publicar la solicitud vigente.';
        }
        // Old cards are evidence only. A fresh ask must arrive before enabling any answer.
        hostCards.clear();
      }
    },
  };
}
