import { createEngine, frameAt } from '@gentle-dot/ui/src/capri2d/engine.ts';
import { RigDirector, type RigIntent } from '@gentle-dot/ui/src/capri2d/director.ts';
import { RigFx } from '@gentle-dot/ui/src/capri2d/fx.ts';
import type { ServerMessage } from '@gentle-dot/protocol';
import { readSettings, saveSettings, loadArtwork, saveArtwork, deleteArtwork, validateArtwork, validDaemonUrl } from './local-state.ts';
import { createLinkedChat, type LinkedStatus } from './linked-chat.ts';
import { checkLocalIntelligence, availabilityMessage, askLocal, cancelLocal, resetLocal, type Availability } from './local-intelligence.ts';
import { loadConversation, saveConversation, updateEntry, reconcileHostHistory, localPrompt, linkedPrompt, type ChatEntry, type Engine } from './conversation.ts';
import { mountInbox } from './inbox-view.ts';
import './style.css';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
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
let panel = 'companion';
let absent = false;
let roaming = false;
let position = { x: 0, y: 0 };
let destination = { x: 0, y: 0 };
let lastTime = 0;
let nextRoam = 0;
let gestureTimer: ReturnType<typeof setTimeout> | undefined;
const isReduced = () => reduced.matches || settings.motion !== 'full';
try { fx = new RigFx(element<HTMLCanvasElement>('fx')); } catch { /* Optional procedural effects. */ }

function place(x: number, y: number) {
  const horizontal = Math.max(0, (stage.clientWidth - 216) / 2 - 4);
  const vertical = Math.max(0, (stage.clientHeight - 306) / 2 - 4);
  position = { x: Math.max(-horizontal, Math.min(horizontal, x)), y: Math.max(-vertical, Math.min(vertical, y)) };
  rig.style.transform = `translate(${position.x}px, ${position.y}px)`;
}
function animate(now: number) {
  if (!engine || document.hidden || !['companion', 'chat'].includes(panel) || absent) return;
  if (roaming && panel === 'companion' && !isReduced()) {
    if (now >= nextRoam) {
      destination = { x: (Math.random() - .5) * Math.max(0, stage.clientWidth - 224), y: (Math.random() - .5) * Math.max(0, stage.clientHeight - 314) };
      nextRoam = now + 6000;
    }
    const step = Math.min(.05, (now - (lastTime || now)) / 1000) * 28;
    const distance = Math.hypot(destination.x - position.x, destination.y - position.y);
    if (distance > 1) {
      intent.direction = destination.x >= position.x ? 1 : -1;
      place(position.x + (destination.x - position.x) / distance * Math.min(step, distance), position.y + (destination.y - position.y) / distance * Math.min(step, distance));
    }
  }
  lastTime = now;
  director.update(intent, now);
  const next = isReduced() ? 0 : frameAt(now, director.fps());
  if (next !== lastFrame || revision !== lastRevision) {
    const sample = director.sample(now, isReduced());
    engine.draw(sample.pose, next);
    if (!isReduced()) for (const cue of sample.cues) fx?.cue(cue, now, intent.direction);
    lastFrame = next; lastRevision = revision;
  }
  if (!isReduced()) fx?.draw(now);
  if (!isReduced()) frame = requestAnimationFrame(animate);
}
function redraw() { document.documentElement.dataset.motion = isReduced() ? 'reduced' : 'full'; revision++; cancelAnimationFrame(frame); lastTime = 0; animate(performance.now()); }
function setIntent(next: RigIntent) { intent = next; redraw(); }
function gesture(name: string) {
  clearTimeout(gestureTimer);
  setIntent({ gesture: { name, at: performance.now() } });
  gestureTimer = setTimeout(() => setIntent({}), 2500);
}
function startRig() {
  cancelAnimationFrame(frame); engine?.dispose(); engine = undefined;
  if (!image) return;
  try {
    engine = createEngine(canvas, image); lastFrame = -1; redraw();
    element('art-status').textContent = 'Tu Capri está aquí. Arrástrala, salúdala o déjala chillear.';
  }
  catch { element('art-status').textContent = 'WebGL no está disponible. La conversación sigue activa.'; }
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
    element('settings-status').textContent = 'Arte guardado en este dispositivo.';
  } finally { URL.revokeObjectURL(url); }
}
canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); cancelAnimationFrame(frame); engine?.dispose(); engine = undefined; element('art-status').textContent = 'Recuperando el personaje…'; });
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
    ++assetRevision; await deleteArtwork(); image = undefined; cancelAnimationFrame(frame); engine?.dispose(); engine = undefined; fx?.clear();
    element('art-placeholder').hidden = false; element('settings-status').textContent = 'Arte local eliminado.';
    element('art-status').textContent = 'Carga tu arte en Ajustes para activar el personaje.';
  } catch (error) { element('settings-status').textContent = errorText(error); }
});
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
  roaming = false; element('roam').setAttribute('aria-pressed', 'false');
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: { ...position }, moved: false };
  rig.setPointerCapture(event.pointerId);
});
rig.addEventListener('pointermove', event => {
  if (!drag || drag.id !== event.pointerId) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (Math.hypot(dx, dy) > 5) drag.moved = true;
  if (drag.moved) { place(drag.start.x + dx, drag.start.y + dy); setIntent({ dragging: true }); }
});
function release() { if (!drag) return; suppressClick = drag.moved; drag = undefined; setIntent({}); }
rig.addEventListener('pointerup', release); rig.addEventListener('pointercancel', release);
rig.addEventListener('click', () => { if (suppressClick) { suppressClick = false; return; } if (image) gesture('saludar'); else showPanel('settings'); });
window.addEventListener('resize', () => place(position.x, position.y));

