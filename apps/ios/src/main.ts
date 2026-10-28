import { localIdentifier } from './local-identifiers.ts';
import { waitForForeground } from './foreground.ts';
import { pickDocuments, listDocumentImports, importDocumentItem } from './document-import.ts';
import { createEngine, frameAt } from '@gentle-dot/ui/src/capri2d/engine.ts';
import { RoamDirector, type RoamPosition } from '@gentle-dot/ui/src/capri2d/roam.ts';
import { occupiedPhoneSpace, phonePerches, phonePositionFree } from './companion-space.ts';
import { RigDirector, type RigIntent } from '@gentle-dot/ui/src/capri2d/director.ts';
import { RigFx } from '@gentle-dot/ui/src/capri2d/fx.ts';
import type { ServerMessage } from '@gentle-dot/protocol';
import { readSettings, saveSettings, loadArtwork, saveArtwork, deleteArtwork, validateArtwork, validDaemonUrl } from './local-state.ts';
import { createLinkedChat, type LinkedStatus } from './linked-chat.ts';
import { checkLocalIntelligence, availabilityMessage, agentStep, cancelLocal, resetLocal, type Availability } from './local-intelligence.ts';
import { loadConversation, updateEntry, reconcileHostHistory, localPrompt, linkedPrompt, type ChatEntry, type Engine } from './conversation.ts';
import { mountInbox } from './inbox-view.ts';
import { conversationArchive } from './conversation-archive.ts';
import { createConversationPersistence } from './conversation-persistence.ts';
import { createMemoryTools } from './conversation-memory-tools.ts';
import { mountMemoryView } from './memory-view.ts';
import { createAgentRunner } from './agent-runner.ts';
import { mountConnectionSettings } from './connection-settings.ts';
import { createConnectionTools } from './connection-tools.ts';
import { createWorkTools } from './work-tools.ts';
import { createWorkDispatcher } from './work-sync.ts';
import { createDesktopTools } from './desktop-tools.ts';
import { createLocalTools } from './agent-tools.ts';
import { createTrustedApprovals } from './trusted-approvals.ts';
import { createConversationRequests } from './conversation-requests.ts';
import { checkVoice, prepareVoice, startVoice, stopVoice, cancelVoice } from './perception.ts';
import { isTauri } from '@tauri-apps/api/core';
import { secretGet, secretSet, secretDelete, listSharedImports, importSharedItem } from './device-bridge.ts';
import { parseInvitation, pairDevice, restorePairing } from './device-pairing.ts';
import { createWork, createImportedWork } from './work-inbox.ts';
import { companionBounds, constrainCompanion, mountPhoneViewport } from './companion-layout.ts';
import { connectionHealth, healthActionLabel, type HealthAction } from './connection-health.ts';
import { createConversationView } from './conversation-view.ts';
import { loadPackagedArtwork } from './packaged-art.ts';
import { createAgentContext } from './agent-context.ts';
import { buildInfo, buildLabel } from './build-info.ts';
import { mountPairingInput } from './pairing-input.ts';
import './style.css';

import './companion-presence.css';
import './settings.css';
import './composer.css';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let documentImports: Promise<void> | undefined;
element('build-info').textContent = buildLabel();
element('build-info').title = buildInfo.sourceCommit ?? '';
const settings = readSettings();
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const canvas = element<HTMLCanvasElement>('capri');
const rig = element<HTMLButtonElement>('rig-handle');
const stage = element('stage');
const director = new RigDirector();
let engine: ReturnType<typeof createEngine> | undefined;
let fx: RigFx | undefined;
let image: HTMLImageElement | undefined;
let frame = 0;
let lastFrame = -1;
let intent: RigIntent = {};
let revision = 0;
let lastRevision = -1;
let assetRevision = 0;
let panel = 'chat';
let absent = false;
let roaming = true;
let position = { x: 0, y: 0 };
const roamDirector = new RoamDirector();
let travel: { started: number; target: RoamPosition; moved: boolean } | undefined;
let perched: Pick<RigIntent, 'resting' | 'direction'> = {};
let measuredAt = -Infinity;
let safePerches: [number, number][] = [];
stage.dataset.companionLayer = 'true';
document.querySelector('main')!.append(stage);
let lastTime = 0;
let nextRoam = 0;
let gestureTimer: ReturnType<typeof setTimeout> | undefined;
const isReduced = () => reduced.matches || settings.motion !== 'full';
try { fx = new RigFx(element<HTMLCanvasElement>('fx')); } catch { /* Optional procedural effects. */ }

