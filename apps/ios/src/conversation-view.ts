import type { ChatActivity, ChatEntry } from './conversation.ts';
import { renderSafeReply } from './safe-reply.ts';

export interface ConversationViewOptions {
  container: HTMLElement;
  empty?: HTMLElement;
  /** Pass the scrolling transcript viewport; omission uses the document. */
  scroller?: HTMLElement | Window;
  /** Optional shell-owned placement. Otherwise a contextual button follows the log. */
  newMessages?: HTMLButtonElement;
  bottomThreshold?: number;
}
type ActivityView = { item: HTMLLIElement; label: HTMLSpanElement; details: HTMLDetailsElement; output: HTMLPreElement };
type EntryView = { card: HTMLElement; label: HTMLElement; body: HTMLElement; state: HTMLElement;
  trace: HTMLDetailsElement; summary: HTMLElement; list: HTMLUListElement; activities: Map<string, ActivityView>; text?: string; role?: ChatEntry['role']; phase?: ChatEntry['state'] };
type EntrySnapshot = { text: string; state: ChatEntry['state']; role: ChatEntry['role']; activities: string; branchUnverified: boolean };
export const nearConversationEnd = (top: number, height: number, viewport: number, threshold = 64) => height - viewport - Math.max(0, top) <= threshold;
const snapshot = (entry: ChatEntry): EntrySnapshot => ({ text: entry.text, state: entry.state, role: entry.role,
  activities: JSON.stringify((entry.activities ?? []).map(item => [item.id, item.title, item.status, item.detail])), branchUnverified: entry.branchUnverified === true });
const same = (a: EntrySnapshot | undefined, b: EntrySnapshot) => !!a && a.text === b.text && a.state === b.state && a.role === b.role && a.activities === b.activities && a.branchUnverified === b.branchUnverified;
const content = (element: HTMLElement, value: string) => { if (element.textContent !== value) element.textContent = value; };

/** Keyed reconciliation moves only nodes whose order actually changed. */
function order(parent: HTMLElement, children: HTMLElement[]) {
  const focused = parent.ownerDocument.activeElement as HTMLElement | null;
  const preserve = focused && parent.contains(focused);
  let cursor = parent.firstElementChild;
  for (const child of children) {
    if (child === cursor) cursor = cursor.nextElementSibling;
    else parent.insertBefore(child, cursor);
  }
  while (cursor) { const next = cursor.nextElementSibling; cursor.remove(); cursor = next; }
  if (preserve && focused.isConnected && focused !== parent.ownerDocument.activeElement) focused.focus({ preventScroll: true });
}