function showPanel(next: string) {
  panel = next;
  if (next === 'chat') element('chat-companion').append(stage);
  else element('panel-companion').insertBefore(stage, element('art-status'));
  stage.classList.toggle('compact', next === 'chat');
  place(0, 0);
  for (const section of document.querySelectorAll<HTMLElement>('.panel')) section.hidden = section.id !== `panel-${next}`;
  for (const button of document.querySelectorAll<HTMLElement>('[data-panel]')) {
    if (button.dataset.panel === next) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  redraw();
  if (next === 'inbox') void inbox.refresh();
}
for (const button of document.querySelectorAll<HTMLElement>('[data-panel]')) button.addEventListener('click', () => showPanel(button.dataset.panel!));
element('open-chat').addEventListener('click', () => { showPanel('chat'); element('prompt').focus(); });
function errorText(error: unknown) { return error instanceof Error ? error.message : 'No se pudo completar la operación.'; }

// The UI owns one durable conversation; each transport has an explicit trust boundary.
const prompt = element<HTMLTextAreaElement>('prompt');
let entries: ChatEntry[] = [];
let selected: Engine = 'iphone';
let availability: Availability = { available: false, status: 'checking', supportsSpanish: false };
let linkedStatus: LinkedStatus = 'offline';
let linkedBusy = false;
let localBusy = false;
let localGeneration = 0;
let conversationReady = false;
let draftEdited = false;
let host = settings.url;
let remoteConversation = 'default';
let pendingRemote: { id: string; text: string; displayText: string } | undefined;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saveChain = Promise.resolve();
function persist() {
  if (!conversationReady) return;
  clearTimeout(saveTimer);
  const snapshot = { entries: structuredClone(entries), draft: prompt.value };
  saveChain = saveChain.then(() => saveConversation(snapshot)).catch(() => {
    element('chat-notice').textContent = 'No se pudo guardar la conversación. No cierres Capri hasta conservar el texto.';
  });
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 250); }
function renderChat() {
  const container = element('cards');
  const nodes = new Map(Array.from(container.children).map(child => [(child as HTMLElement).dataset.id, child as HTMLElement]));
  for (const entry of entries) {
    let node = nodes.get(entry.id);
    if (!node) {
      node = document.createElement('article'); node.className = 'chat-card'; node.dataset.id = entry.id;
      const label = document.createElement('div'); label.className = 'chat-label';
      const text = document.createElement('p'); text.className = 'chat-text';
      const state = document.createElement('small'); node.append(label, text, state);
    }
    node.dataset.role = entry.role;
    node.children[0]!.textContent = `${entry.role === 'user' ? 'TÚ' : entry.role === 'notice' ? 'AVISO' : 'CAPRI'} / ${entry.engine === 'iphone' ? 'IPHONE' : 'GENTLE DOT'}`;
    node.children[1]!.textContent = entry.text;
    node.children[2]!.textContent = entry.state === 'pending' ? (entry.role === 'user' ? 'Esperando confirmación del host…' : 'Preparando respuesta…') : entry.state === 'interrupted' ? 'Interrumpido o sin confirmar. No se reenvía automáticamente.' : '';
    container.append(node);
    nodes.delete(entry.id);
  }
  for (const node of nodes.values()) node.remove();
}
function add(entry: ChatEntry) { entries = updateEntry(entries, entry); renderChat(); scheduleSave(); }
function notice(text: string, target: Engine = selected, id: string = crypto.randomUUID()) { add({ id, role: 'notice', text, engine: target, state: 'complete', at: Date.now() }); }
function remoteId(id: string) { return `host:${host}|${remoteConversation}|${id}`; }
function updateControls() {
  const ready = selected === 'iphone' ? availability.available && availability.supportsSpanish : linkedStatus === 'ready';
  const busy = localBusy || (selected === 'gentle' && (linkedBusy || !!pendingRemote));
  element<HTMLButtonElement>('send').disabled = !conversationReady || !ready || busy;
  element<HTMLSelectElement>('engine').disabled = localBusy || !!pendingRemote;
  element('stop').hidden = !(localBusy || (selected === 'gentle' && linkedBusy));
  prompt.maxLength = selected === 'iphone' ? 2400 : 8000;
  element('engine-badge').textContent = selected === 'iphone' ? 'EN ESTE IPHONE' : 'EN TU LAPTOP';
  element('engine-status').textContent = selected === 'iphone' ? availabilityMessage(availability) : linkedStatus === 'ready' ? 'Vinculado. Se enviarán tu mensaje y hasta cuatro turnos locales recientes a la laptop.' : 'Conecta Gentle Dot en Ajustes. Puedes guardar el trabajo mientras tanto.';
}
function unconfirmedRemote() {
  if (!pendingRemote) return;
  const id = pendingRemote.id;
  entries = entries.map(entry => entry.id === id ? { ...entry, state: 'interrupted' } : entry);
  pendingRemote = undefined; clearTimeout(pendingTimer); renderChat(); scheduleSave(); updateControls();
}
async function checkModel() {
  availability = await checkLocalIntelligence();
  element('local-status').textContent = availabilityMessage(availability); updateControls();
}
function handleMessage(message: ServerMessage) {
  if (message.type === 'ready') { remoteConversation = message.conversationId ?? 'default'; linkedBusy = ['thinking', 'working', 'needs_you'].includes(message.agentState); }
  if (message.type === 'agent_state') {
    linkedBusy = ['thinking', 'working', 'needs_you'].includes(message.state);
    if (selected === 'gentle') setIntent({ working: linkedBusy, thinking: message.state === 'thinking', alert: message.state === 'needs_you' });
  }
  if (message.type === 'history') {
    remoteConversation = message.conversationId ?? remoteConversation;
    entries = reconcileHostHistory(entries, remoteId(''), message.messages.slice(-60));
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
  if (message.type === 'toast' || message.type === 'error') notice(message.message, 'gentle');
  if (message.type === 'error') unconfirmedRemote();
  if (message.type === 'ask') notice(`${message.ask.title}\n${message.ask.message ?? ''}\nRevisa esta autorización en la laptop. Capri no la aprobará automáticamente.`, 'gentle', remoteId(`ask:${message.ask.requestId}`));
  if (message.type === 'ask_resolved') {
    const entry = entries.find(item => item.id === remoteId(`ask:${message.requestId}`));
    if (entry) add({ ...entry, text: `${entry.text}\nResuelta en el host.` });
  }
  updateControls();
}
const linked = createLinkedChat({
  onStatus(value) {
    linkedStatus = value;
    element('status').textContent = { offline: 'Sin conexión', connecting: 'Conectando…', ready: 'Vinculado a Gentle Dot', rejected: 'Acceso rechazado. Revisa token y versión.' }[value];
    element('connection-badge').textContent = value === 'ready' ? 'VINCULADO' : 'LOCAL';
    if (value !== 'ready') {
      linkedBusy = false;
      entries = entries.map(entry => entry.engine === 'gentle' && entry.id.startsWith(`host:${host}|`) && entry.state === 'pending' ? { ...entry, state: 'interrupted' } : entry);
      unconfirmedRemote();
      renderChat(); scheduleSave();
    }
    updateControls();
  }, onMessage: handleMessage,
});
element<HTMLSelectElement>('engine').addEventListener('change', () => { selected = element<HTMLSelectElement>('engine').value as Engine; updateControls(); });
prompt.addEventListener('input', () => { draftEdited = true; scheduleSave(); });
element<HTMLFormElement>('composer').addEventListener('submit', async event => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text || localBusy || (selected === 'gentle' && linkedBusy) || pendingRemote || !conversationReady) return;
  element('chat-notice').textContent = '';
  if (selected === 'iphone') {
    if (!availability.available || !availability.supportsSpanish) { updateControls(); return; }
    if (Array.from(text).length > 2400) { element('chat-notice').textContent = 'Usa hasta 2400 caracteres con el motor local; puedes guardar un trabajo más largo.'; return; }
    const request = localPrompt(entries, text);
    if (Array.from(request).length > 4000) { element('chat-notice').textContent = 'Reduce el mensaje para dejar espacio al contexto local.'; return; }
    const generation = ++localGeneration;
    const id = crypto.randomUUID(); localBusy = true;
    add({ id: crypto.randomUUID(), role: 'user', text, engine: 'iphone', state: 'complete', at: Date.now() });
    add({ id, role: 'assistant', text: '', engine: 'iphone', state: 'pending', at: Date.now() });
    prompt.value = ''; persist(); updateControls(); setIntent({ working: true, thinking: true });
    try {
      // Rebuild a bounded context from the visible timeline, also after app restarts.
      await resetLocal();
      if (generation !== localGeneration) return;
      const response = await askLocal(request);
      if (generation !== localGeneration) return;
      add({ id, role: 'assistant', text: response.ok ? response.text ?? '' : response.message ?? 'No se pudo generar la respuesta.', engine: 'iphone', state: response.ok ? 'complete' : 'interrupted', at: Date.now() });
      setIntent({ outcome: { kind: response.ok ? 'done' : 'error', at: performance.now() } });
    } catch (error) {
      if (generation === localGeneration) add({ id, role: 'notice', text: errorText(error), engine: 'iphone', state: 'interrupted', at: Date.now() });
    } finally { if (generation === localGeneration) { localBusy = false; updateControls(); persist(); } }
  } else {
    if (!linked.ready()) { element('chat-notice').textContent = 'La laptop está desconectada. Guarda el trabajo para conservarlo.'; return; }
    const id = remoteId(`pending:${crypto.randomUUID()}`);
    const request = linkedPrompt(entries, text);
    if (linked.send(request)) {
      pendingRemote = { id, text: request, displayText: text };
      pendingTimer = setTimeout(unconfirmedRemote, 15000);
      add({ id, role: 'user', text, transportText: request, engine: 'gentle', state: 'pending', at: Date.now() });
      prompt.value = ''; persist(); updateControls();
    } else element('chat-notice').textContent = 'No se envió. Tu mensaje sigue aquí.';
  }
});
async function stopLocal() {
  ++localGeneration;
  try { await cancelLocal(); } catch { /* Native lifecycle also cancels active generation. */ }
  localBusy = false;
  entries = entries.map(entry => entry.engine === 'iphone' && entry.state === 'pending' ? { ...entry, state: 'interrupted', text: entry.text || 'Respuesta interrumpida.' } : entry);
  renderChat(); persist(); setIntent({}); updateControls();
}
element('stop').addEventListener('click', () => {
  if (localBusy) void stopLocal();
  else if (linked.abort()) element('chat-notice').textContent = 'Se pidió detener la respuesta de Gentle Dot; esperando al host.';
});
element<HTMLFormElement>('connection').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const nextHost = validDaemonUrl(element<HTMLInputElement>('url').value);
    linked.connect(nextHost, element<HTMLInputElement>('token').value);
    host = nextHost;
    element<HTMLInputElement>('token').value = '';
    settings.url = host; saveSettings(settings);
  } catch (error) { element('status').textContent = errorText(error); }
});
element('disconnect').addEventListener('click', () => { linked.disconnect(); element<HTMLInputElement>('token').value = ''; });
element('check-local').addEventListener('click', () => void checkModel());
element<HTMLInputElement>('url').value = settings.url;
const inbox = mountInbox(text => { draftEdited = true; prompt.value = text; scheduleSave(); showPanel('chat'); prompt.focus(); });