function movementBounds() {
  return companionBounds({ width: stage.clientWidth, height: stage.clientHeight }, { width: rig.offsetWidth, height: rig.offsetHeight });
}
function place(x: number, y: number) {
  position = constrainCompanion({ x, y }, movementBounds());
  rig.style.transform = `translate(${position.x}px, ${position.y}px)`;
}
let typing = false;
let attention = false;
let conversationRestored = false;
let manuallyPlaced = false;
function presenceIntent(): RigIntent {
  if (travel) return { travelling: true, direction: travel.target.direction };
  if (attention) return { ...intent, question: 'review' };
  if (typing && !intent.working && !intent.dragging && !intent.gesture) return { ...intent, resting: 'sit', watching: true };
  return Object.keys(intent).length ? { direction: perched.direction, ...intent } : perched;
}
function layoutCompanion() {
  const main = document.querySelector('main')!.getBoundingClientRect();
  const active = element(`panel-${panel}`);
  const area = active.getBoundingClientRect();
  const top = Math.max(document.querySelector('.masthead')!.getBoundingClientRect().bottom, area.top);
  const input = active.querySelector('#composer, .agent-reply');
  const bottom = input?.getBoundingClientRect().top ?? Math.min(area.bottom, main.bottom) - 12;
  Object.assign(stage.style, { left: `${area.left}px`, top: `${top}px`, width: `${area.width}px`, height: `${Math.max(0, bottom - top)}px` });
  stage.hidden = !['chat', 'agents'].includes(panel);
  document.documentElement.dataset.companionSize = panel === 'chat' && element('panel-chat').dataset.empty === 'true' ? 'hero' : 'compact';
  measuredAt = -Infinity;
  place(position.x, position.y);
}
function animate(now: number) {
  // Let the persisted transcript reach the DOM before the first GPU frame.
  // Software renderers can block unrelated IndexedDB callbacks during warmup.
  if (!conversationRestored || !engine || document.hidden || !['agents', 'chat'].includes(panel) || absent) return;
  if (intent.outcome && now - intent.outcome.at > 2400) { const { outcome: _outcome, ...rest } = intent; intent = rest; revision++; }
  if (now - measuredAt >= 1000) {
    layoutCompanion(); measuredAt = now;
    const area = stage.getBoundingClientRect();
    const occupied = occupiedPhoneSpace(element(`panel-${panel}`), area);
    safePerches = phonePerches({ x: 0, y: 0, width: area.width, height: area.height },
      { width: rig.offsetWidth, height: rig.offsetHeight }, occupied);
    rig.style.visibility = '';
    if (roaming && !manuallyPlaced && !drag && !travel) {
      const here = { x: position.x + (area.width - rig.offsetWidth) / 2, y: position.y + (area.height - rig.offsetHeight) / 2, width: rig.offsetWidth, height: rig.offsetHeight };
      // Newly loaded controls take precedence over a perch from the old view.
      // Relocate immediately, without spending a teleport blocking a button.
      if (!phonePositionFree(here, occupied) && !safePerches.length) rig.style.visibility = 'hidden';
      if (!phonePositionFree(here, occupied) && safePerches[0]) place(safePerches[0][0] - (area.width - rig.offsetWidth) / 2, safePerches[0][1] - (area.height - rig.offsetHeight) / 2);
    }
  }
  if (roaming && !drag && !travel && now >= nextRoam) {
    const region = { x: 0, y: 0, width: stage.clientWidth, height: stage.clientHeight };
    const next = roamDirector.step({ laptop: region, region, x: 0, y: 0, width: rig.offsetWidth, height: rig.offsetHeight, herdr: false, safePerches }, now,
      { composer: typing, question: attention, paused: isReduced() || Boolean(intent.working || intent.gesture || intent.outcome) });
    if (next) { manuallyPlaced = false; travel = { started: now, target: next, moved: false }; nextRoam = now + 18000; revision++; }
  }
  if (travel) {
    // The PC teleport is transparent on frames 6–7 at 24 fps. Relocate there.
    if (!travel.moved && now - travel.started >= 250) {
      place(travel.target.x - (stage.clientWidth - rig.offsetWidth) / 2, travel.target.y - (stage.clientHeight - rig.offsetHeight) / 2);
      travel.moved = true;
    }
    if (now - travel.started >= 900) { perched = { resting: travel.target.resting, direction: travel.target.direction }; travel = undefined; revision++; }
  }
  lastTime = now;
  director.update(presenceIntent(), now);
  const next = isReduced() ? 0 : frameAt(now, director.fps());
  if (next !== lastFrame || revision !== lastRevision) {
    const sample = director.sample(now, isReduced());
    rig.dataset.pose = sample.act;
    engine.draw(sample.pose, next);
    if (!isReduced()) for (const cue of sample.cues) fx?.cue(cue, now, intent.direction);
    lastFrame = next; lastRevision = revision;
  }
  if (!isReduced()) fx?.draw(now);
  if (!isReduced()) frame = requestAnimationFrame(animate);
}
function redraw() { document.documentElement.dataset.motion = isReduced() ? 'reduced' : 'full'; revision++; cancelAnimationFrame(frame); lastTime = 0; frame = requestAnimationFrame(animate); }
function setIntent(next: RigIntent) { intent = next; if (next.gesture || next.dragging || next.question || next.working) travel = undefined; redraw(); }
function gesture(name: string) {
  clearTimeout(gestureTimer);
  const greeting = { name, at: performance.now() };
  const { outcome: _outcome, dragging: _dragging, ...context } = intent;
  setIntent({ ...context, gesture: greeting });
  gestureTimer = setTimeout(() => {
    // A greeting must neither forget ongoing work nor erase a newer engine event.
    if (intent.gesture !== greeting) return;
    const { gesture: _gesture, ...current } = intent;
    setIntent(current);
  }, 2500);
}
function startRig() {
  cancelAnimationFrame(frame); engine?.dispose(); engine = undefined;
  if (!image) return;
  try {
    engine = createEngine(canvas, image, { maskReadback: false }); layoutCompanion(); lastFrame = -1; rig.dataset.ready = 'true'; element('art-placeholder').hidden = true; place(position.x, position.y); redraw();
    element('art-status').textContent = 'Tu Capri está aquí. Arrástrala, salúdala o déjala chillear.';
  }
  catch { rig.dataset.ready = 'false'; element('art-placeholder').hidden = false; element('art-placeholder').textContent = 'No se pudo iniciar el personaje 2D. Vuelve a abrir Capri.'; element('art-status').textContent = 'WebGL no está disponible. La conversación sigue activa.'; }
}
async function useArtwork(blob: Blob, persist: boolean) {
  const current = ++assetRevision;
  validateArtwork(blob);
  const url = URL.createObjectURL(blob);
  try {
    const next = new Image(); next.src = url; await next.decode();
    if (next.naturalWidth !== 240 || next.naturalHeight !== 420) throw new Error('Se necesita un PNG de 240 × 420.');
    if (current !== assetRevision) return;
    if (persist) await saveArtwork(blob);
    if (current !== assetRevision) return;
    image = next; element('art-placeholder').hidden = true; startRig();
    if (persist) element('settings-status').textContent = 'Arte guardado en este dispositivo.';
  } finally { URL.revokeObjectURL(url); }
}
canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); cancelAnimationFrame(frame); engine?.dispose(); engine = undefined; rig.dataset.ready = 'false'; element('art-status').textContent = 'Recuperando el personaje…'; });
canvas.addEventListener('webglcontextrestored', startRig);
reduced.addEventListener('change', () => { fx?.clear(); redraw(); });
element<HTMLInputElement>('art').addEventListener('change', async event => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try { await useArtwork(file, true); }
  catch (error) { element('settings-status').textContent = errorText(error); }
});
element('delete-art').addEventListener('click', async () => {
  try {
    const current = ++assetRevision; await deleteArtwork();
    const original = await loadPackagedArtwork();
    if (current !== assetRevision) return;
    if (!original) throw new Error('Esta instalación no contiene la Capri original. Conservé el personaje visible hasta que selecciones otro PNG.');
    await useArtwork(original, false);
    element('settings-status').textContent = 'Capri original restaurada. El arte personalizado se eliminó del dispositivo.';
  } catch (error) { element('settings-status').textContent = errorText(error); }
});
element('choose-art').addEventListener('click', () => element<HTMLInputElement>('art').click());
element<HTMLSelectElement>('motion').value = settings.motion;
element('motion').addEventListener('change', () => {
  settings.motion = element<HTMLSelectElement>('motion').value as typeof settings.motion;
  element('settings-status').textContent = saveSettings(settings) ? 'Preferencias guardadas.' : 'No se pudieron guardar las preferencias.';
  fx?.clear(); redraw();
});
element('greet').addEventListener('click', () => { gesture('saludar'); element('scene-status').textContent = 'Hey. Aquí estoy.'; });
element('chill').addEventListener('click', () => { roaming = false; element('roam').setAttribute('aria-pressed', 'false'); setIntent({ resting: 'sit' }); element('scene-status').textContent = 'Chilleando contigo.'; });
element('roam').addEventListener('click', () => { roaming = !roaming; nextRoam = 0; element('roam').setAttribute('aria-pressed', String(roaming)); setIntent({}); element('scene-status').textContent = roaming ? 'Explorando mi espacio.' : 'Aquí contigo.'; });
element('appear').addEventListener('click', () => {
  absent = !absent; rig.classList.toggle('absent', absent); rig.disabled = absent;
  element('appear').textContent = absent ? 'Aparecer' : 'Desaparecer';
  element('scene-status').textContent = absent ? 'Vuelvo cuando me llames.' : 'De vuelta.';
  fx?.clear(); redraw();
});
let drag: { id: number; x: number; y: number; start: typeof position; moved: boolean } | undefined;
let suppressClick = false;
rig.addEventListener('pointerdown', event => {
  if (!image || event.button !== 0) return;
  travel = undefined;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: { ...position }, moved: false };
  rig.setPointerCapture(event.pointerId);
});
rig.addEventListener('pointermove', event => {
  if (!drag || drag.id !== event.pointerId) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (Math.hypot(dx, dy) > 5) drag.moved = true;
  if (drag.moved) { manuallyPlaced = true; roamDirector.dragged(performance.now()); place(drag.start.x + dx, drag.start.y + dy); setIntent({ ...intent, dragging: true }); }
});
function release() { if (!drag) return; suppressClick = drag.moved; drag = undefined; const { dragging: _dragging, ...current } = intent; setIntent(current); }
rig.addEventListener('pointerup', release); rig.addEventListener('pointercancel', release); rig.addEventListener('lostpointercapture', release);
rig.addEventListener('click', () => { if (suppressClick) { suppressClick = false; return; } if (image) gesture('saludar'); else showPanel('settings'); });
rig.addEventListener('keydown', event => {
  const steps: Record<string, [number, number]> = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
  const step = steps[event.key]; if (!step || !image) return;
  event.preventDefault(); manuallyPlaced = true; roamDirector.dragged(performance.now()); place(position.x + step[0], position.y + step[1]);
});
new ResizeObserver(() => { place(position.x, position.y); measuredAt = -Infinity; }).observe(stage);
window.addEventListener('resize', () => { manuallyPlaced = false; layoutCompanion(); redraw(); });
mountPhoneViewport(element('composer'));
element('roam').setAttribute('aria-pressed', String(roaming));