export function createConversationView(options: ConversationViewOptions) {
  const { container, empty } = options;
  const doc = container.ownerDocument; const win = doc.defaultView!;
  const scrollTarget = options.scroller ?? win;
  const scrollElement = scrollTarget === win ? doc.scrollingElement! as HTMLElement : scrollTarget as HTMLElement;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '') => { const el = doc.createElement(tag); el.className = className; return el; };
  const button = options.newMessages ?? node('button', 'conversation-new-messages');
  const ownsButton = !options.newMessages;
  button.type = 'button'; button.hidden = true;
  if (ownsButton) container.after(button);
  const announcement = node('span', 'conversation-update-status');
  announcement.setAttribute('role', 'status'); announcement.setAttribute('aria-atomic', 'true');
  // The button text is the visible status, announced once per changed count.
  button.replaceChildren(announcement);
  const entries = new Map<string, EntryView>(); let previous = new Map<string, EntrySnapshot>();
  const unseen = new Map<string, 'response' | 'activity'>();
  const unseenReviews = new Set<HTMLElement>(); let destroyed = false;
  const viewportHeight = () => scrollTarget === win ? win.visualViewport?.height ?? win.innerHeight : scrollElement.clientHeight;
  const viewportTop = () => scrollTarget === win ? win.visualViewport?.offsetTop ?? 0 : scrollElement.getBoundingClientRect().top;
  const atEnd = () => nearConversationEnd(scrollElement.scrollTop, scrollElement.scrollHeight, viewportHeight(), options.bottomThreshold ?? 64);
  const updateButton = () => {
    for (const review of unseenReviews) if (!review.isConnected) unseenReviews.delete(review);
    const count = unseen.size + unseenReviews.size;
    button.hidden = count === 0;
    const onlyActivity = [...unseen.values()].every(kind => kind === 'activity');
    content(announcement, !count ? '' : unseenReviews.size ? unseenReviews.size === 1 ? 'Nueva revisión · Ir al final' : `${unseenReviews.size} revisiones nuevas · Ir al final`
      : onlyActivity ? 'Nueva actividad · Ir al final' : unseen.size === 1 ? 'Nueva respuesta · Ir al final' : `${unseen.size} mensajes nuevos · Ir al final`);
  };
  const readEnd = () => { if (atEnd()) { unseen.clear(); unseenReviews.clear(); updateButton(); } };
  const scrollToLatest = () => {
    if (destroyed) return;
    scrollElement.scrollTop = Math.max(0, scrollElement.scrollHeight - viewportHeight());
    unseen.clear(); unseenReviews.clear(); updateButton();
  };
  const jump = () => {
    const last = [...unseenReviews].filter(element => element.isConnected).at(-1) ?? container.lastElementChild as HTMLElement | null;
    scrollToLatest();
    if (last) { last.tabIndex = -1; last.focus({ preventScroll: true }); }
  };
  button.addEventListener('click', jump); scrollTarget.addEventListener('scroll', readEnd, { passive: true });

  function makeEntry(): EntryView {
    const card = node('article', 'chat-card'); const label = node('div', 'chat-label');
    const body = node('div', 'chat-text'); const state = node('small', 'chat-state');
    const trace = node('details', 'tool-trace'); const summary = node('summary'); const list = node('ul');
    trace.append(summary, list); card.append(label, body, state, trace);
    return { card, label, body, state, trace, summary, list, activities: new Map() };
  }
  function renderActivities(view: EntryView, activities: readonly ChatActivity[]) {
    view.trace.hidden = activities.length === 0;
    const running = activities.filter(item => item.status === 'running');
    const failed = activities.filter(item => item.status === 'failed').length;
    const count = `${activities.length} ${activities.length === 1 ? 'acción' : 'acciones'}`;
    const progress = running.length ? `En curso: ${running[running.length - 1]!.title}${running.length > 1 ? ` · ${running.length} en curso` : ''}`
      : failed ? '' : activities.length === 1 ? 'Completada' : 'Completadas';
    const failures = failed ? `${failed} ${failed === 1 ? 'interrumpida o fallida' : 'interrumpidas o fallidas'}` : '';
    content(view.summary, [count, progress, failures].filter(Boolean).join(' · '));
    const keep = new Set<string>(); const nodes: HTMLElement[] = [];
    for (const activity of activities) {
      if (keep.has(activity.id)) continue; keep.add(activity.id);
      let item = view.activities.get(activity.id);
      if (!item) {
        const li = node('li'); li.dataset.activityId = activity.id;
        const label = node('span'); const details = node('details');
        const summary = node('summary'); summary.textContent = 'Ver resultado';
        const output = node('pre'); output.tabIndex = 0; output.setAttribute('aria-label', 'Resultado de la acción');
        details.append(summary, output); li.append(label, details);
        item = { item: li, label, details, output }; view.activities.set(activity.id, item);
      }
      content(item.label, `${activity.status === 'running' ? 'En curso' : activity.status === 'done' ? 'Completado' : 'Interrumpido o fallido'} · ${activity.title}`);
      item.item.dataset.status = activity.status;
      item.details.hidden = !activity.detail;
      content(item.output, activity.detail ?? ''); nodes.push(item.item);
    }
    order(view.list, nodes);
    for (const id of view.activities.keys()) if (!keep.has(id)) view.activities.delete(id);
  }

  function render(input: readonly ChatEntry[]) {
    if (destroyed) return;
    const following = atEnd(); const top = viewportTop();
    const anchor = !following ? [...entries.values()].find(view => view.card.getBoundingClientRect().bottom > top) : undefined;
    const anchorY = anchor?.card.getBoundingClientRect().top;
    const keep = new Set<string>(); const cards: HTMLElement[] = []; const changed: string[] = [];
    const next = new Map<string, EntrySnapshot>();
    const previousIds = new Set(previous.keys());
    // Newly prepended archive records are history, not incoming messages.
    const lastKnown = input.findLastIndex(entry => previousIds.has(entry.id));
    for (const [index, entry] of input.entries()) {
      if (keep.has(entry.id)) continue; keep.add(entry.id);
      const snap = snapshot(entry); next.set(entry.id, snap);
      if (previous.size && entry.role !== 'user' && !same(previous.get(entry.id), snap)
        && (previous.has(entry.id) || index > lastKnown)) changed.push(entry.id);
      let view = entries.get(entry.id);
      if (!view) { view = makeEntry(); entries.set(entry.id, view); }
      view.card.dataset.id = entry.id; view.card.dataset.role = entry.role; view.card.dataset.state = entry.state;
      content(view.label, `${entry.role === 'user' ? 'TÚ' : entry.role === 'notice' ? 'AVISO' : 'CAPRI'} / ${entry.engine === 'iphone' ? 'IPHONE' : 'GENTLE DOT'}`);
      if (view.text !== entry.text || view.role !== entry.role || view.phase !== entry.state) {
        // During streaming, retain plain text; format once the reply settles.
        if (entry.role === 'assistant' && entry.state !== 'pending') renderSafeReply(view.body, entry.text);
        else content(view.body, entry.text);
        view.text = entry.text; view.role = entry.role; view.phase = entry.state;
      }
      const phase = entry.state === 'pending' ? entry.role === 'user' ? 'Esperando confirmación del host…' : 'Preparando respuesta…'
        : entry.state === 'interrupted' ? 'Interrumpido o sin confirmar. No se reenvía automáticamente.' : '';
      content(view.state, [entry.branchUnverified ? 'Rama no verificada' : '', phase].filter(Boolean).join(' · '));
      renderActivities(view, entry.activities ?? []); cards.push(view.card);
    }
    order(container, cards);
    for (const id of entries.keys()) if (!keep.has(id)) { entries.delete(id); unseen.delete(id); }
    if (empty) empty.hidden = input.length > 0;
    previous = next;
    if (following) scrollToLatest();
    else {
      if (anchor?.card.isConnected && anchorY !== undefined) scrollElement.scrollTop += anchor.card.getBoundingClientRect().top - anchorY;
      const bottom = viewportTop() + viewportHeight();
      for (const id of changed) {
        const view = entries.get(id)!;
        if (view.card.getBoundingClientRect().bottom > bottom + 1) unseen.set(id, next.get(id)!.text ? 'response' : 'activity');
      }
      updateButton();
    }
  }
  /** Wrap a shell-owned review insertion so its height cannot cause a false
   * reading-position decision after the fact. Never grants or submits approval. */
  function updateExtra(element: HTMLElement, mutate: () => void) {
    if (destroyed) return;
    const following = atEnd(); const previousTop = scrollElement.scrollTop;
    mutate();
    if (following) scrollToLatest();
    else {
      scrollElement.scrollTop = previousTop;
      if (element.getBoundingClientRect().bottom > viewportTop() + viewportHeight() + 1) unseenReviews.add(element);
      updateButton();
    }
  }
  return { render, scrollToLatest, updateExtra, destroy() {
    destroyed = true; button.removeEventListener('click', jump); scrollTarget.removeEventListener('scroll', readEnd);
    if (ownsButton) button.remove(); else { button.hidden = true; announcement.remove(); }
    entries.clear(); previous.clear(); unseen.clear(); unseenReviews.clear();
  } };
}