document.addEventListener('visibilitychange', () => {
  cancelAnimationFrame(frame); fx?.clear(); persist();
  if (document.hidden) { director.update(intent, performance.now(), true); linked.suspend(); if (localBusy) void stopLocal(); }
  else { lastFrame = -1; redraw(); linked.resume(); void checkModel(); }
});
window.addEventListener('pagehide', () => { cancelAnimationFrame(frame); linked.suspend(); persist(); if (localBusy) void stopLocal(); });
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
    entries = entries.reduce((history, entry) => updateEntry(history, entry), saved.entries);
    if (!draftEdited) prompt.value = saved.draft;
    conversationReady = true;
    retry.hidden = true;
    if (element('chat-notice').textContent === recoveryMessage) element('chat-notice').textContent = '';
    renderChat(); persist();
  } catch {
    // Never overwrite an unread stored timeline with the partial in-memory state.
    element('chat-notice').textContent = recoveryMessage;
    retry.hidden = false;
  } finally {
    conversationLoading = false; retry.disabled = false; updateControls();
  }
}
element('retry-conversation').addEventListener('click', () => void restoreConversation());
async function initialize() {
  updateControls();
  // Independent stores must not delay the character or the native availability
  // check. A late startup read must also never replace newly selected artwork.
  const initialArtworkRevision = assetRevision;
  const artworkReady = loadArtwork().then(async art => {
    if (art && assetRevision === initialArtworkRevision) await useArtwork(art, false);
  }).catch(error => { element('settings-status').textContent = errorText(error); });
  const servicesReady = Promise.all([checkModel(), inbox.refresh()]);
  await Promise.all([artworkReady, servicesReady, restoreConversation()]);
}
void initialize();