function showPanel(next: string) {
  manuallyPlaced = false;
  panel = next;
  updateLaptopView();
  if (next !== 'chat' && (voiceSession || voiceStarting)) void cancelDictation();
  for (const section of document.querySelectorAll<HTMLElement>('.panel')) section.hidden = section.id !== `panel-${next}`;
  for (const button of document.querySelectorAll<HTMLElement>('[data-panel]')) {
    if (button.dataset.panel === next) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  travel = undefined; nextRoam = 0; layoutCompanion(); redraw();
  if (next === 'inbox') { void inbox.refresh(); void memoryView.refresh(); }
}
for (const button of document.querySelectorAll<HTMLElement>('[data-panel]')) button.addEventListener('click', () => showPanel(button.dataset.panel!));
function errorText(error: unknown) { return error instanceof Error ? error.message : 'No se pudo completar la operación.'; }

// The UI owns one durable conversation; each transport has an explicit trust boundary.
const prompt = element<HTMLTextAreaElement>('prompt');
let entries: ChatEntry[] = [];
let selected: Engine = 'iphone';
let preference: Engine | 'auto' = 'auto';
let localController: AbortController | undefined;
let attachedWork: string | undefined;
let connectionEpoch = 0;
let manualToSave: { url: string; token: string } | undefined;
let runtimeConnection: { url: string; token: string } | undefined;
let laptop: ReturnType<typeof import('./laptop-view.tsx')['mountLaptopView']> | undefined;
let laptopLoading = false;
new MutationObserver(() => { measuredAt = -Infinity; if (panel === 'agents') redraw(); }).observe(element('laptop-root'), { childList: true, subtree: true });
function updateLaptopView() {
  if (laptop) { laptop.update({ connection: runtimeConnection, active: panel === 'agents' }); return; }
  if (panel !== 'agents' || laptopLoading) return;
  laptopLoading = true; element('laptop-root').textContent = 'Abriendo tus sesiones…';
  void import('./laptop-view.tsx').then(({ mountLaptopView }) => {
    laptop = mountLaptopView(element('laptop-root'), () => showPanel('settings'), state => {
      if (panel === 'agents') setIntent(state === 'working' ? { working: true } : state === 'blocked' ? { alert: true } : {});
    });
    updateLaptopView();
  }).catch(() => { element('laptop-root').textContent = 'No se pudo abrir el panel. Vuelve a entrar a Sesiones para reintentar.'; })
    .finally(() => { laptopLoading = false; });
}
const conversationView = createConversationView({ container: element('cards'), empty: element('empty-conversation'), scroller: element('conversation-scroll'), newMessages: element<HTMLButtonElement>('new-messages') });
const reviews = createConversationRequests(element('requests'), { append: conversationView.updateExtra });
let availability: Availability = { available: false, status: 'checking', supportsSpanish: false };
let linkedStatus: LinkedStatus = 'offline';
let linkedBusy = false;
let hostAgentState = 'idle';
let healthAction: HealthAction | undefined;
let localBusy = false;
let localGeneration = 0;
let conversationReady = false;
let draftEdited = false;
let host = settings.url;
let remoteConversation = 'default';
let pendingRemote: { id: string; text: string; displayText: string } | undefined;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let persistenceWarning = '';
const persistence = createConversationPersistence({ onStatus(status) {
  if (status.blocked) {
    persistenceWarning = `No se confirmó el guardado local. ${status.archiveError ?? status.conversationError} ${status.pending} mensajes siguen en memoria. Los envíos están detenidos: abre Archivo para reintentar o exportar antes de cerrar Capri.`;
    element('chat-notice').textContent = persistenceWarning;
  } else if (element('chat-notice').textContent === persistenceWarning) element('chat-notice').textContent = '';
  memoryView.updateStatus(); updateControls();
} });
function persist(): Promise<void> {
  if (!conversationReady) return Promise.resolve();
  clearTimeout(saveTimer);
  return persistence.persist({ entries, draft: prompt.value, attachedWork });
}

function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 250); }
function renderChat() {
  element('panel-chat').dataset.empty = String(entries.length === 0);
  conversationView.render(entries);
  element('empty-conversation').hidden = entries.length > 0 || !conversationReady;
  element('history-loading').hidden = conversationReady || entries.length > 0;
  measuredAt = -Infinity; redraw();
}

function add(entry: ChatEntry) { if (!entry.activities) entry.activities = entries.find(prior => prior.id === entry.id)?.activities; persistence.enqueue(entries); persistence.enqueue([entry]); entries = updateEntry(entries, entry); renderChat(); scheduleSave(); }
function notice(text: string, target: Engine = selected, id: string = localIdentifier()) { add({ id, role: 'notice', text, engine: target, state: 'complete', at: Date.now() }); }
function remoteId(id: string) { return `host:${host}|${remoteConversation}|${id}`; }
function updateControls() {
  const health = connectionHealth({ local: availability, linkedStatus, agentState: hostAgentState, hostConfigured: Boolean(settings.url), preference, capabilities: { workSync: linked.supportsWorkSync(), meetingDrafts: linked.supportsMeetingDrafts() } });
  if (!localBusy && !pendingRemote) selected = health.selectedEngine;
  const ready = selected === 'iphone' ? health.local.state === 'ready' : health.host.state === 'ready';
  const busy = localBusy || !!pendingRemote;
  element('engine-status').dataset.ready = String(ready);
  element('engine-summary').textContent = preference === 'auto' ? 'Automático' : selected === 'iphone' ? 'Este iPhone' : 'Laptop';
  element<HTMLButtonElement>('send').disabled = !conversationReady || persistence.status().blocked || !ready || busy;
  element<HTMLSelectElement>('engine').disabled = localBusy || !!pendingRemote;
  element('stop').hidden = !(localBusy || (selected === 'gentle' && linkedBusy));
  element<HTMLButtonElement>('send').setAttribute('aria-label', selected === 'gentle' && linkedBusy ? 'Añadir instrucción' : 'Enviar');
  prompt.maxLength = selected === 'iphone' ? 2400 : 8000;
  element('engine-badge').textContent = selected === 'iphone' ? 'IPHONE' : 'LAPTOP';
  healthAction = health.primaryAction;
  element('health-action').hidden = ready || !healthAction;
  element('health-action').textContent = healthAction ? healthActionLabel(healthAction) : '';
  element('engine-status').textContent = selected === 'iphone' ? health.local.detail : health.host.detail;
}
function unconfirmedRemote() {
  if (!pendingRemote) return;
  const id = pendingRemote.id;
  entries = entries.map(entry => entry.id === id ? { ...entry, state: 'interrupted' } : entry);
  pendingRemote = undefined; clearTimeout(pendingTimer); renderChat(); scheduleSave(); updateControls();
}
async function checkModel() {
  availability = await checkLocalIntelligence();
  element('local-status').textContent = availabilityMessage(availability);
  element('local-summary').textContent = availability.available ? 'Disponible sin internet' : availability.status === 'browser_preview' ? 'Requiere la app instalada' : 'Revisa su disponibilidad';
  updateControls();
}
function handleMessage(message: ServerMessage) {
  if (message.type === 'ready') { hostAgentState = message.agentState; remoteConversation = message.conversationId ?? 'default'; linkedBusy = ['thinking', 'working', 'needs_you'].includes(message.agentState); }
  if (message.type === 'agent_state') {
    hostAgentState = message.state;
    linkedBusy = ['thinking', 'working', 'needs_you'].includes(message.state);
    if (selected === 'gentle') { setIntent({ working: linkedBusy, thinking: message.state === 'thinking', alert: message.state === 'needs_you' }); element('scene-status').textContent = ({ thinking: 'Pensando contigo…', working: 'Estoy trabajando.', needs_you: 'Necesito tu respuesta.', idle: 'Aquí contigo.', starting: 'Iniciando…', restarting: 'Recuperando el hilo…', error: 'Algo necesita atención.' })[message.state]; }
  }
  if (message.type === 'history') {
    remoteConversation = message.conversationId ?? remoteConversation;
    persistence.enqueue(entries);
    entries = reconcileHostHistory(entries, remoteId(''), message.messages, Date.now(), beforePrune => persistence.enqueue(beforePrune));
    renderChat(); scheduleSave();
  }
  if (message.type === 'interrupted') {
    linkedBusy = false;
    entries = entries.map(entry => entry.engine === 'gentle' && entry.id.startsWith(remoteId('')) && entry.state === 'pending' ? { ...entry, state: 'interrupted' } : entry);
    unconfirmedRemote(); renderChat(); scheduleSave();
    if (selected === 'gentle') setIntent({});
  }
  if (message.type === 'user_message') {
    let displayText = message.text;
    if (pendingRemote && message.text === pendingRemote.text) {
      displayText = pendingRemote.displayText;
      persistence.enqueue(entries.map(entry => entry.id === pendingRemote!.id ? { ...entry, state: 'complete' as const } : entry));
      entries = entries.filter(entry => entry.id !== pendingRemote!.id); pendingRemote = undefined;
      clearTimeout(pendingTimer);
    }
    add({ id: remoteId(message.messageId), role: 'user', text: displayText, transportText: message.text, engine: 'gentle', state: 'complete', at: Date.now() });
  }
  if (message.type === 'message_delta') {
    const id = remoteId(message.messageId); const prior = entries.find(entry => entry.id === id);
    add({ id, role: 'assistant', text: ((prior?.text ?? '') + message.delta).slice(0, 32000), engine: 'gentle', state: 'pending', at: prior?.at ?? Date.now() });
    if (selected === 'gentle') setIntent({ talking: true });
  }
  if (message.type === 'message_done') {
    add({ id: remoteId(message.messageId), role: 'assistant', text: message.error ? `${message.text}${message.text ? '\n\n' : ''}${message.error}` : message.text, engine: 'gentle', state: message.stopped || message.error ? 'interrupted' : 'complete', at: Date.now() });
    if (!message.intermediate) {
      linkedBusy = false;
      if (selected === 'gentle') setIntent(message.stopped ? {} : { outcome: { kind: message.error ? 'error' : 'done', at: performance.now() } });
    }
  }
  if (message.type === 'activity') {
    const id = remoteId(message.messageId); const prior = entries.find(item => item.id === id);
    const activities = [...prior?.activities ?? []]; const at = activities.findIndex(item => item.id === message.activity.id);
    if (at < 0) activities.push(message.activity); else activities[at] = message.activity;
    add({ id, role: 'assistant', text: prior?.text ?? '', engine: 'gentle', state: prior?.state ?? 'pending', at: prior?.at ?? Date.now(), activities });
    element('active-tool').textContent = message.activity.status === 'running' ? message.activity.title : '';
    if (selected === 'gentle') setIntent({ working: message.activity.status === 'running', workBeat: message.activity.status === 'running' ? 'typing' : undefined });
  }
  if (message.type === 'queue') element('chat-notice').textContent = message.steering.length ? `${message.steering.length} instrucción(es) recibidas para orientar el trabajo en curso.` : '';
  if (message.type === 'toast' || message.type === 'error') notice(message.message, 'gentle');
  if (message.type === 'error') unconfirmedRemote();
  if (message.type === 'ask') {
    const ask = message.ask;
    if (ask.method === 'app' && isTauri() && runtimeConnection) {
      const client = createTrustedApprovals({ getConnection: () => runtimeConnection ?? null });
      void client.list().then(approvals => {
        const snapshot = approvals.find(item => item.requestId === ask.requestId);
        if (!snapshot) throw new Error('La autorización ya no está vigente.');
        reviews.host({ ...ask, title: snapshot.title, message: snapshot.body, expiresAt: snapshot.expiresAt }, fields => client.answer(snapshot, fields.confirmed === true), true);
      }).catch(() => reviews.host(ask, () => false));
    } else reviews.host(ask, fields => linked.answer(ask.requestId, fields, ask));
  }
  if (message.type === 'ask_resolved') reviews.resolved(message.requestId);
  updateControls();
}
const linked = createLinkedChat({
  onStatus(value) {
    if (value === 'ready' && manualToSave && isTauri()) {
      const credential = manualToSave; manualToSave = undefined;
      void secretSet('daemon-manual', new URL(credential.url.replace('wss:', 'https:')).origin, credential.token).catch(() => notice('Conectado; no se pudo conservar el acceso en Keychain.'));
    }
    if (value === 'rejected') { connectionEpoch++; manualToSave = undefined; runtimeConnection = undefined; }
    updateLaptopView();
    linkedStatus = value; reviews.connection(value === 'ready');
    element('status').textContent = { offline: 'Sin conexión', connecting: 'Conectando…', ready: 'Vinculado a Gentle Dot', rejected: 'Acceso rechazado. Revisa token y versión.' }[value];
    element('connection-badge').textContent = value === 'ready' ? 'VINCULADO' : 'LOCAL';
    if (value !== 'ready') {
      linkedBusy = false; if (!localBusy) element('active-tool').textContent = '';
      entries = entries.map(entry => entry.engine === 'gentle' && entry.id.startsWith(`host:${host}|`) && entry.state === 'pending' ? { ...entry, state: 'interrupted' } : entry);
      unconfirmedRemote();
      renderChat(); scheduleSave();
    }
    updateControls();
  }, onMessage: handleMessage,
});
element('health-action').addEventListener('click', async () => {
  if (healthAction === 'check-local') { await checkModel(); return; }
  if (healthAction === 'use-iphone' || healthAction === 'use-gentle') {
    preference = healthAction === 'use-iphone' ? 'iphone' : 'gentle';
    element<HTMLSelectElement>('engine').value = preference; updateControls(); return;
  }
  if (healthAction === 'retry-host') {
    if (runtimeConnection) linked.connect(runtimeConnection.url, runtimeConnection.token);
    else await restoreDeviceConnection();
    return;
  }
  showPanel('settings');
  const destination = element(healthAction === 'show-pairing' || healthAction === 'show-host-help' ? 'pairing-camera' : 'check-local');
  for (let parent = destination.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
  destination.scrollIntoView({ block: 'center' }); destination.focus();
});
element<HTMLSelectElement>('engine').addEventListener('change', () => { preference = element<HTMLSelectElement>('engine').value as Engine | 'auto'; updateControls(); });
function sizeDraft() { prompt.style.height = 'auto'; prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`; }
let draftWidth = 0, draftLayoutFrame = 0;
new ResizeObserver(() => { if (draftWidth !== prompt.clientWidth) { draftWidth = prompt.clientWidth; cancelAnimationFrame(draftLayoutFrame); draftLayoutFrame = requestAnimationFrame(sizeDraft); } }).observe(prompt);
prompt.addEventListener('input', () => { draftEdited = true; sizeDraft(); scheduleSave(); });
document.addEventListener('focusin', event => {
  if (event.target instanceof HTMLTextAreaElement) { typing = true; travel = undefined; redraw(); }
});
document.addEventListener('focusout', event => {
  if (event.target instanceof HTMLTextAreaElement) { typing = false; redraw(); }
});
window.addEventListener('gentle-dot-companion-activity', event => {
  if (panel !== 'agents') return;
  const kind = (event as CustomEvent<{ kind: string }>).detail?.kind;
  if (kind === 'response') setIntent({ talking: true });
  if (kind === 'failed') setIntent({ outcome: { kind: 'error', at: performance.now() } });
  if (kind === 'submitted') setIntent({ outcome: { kind: 'done', at: performance.now() } });
  if (kind === 'sending') setIntent({ working: true, thinking: true });
});
new MutationObserver(() => {
  const next = !!element('requests').querySelector('.actions button:not(:disabled)');
  if (next === attention) return;
  attention = next; redraw();
  if (attention) element('scene-status').textContent = 'Necesito tu revisión.';
  else if (!localBusy && !linkedBusy) element('scene-status').textContent = 'Aquí contigo.';
}).observe(element('requests'), { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
element<HTMLFormElement>('composer').addEventListener('submit', async event => {
  event.preventDefault();
  const text = prompt.value.trim();
  const promptText = text;
  if (!text || localBusy || pendingRemote || !conversationReady || persistence.status().blocked) return;
  element('chat-notice').textContent = '';
  if (selected === 'iphone') {
    if (!availability.available || !availability.supportsSpanish) { updateControls(); return; }
    if (Array.from(text).length > 2400) { element('chat-notice').textContent = 'Usa hasta 2400 caracteres con el motor local; puedes guardar un trabajo más largo.'; return; }
    const request = localPrompt(entries, text);
    if (Array.from(request).length > 4000) { element('chat-notice').textContent = 'Reduce el mensaje para dejar espacio al contexto local.'; return; }
    const generation = ++localGeneration;
    const id = localIdentifier(); localBusy = true;
    const controller = new AbortController(); localController = controller;
    const context = createAgentContext(entries, { ...(attachedWork ? { attachedWork } : {}) });
    add({ id: localIdentifier(), role: 'user', text, engine: 'iphone', state: 'complete', at: Date.now() });
    let turnEntry: ChatEntry = { id, role: 'assistant', text: '', engine: 'iphone', state: 'pending', at: Date.now() };
    add(turnEntry);
    prompt.value = ''; sizeDraft(); persist(); updateControls(); setIntent({ working: true, thinking: true }); element('scene-status').textContent = 'Pensando contigo…';
    try {
      // Rebuild a bounded context from the visible timeline, also after app restarts.
      await resetLocal();
      if (generation !== localGeneration) return;
      const runner = createAgentRunner({ waitUntilActive: waitForForeground, tools: [...createLocalTools(), ...createMemoryTools(), ...createConnectionTools(), ...createDesktopTools({ getConnection: () => runtimeConnection }), ...createWorkTools({ getHost: () => linked.ready() ? host : undefined, getDispatcher: operation => {
        if (!linked.ready()) return undefined;
        if (!linked.supportsWorkSync()) throw new Error('Actualiza Gentle Dot en la laptop para transferir trabajos. La conversación sigue disponible y el trabajo local se conserva.');
        if (operation === 'process' && !linked.supportsMeetingDrafts()) throw new Error('Este Gentle Dot no tiene disponible el procesamiento de reuniones. El material confirmado se conserva.');
        return createWorkDispatcher(linked.exchange, host);
      } }).filter(tool => ['work_sync', 'work_recover', 'work_process', 'work_result', 'work_correct'].includes(tool.definition.name))], step: agentStep, onTrace(trace) {
        const entry = entries.find(item => item.id === id) ?? turnEntry;
        const activities = [...entry.activities ?? []]; const at = activities.findIndex(item => item.id === trace.id);
        const activity = { id: trace.id, kind: 'other' as const, title: trace.label, status: trace.status, detail: trace.detail };
        if (at < 0) activities.push(activity); else activities[at] = activity;
        turnEntry = { ...entry, activities, state: generation !== localGeneration && entry.state === 'pending' ? 'interrupted' : entry.state };
        add(turnEntry);
        if (generation === localGeneration) { element('active-tool').textContent = trace.status === 'running' ? trace.label : ''; setIntent({ working: trace.status === 'running', thinking: trace.status !== 'running' }); }
      } });
      const text = await runner.run({ instruction: promptText, context, signal: controller.signal, askApproval: async request => {
        if (generation === localGeneration) setIntent({ alert: true });
        try { return await reviews.approve(request, controller.signal); }
        finally { if (generation === localGeneration) setIntent({ thinking: true }); }
      } });
      if (generation !== localGeneration) return;
      add({ id, role: 'assistant', text, engine: 'iphone', state: 'complete', at: Date.now() });
      setIntent({ outcome: { kind: 'done', at: performance.now() } });
    } catch (error) {
      if (generation === localGeneration) add({ id, role: 'notice', text: errorText(error), engine: 'iphone', state: 'interrupted', at: Date.now() });
    } finally { if (generation === localGeneration) { localBusy = false; element('active-tool').textContent = ''; element('scene-status').textContent = 'Aquí contigo.'; updateControls(); persist(); } }
  } else {
    if (!linked.ready()) { element('chat-notice').textContent = 'La laptop está desconectada. Guarda el trabajo para conservarlo.'; return; }
    const id = remoteId(`pending:${localIdentifier()}`);
    let request: string;
    try { request = linkedPrompt(entries, attachedWork ? `${text}\n\nTengo material guardado sólo en el iPhone como trabajo ${attachedWork}. No tienes sus bytes hasta que se confirme una transferencia; no afirmes haberlo leído.` : text); } catch (error) { element('chat-notice').textContent = errorText(error); return; }
    if (linked.send(request)) {
      pendingRemote = { id, text: request, displayText: text };
      pendingTimer = setTimeout(unconfirmedRemote, 15000);
      add({ id, role: 'user', text, transportText: request, engine: 'gentle', state: 'pending', at: Date.now() });
      prompt.value = ''; sizeDraft(); persist(); updateControls();
    } else element('chat-notice').textContent = 'No se envió. Tu mensaje sigue aquí.';
  }
});
let stoppingLocal: Promise<void> | undefined;
function stopLocal(): Promise<void> {
  if (stoppingLocal) return stoppingLocal;
  const generation = ++localGeneration; localController?.abort();
  stoppingLocal = (async () => {
    try { await cancelLocal(); } catch { /* Native lifecycle also cancels active generation. */ }
    if (generation !== localGeneration) return;
    localBusy = false;
    entries = entries.map(entry => entry.engine === 'iphone' && entry.state === 'pending' ? { ...entry, state: 'interrupted', text: entry.text || 'Respuesta interrumpida.' } : entry);
    element('active-tool').textContent = ''; element('scene-status').textContent = 'Aquí contigo.';
    renderChat(); persist(); setIntent({}); updateControls();
  })().finally(() => { stoppingLocal = undefined; });
  return stoppingLocal;
}
element('stop').addEventListener('click', () => {
  if (localBusy) void stopLocal();
  else if (linked.abort()) element('chat-notice').textContent = 'Se pidió detener la respuesta de Gentle Dot; esperando al host.';
});
element<HTMLFormElement>('connection').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const nextHost = validDaemonUrl(element<HTMLInputElement>('url').value);
    const token = element<HTMLInputElement>('token').value;
    connectionEpoch++;
    runtimeConnection = { url: nextHost, token }; linked.connect(nextHost, token);
    manualToSave = { url: nextHost, token };
    host = nextHost;
    element<HTMLInputElement>('token').value = '';
    settings.url = host; saveSettings(settings);
  } catch (error) { element('status').textContent = errorText(error); }
});
element('disconnect').addEventListener('click', () => { connectionEpoch++; manualToSave = undefined; runtimeConnection = undefined; linked.disconnect(); element<HTMLInputElement>('token').value = ''; if (isTauri() && host) void secretDelete('daemon-manual', new URL(host.replace('wss:', 'https:')).origin).catch(() => {}); });
element('check-local').addEventListener('click', () => void checkModel());
element<HTMLInputElement>('url').value = settings.url;
const connectionSettings = mountConnectionSettings();
const inbox = mountInbox(text => { draftEdited = true; prompt.value = text; scheduleSave(); showPanel('chat'); prompt.focus(); });
const memoryView = mountMemoryView({ status: persistence.status, pending: persistence.pending, visible: () => structuredClone(entries), draft: () => prompt.value, retry: persist });

document.addEventListener('visibilitychange', () => {
  if (document.hidden) release();
  cancelAnimationFrame(frame); fx?.clear(); persist();
  if (document.hidden) { void cancelDictation(); director.update(intent, performance.now(), true); linked.suspend(); }
  else { lastFrame = -1; redraw(); linked.resume(); void checkModel(); void importSharedFiles(); }
});
window.addEventListener('pagehide', () => { connectionSettings.cancel(); cancelAnimationFrame(frame); linked.suspend(); persist(); });
window.addEventListener('pageshow', event => { if (event.persisted) { redraw(); linked.resume(); } });
let conversationLoading = false;
const recoveryMessage = 'No se pudo recuperar la conversación local. Tu borrador sigue aquí; reintenta antes de enviar para proteger el historial guardado.';
async function restoreConversation() {
  if (conversationLoading) return;
  conversationLoading = true;
  const retry = element<HTMLButtonElement>('retry-conversation');
  retry.disabled = true;
  try {
    const saved = await loadConversation();
    const recovered = await conversationArchive.restoreState(saved);
    saved.entries = recovered.entries; persistence.setRevision(recovered.revision);
    // Capture the restored window before live startup events can cause pruning.
    persistence.seed(recovered.preserved); persistence.enqueue(entries, true);
    entries = entries.reduce((history, entry) => updateEntry(history, entry), saved.entries);
    if (!draftEdited) { prompt.value = saved.draft; if (!attachedWork) attachedWork = saved.attachedWork; }
    if (attachedWork) element('attachment-context').textContent = `Material local adjunto · trabajo ${attachedWork}`;
    conversationReady = true;
    retry.hidden = true;
    if (element('chat-notice').textContent === recoveryMessage) element('chat-notice').textContent = '';
    renderChat(); sizeDraft(); await persist();
  } catch {
    element('history-loading').hidden = true;
    // Never overwrite an unread stored timeline with the partial in-memory state.
    element('chat-notice').textContent = recoveryMessage;
    retry.hidden = false;
  } finally {
    conversationLoading = false; retry.disabled = false; updateControls();
    conversationRestored = true; redraw();
  }
}
element('retry-conversation').addEventListener('click', () => void restoreConversation());
async function initialize() {
  updateControls();
  // Independent stores must not delay the character or the native availability
  // check. A late startup read must also never replace newly selected artwork.
  let initialArtworkRevision = assetRevision;
  const artworkReady = (async () => {
    // A corrupt or unreadable override must not suppress the packaged character.
    let art: Blob | undefined;
    try { art = await loadArtwork() ?? undefined; } catch { /* The bundle is independent of IndexedDB. */ }
    if (assetRevision !== initialArtworkRevision) return;
    if (art) {
      try {
        const decoded = useArtwork(art, false); initialArtworkRevision = assetRevision;
        await decoded; return;
      } catch { if (assetRevision !== initialArtworkRevision) return; }
    }
    art = await loadPackagedArtwork();
    if (assetRevision !== initialArtworkRevision) return;
    if (!art) throw new Error('Esta instalación no incluye el arte de Capri. Instala el paquete personal o importa tu PNG en Ajustes.');
    const decoded = useArtwork(art, false); initialArtworkRevision = assetRevision;
    await decoded;
  })().catch(error => {
    if (assetRevision !== initialArtworkRevision) return;
    element('settings-status').textContent = errorText(error);
    element('art-status').textContent = errorText(error);
    element('art-placeholder').textContent = 'No se pudo cargar Capri. Revisa Personaje en Ajustes.';
  });
  const servicesReady = Promise.all([checkModel(), inbox.refresh(), restoreDeviceConnection(), importSharedFiles(), connectionSettings.refresh(), memoryView.refresh()]);
  await Promise.all([artworkReady, servicesReady, restoreConversation()]);
}
queueMicrotask(() => void initialize());

let voiceSession: string | undefined;
let voiceStarting = false;
let voiceController: AbortController | undefined;
let voiceGeneration = 0;
let voiceTimer: ReturnType<typeof setTimeout> | undefined;
async function cancelDictation() {
  voiceGeneration++; voiceController?.abort(); voiceSession = undefined; clearTimeout(voiceTimer);
  if (isTauri()) await cancelVoice().catch(() => {});
  element('dictate').setAttribute('aria-pressed', 'false');
  element('dictate').setAttribute('aria-label', 'Dictar');
}
element('dictate').addEventListener('click', async () => {
  if (voiceStarting) return;
  const current = ++voiceGeneration;
  voiceStarting = true;
  const control = element<HTMLButtonElement>('dictate'); control.disabled = true;
  try {
    if (voiceSession) {
      const id = voiceSession; voiceSession = undefined; clearTimeout(voiceTimer);
      element('voice-status').textContent = 'Transcribiendo en este iPhone…';
      const transcript = await stopVoice(id);
      if (current !== voiceGeneration) return;
      // Voice edits the same draft; nothing is sent without the person's submit.
      prompt.value = `${prompt.value}${prompt.value.trim() ? '\n' : ''}${transcript.text}`;
      draftEdited = true; scheduleSave(); prompt.focus();
      element('voice-status').textContent = 'Transcripción añadida. Puedes corregirla antes de enviar.';
      setIntent({});
    } else {
      voiceController = new AbortController();
      const availability = await checkVoice();
      if (availability.status === 'assets_required') {
        const approved = await reviews.approve({ title: 'Preparar dictado local', details: 'Apple necesita descargar los recursos de voz en español para transcribir en este iPhone. La descarga requiere internet y espacio; después podrás dictar sin conexión.', operation: 'prepare-local-voice' }, voiceController.signal);
        if (!approved || current !== voiceGeneration) return;
        element('voice-status').textContent = 'Preparando voz local con Apple…';
        await prepareVoice();
      }
      if (current !== voiceGeneration) return;
      const session = await startVoice();
      if (current !== voiceGeneration) { await cancelVoice(); return; }
      voiceSession = session.sessionId;
      element('voice-status').textContent = 'Te escucho. Toca Terminar para transcribir.';
      setIntent({ alert: true });
      voiceTimer = setTimeout(() => control.click(), session.maxDurationSeconds * 1000 - 500);
    }
  } catch (error) { if (current === voiceGeneration) element('voice-status').textContent = errorText(error); }
  finally {
    voiceStarting = false; control.disabled = false;
    control.setAttribute('aria-pressed', String(!!voiceSession)); control.setAttribute('aria-label', voiceSession ? 'Terminar dictado' : 'Dictar');
  }
});
element('attach').addEventListener('click', async () => {
  if (!isTauri()) { element<HTMLInputElement>('chat-files').click(); return; }
  const button = element<HTMLButtonElement>('attach'); button.disabled = true;
  try { if (await pickDocuments()) await importDocumentFiles(true); }
  catch (error) { element('chat-notice').textContent = errorText(error); }
  finally { button.disabled = false; }
});
element<HTMLInputElement>('chat-files').addEventListener('change', async event => {
  const control = event.target as HTMLInputElement;
  const files = Array.from(control.files ?? []); if (!files.length) return;
  try {
    const item = await createWork({ title: files[0]!.name.slice(0, 120), kind: files.some(file => file.type.startsWith('audio/')) ? 'meeting' : 'task', instruction: prompt.value.trim() || 'Material adjunto a la conversación de Capri.', files });
    attachedWork = item.id;
    element('attachment-context').textContent = `${files.length} archivo(s) guardados · ${item.title}`;
    notice(`Adjuntos guardados en este iPhone: ${item.title}. Trabajo ${item.id}. Todavía no enviados a la laptop.`, 'iphone');
    control.value = ''; await inbox.refresh();
  } catch (error) { element('chat-notice').textContent = errorText(error); }
});
const pairingUI = mountPairingInput(element<HTMLFormElement>('pairing'), element<HTMLInputElement>('pairing-invitation'));
element<HTMLFormElement>('pairing').addEventListener('submit', async event => {
  event.preventDefault();
  pairingUI.setSubmitting(true);
  try {
    const invitation = parseInvitation(element<HTMLInputElement>('pairing-invitation').value);
    const epoch = ++connectionEpoch;
    element('pairing-status').textContent = 'Esperando la vinculación con Gentle Dot…';
    const result = await pairDevice(invitation);
    if (epoch !== connectionEpoch) return;
    linked.connect(result.connection.url, result.connection.token);
    runtimeConnection = result.connection; host = result.connection.url;
    settings.url = host; saveSettings(settings); element<HTMLInputElement>('url').value = host;
    element<HTMLInputElement>('pairing-invitation').value = '';
    element('pairing-invitation').dispatchEvent(new Event('input', { bubbles: true }));
    element('pairing-status').textContent = result.persisted ? 'iPhone vinculado. Acceso guardado en Keychain.' : result.message ?? 'Vinculado; el acceso no se pudo guardar.';
  } catch (error) { element('pairing-status').textContent = errorText(error); }
  finally { pairingUI.setSubmitting(false); }
});
async function restoreDeviceConnection() {
  if (!isTauri() || !settings.url) return;
  const restoredURL = settings.url;
  const epoch = connectionEpoch;
  try {
    const origin = new URL(restoredURL.replace('wss:', 'https:')).origin;
    let paired;
    try { paired = await restorePairing(origin); } catch { /* Manual hosts may not use Tailscale. */ }
    const token = paired?.token ?? await secretGet('daemon-manual', origin);
    if (token && epoch === connectionEpoch) { runtimeConnection = { url: restoredURL, token }; linked.connect(restoredURL, token); }
  } catch { if (epoch !== connectionEpoch) return; element('status').textContent = 'No se pudo recuperar el acceso guardado. Puedes volver a vincular este iPhone.'; }
}
async function importSharedFiles() {
  if (!isTauri()) return;
  void importDocumentFiles();
  try {
    for (const item of await listSharedImports()) {
      await importSharedItem(item, async ({ sourceId, files }) => {
        const work = await createImportedWork(sourceId, { title: item.title, kind: files.some(file => file.type.startsWith('audio/')) ? 'meeting' : 'task', instruction: item.notes || 'Material compartido con Capri. Pendiente de instrucciones.', files });
        attachedWork = work.id;
        notice(`Recibí ${work.title}. Material guardado localmente como trabajo ${work.id}; dime qué hacemos con él.`, 'iphone', `shared:${item.id}`);
      });
    }
    await inbox.refresh();
  } catch (error) { element('chat-notice').textContent = errorText(error); }
}
function importDocumentFiles(fresh = false): Promise<void> {
  // Returning from UIKit can also trigger foreground recovery. If that older
  // scan began before publication, the explicit pick needs a fresh scan after it.
  if (documentImports) return fresh ? documentImports.then(() => importDocumentFiles()) : documentImports;
  documentImports = (async () => {
    try {
      for (const item of await listDocumentImports()) {
        await importDocumentItem(item, async ({ sourceId, files }) => {
          const work = await createImportedWork(sourceId, { title: item.title, kind: files.some(file => file.type.startsWith('audio/')) ? 'meeting' : 'task',
            instruction: prompt.value.trim() || 'Material adjunto a la conversación de Capri.', files });
          attachedWork = work.id;
          element('attachment-context').textContent = `${files.length} archivo${files.length === 1 ? '' : 's'} · ${work.title}`;
          notice(`Conservé ${work.title} en este iPhone. Dime qué hacemos con el material.`, 'iphone', `document:${item.id}`);
          persist();
        });
      }
      await inbox.refresh();
    } catch (error) { element('chat-notice').textContent = errorText(error); }
  })().finally(() => { documentImports = undefined; });
  return documentImports;
}
