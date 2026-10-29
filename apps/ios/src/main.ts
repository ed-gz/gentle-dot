import { localIdentifier } from './local-identifiers.ts';
import { waitForForeground } from './foreground.ts';
import { pickDocuments, listDocumentImports, importDocumentItem } from './document-import.ts';
import { createEngineAsync, frameAt } from '@gentle-dot/ui/src/capri2d/engine.ts';
import { RoamDirector, type RoamPosition } from '@gentle-dot/ui/src/capri2d/roam.ts';
import { occupiedPhoneSpace, phonePerches, phonePositionFree } from './companion-space.ts';
import { RigDirector, type RigIntent } from '@gentle-dot/ui/src/capri2d/director.ts';
import { RigFx } from '@gentle-dot/ui/src/capri2d/fx.ts';
import type { ServerMessage } from '@gentle-dot/protocol';
import { readSettings, saveSettings, loadArtwork, saveArtwork, deleteArtwork, validateArtwork, validDaemonUrl } from './local-state.ts';
import { createLinkedChat, type LinkedStatus } from './linked-chat.ts';
import { checkLocalIntelligence, availabilityMessage, agentStep, cancelLocal, resetLocal, type Availability } from './local-intelligence.ts';
import { listInferenceResults, acknowledgeInference, recoverInferenceResults, withInferenceDeadline } from './inference-recovery.ts';
import { mountCompletionNotifications } from './completion-notifications.ts';
import { mountContinuedInferenceSettings } from './continued-inference-settings.ts';
import { createLiveActivityCoordinator } from './live-activity-coordinator.ts';
import { mountLiveActivitySettings } from './live-activity-settings.ts';
import type { ActivityPhase, ActivityEnd } from './live-activity.ts';
import { loadConversation, updateEntry, reconcileHostHistory, localPrompt, linkedPrompt, type ChatEntry, type Engine } from './conversation.ts';
import { mountInbox } from './inbox-view.ts';
import { conversationArchive } from './conversation-archive.ts';
import { applyConversationEntry, createConversationPersistence } from './conversation-persistence.ts';
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
import { checkVoice, prepareVoice, startVoice, stopVoice, cancelVoice, voiceCancelWithDeadline, voiceAvailabilityNote, VoiceCancelUnconfirmed, VoiceRetryPending } from './perception.ts';
import { rememberVoiceOrigin, voiceOrigin, forgetVoiceOrigin, markVoiceCancellation, clearVoiceCancellation, pendingVoiceCancellation } from './voice-origin.ts';
import { isTauri } from '@tauri-apps/api/core';
import { listSharedImports, importSharedItem, recoverImportBatch } from './device-bridge.ts';
import { parseInvitation, pairDevice } from './device-pairing.ts';
import { ConnectionSelectionAmbiguous, ConnectionSelectionPending, createConnectionSelectionStore, type SelectedConnection } from './connection-selection.ts';
import { mountPairingSaveRecovery } from './pairing-save-recovery.ts';
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
import { createFramePacer } from './frame-pacer.ts';
import { createPresenceTransition, type PresenceSample } from './companion-presence-transition.ts';
import './composer.css';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let documentImports: Promise<void> | undefined;
let sharedImports: Promise<void> | undefined;
element('build-info').textContent = buildLabel();
element('build-info').title = buildInfo.sourceCommit ?? '';
const settings = readSettings();
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const canvas = element<HTMLCanvasElement>('capri');
const rig = element<HTMLButtonElement>('rig-handle');
const stage = element('stage');
const director = new RigDirector();
let engine: Awaited<ReturnType<typeof createEngineAsync>> | undefined;
let preparingRig: AbortController | undefined;
let rigNeedsPreparation = false;
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
const presenceTransition = createPresenceTransition();
let presenceState = presenceTransition.settle();
let roaming = true;
let position = { x: 0, y: 0 };
const roamDirector = new RoamDirector();
let travel: { started: number; target: RoamPosition; moved: boolean } | undefined;
let perched: Pick<RigIntent, 'resting' | 'direction'> = {};
let measuredAt = -Infinity;
let safePerches: [number, number][] = [];
stage.dataset.companionLayer = 'true';
const mainElement = document.querySelector('main')!;
// The small dock in the navigation is the last-resort safe position when all
// free space is occupied. It does not reserve a blank strip above the content.
const companionDock = element('companion-dock');
mainElement.append(stage);
let lastTime = 0;
let nextRoam = 0;
let gestureTimer: ReturnType<typeof setTimeout> | undefined;
let humanGesture: RigIntent['gesture'];
let theater: ReturnType<typeof import('./companion-theater.tsx')['createCompanionTheater']> | undefined;
let theaterLoading: Promise<void> | undefined;
let introShown = false;
let introReplayPending = false;
let lastCompanionInteraction = -Infinity;
let companionInteractionRevision = 0;
let theaterExplicit = false;
function noteCompanionInteraction() { lastCompanionInteraction = performance.now(); companionInteractionRevision++; }
document.addEventListener('pointerdown', noteCompanionInteraction, { capture: true, passive: true });
document.addEventListener('keydown', noteCompanionInteraction, true);
const isReduced = () => reduced.matches || settings.motion !== 'full';
try { fx = new RigFx(element<HTMLCanvasElement>('fx')); } catch { /* Optional procedural effects. */ }

function movementBounds() {
  return companionBounds({ width: stage.clientWidth, height: stage.clientHeight }, { width: rig.offsetWidth, height: rig.offsetHeight }, rig.classList.contains('docked') ? 0 : 4);
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
  // Work events can arrive during a greeting. Retain the latest real state,
  // but let the explicit gesture finish before showing an outcome animation.
  const visible = humanGesture ? { ...intent, outcome: undefined, gesture: humanGesture } : intent;
  if (attention) return { ...visible, question: 'review' };
  if (typing && !visible.working && !visible.dragging && !visible.gesture) return { ...visible, resting: 'sit', watching: true };
  return Object.keys(visible).length ? { direction: perched.direction, ...visible } : perched;
}
function layoutCompanion() {
  const main = document.querySelector('main')!.getBoundingClientRect();
  const emptyChat = panel === 'chat' && element('panel-chat').dataset.empty === 'true';
  const active = element(`panel-${panel}`);
  const area = active.getBoundingClientRect();
  const masthead = document.querySelector('.masthead')!.getBoundingClientRect();
  const top = masthead.top;
  const input = active.querySelector('#composer, .agent-reply');
  const bottom = Math.max(masthead.bottom, input?.getBoundingClientRect().top ?? Math.min(area.bottom, main.bottom) - 12);
  Object.assign(stage.style, { left: `${area.left}px`, top: `${top}px`, width: `${area.width}px`, height: `${Math.max(0, bottom - top)}px` });
  stage.hidden = !presenceState.visible || !engine || !['chat', 'agents', 'inbox', 'settings'].includes(panel);
  document.documentElement.dataset.companionSize = emptyChat ? 'hero' : 'rail';
  measuredAt = -Infinity;
  place(position.x, position.y);
}
const framePacer = createFramePacer();
function animate(now: number) {
  // Let the persisted transcript reach the DOM before the first GPU frame.
  // Software renderers can block unrelated IndexedDB callbacks during warmup.
  if (!conversationRestored || !engine || document.hidden || !['agents', 'chat', 'inbox', 'settings'].includes(panel) || !presenceState.visible) return;
  if (!isReduced() && !framePacer.ready(now)) { frame = requestAnimationFrame(animate); return; }
  if (intent.outcome && now - intent.outcome.at > 2400) { const { outcome: _outcome, ...rest } = intent; intent = rest; revision++; }
  if (now - measuredAt >= 1000) {
    layoutCompanion(); measuredAt = now;
    const area = stage.getBoundingClientRect();
    const occupied = [
      ...occupiedPhoneSpace(element(`panel-${panel}`), area),
      ...occupiedPhoneSpace(document.querySelector<HTMLElement>('.masthead')!, area),
    ];
    // Evaluate normal-size perches even if the previous frame used the dock.
    // A dense page should never make the character vanish just because there
    // is no free full-size rectangle.
    const wasDocked = rig.classList.contains('docked');
    rig.classList.remove('docked');
    safePerches = phonePerches({ x: 0, y: 0, width: area.width, height: area.height },
      { width: rig.offsetWidth, height: rig.offsetHeight }, occupied);
    rig.style.visibility = '';
    if (!safePerches.length) {
      rig.classList.add('docked');
      travel = undefined;
      const dock = companionDock.getBoundingClientRect();
      place(dock.left + dock.width / 2 - area.left - area.width / 2,
        dock.top + dock.height / 2 - area.top - area.height / 2);
    } else if (!drag) {
      const here = { x: position.x + (area.width - rig.offsetWidth) / 2, y: position.y + (area.height - rig.offsetHeight) / 2, width: rig.offsetWidth, height: rig.offsetHeight };
      if (travel && (!phonePositionFree(here, occupied) || !phonePositionFree({ x: travel.target.x, y: travel.target.y, width: rig.offsetWidth, height: rig.offsetHeight }, occupied))) {
        // A scroll or a new control can invalidate either end of an ongoing
        // teleport. Cancel it before it can land on a newly occupied control.
        travel = undefined; revision++;
      }
      // A manual placement or resting pose must not cover controls introduced
      // later. Preserve it when safe, otherwise choose the closest free perch.
      if (!travel && (wasDocked || !phonePositionFree(here, occupied))) {
        const closest = safePerches.reduce<[number, number] | undefined>((best, candidate) =>
          !best || Math.hypot(candidate[0] - here.x, candidate[1] - here.y) < Math.hypot(best[0] - here.x, best[1] - here.y) ? candidate : best, undefined);
        if (closest) place(closest[0] - (area.width - rig.offsetWidth) / 2, closest[1] - (area.height - rig.offsetHeight) / 2);
      }
    }
  }
  if (roaming && !presenceState.transitioning && !drag && !travel && now >= nextRoam) {
    const region = { x: 0, y: 0, width: stage.clientWidth, height: stage.clientHeight };
    const next = roamDirector.step({ laptop: region, region, x: 0, y: 0, width: rig.offsetWidth, height: rig.offsetHeight, herdr: false, safePerches }, now,
      { composer: typing || Boolean(document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')),
        question: attention, paused: isReduced() || Boolean(intent.working || humanGesture || intent.outcome) });
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
  if (presenceState.transitioning) {
    applyPresenceSample(presenceTransition.sample(now), now);
    if (presenceState.transitioning && presenceState.pose) {
      rig.dataset.pose = 'teleport';
      engine.draw(presenceState.pose, frameAt(now, 24));
      fx?.draw(now);
      framePacer.submitted(now); frame = requestAnimationFrame(animate);
      return;
    }
    if (!presenceState.visible) return;
    // The first ordinary frame must replace the transition drawing.
    lastFrame = -1; revision++;
  }
  const next = isReduced() ? 0 : frameAt(now, director.fps());
  if (next !== lastFrame || revision !== lastRevision) {
    const sample = director.sample(now, isReduced());
    rig.dataset.pose = sample.act;
    engine.draw(sample.pose, next);
    if (!isReduced()) for (const cue of sample.cues) fx?.cue(cue, now, intent.direction);
    lastFrame = next; lastRevision = revision;
  }
  if (!isReduced()) fx?.draw(now);
  if (!isReduced()) { framePacer.submitted(now); frame = requestAnimationFrame(animate); }
}
function redraw() { document.documentElement.dataset.motion = isReduced() ? 'reduced' : 'full'; revision++; cancelAnimationFrame(frame); framePacer.wake(); lastTime = 0; frame = requestAnimationFrame(animate); }
function applyPresenceSample(sample: PresenceSample, now: number) {
  const visibilityChanged = presenceState.visible !== sample.visible;
  presenceState = sample;
  rig.disabled = !sample.targetVisible || sample.transitioning;
  rig.style.pointerEvents = sample.transitioning ? 'none' : '';
  rig.dataset.presence = sample.transitioning ? (sample.targetVisible ? 'entering' : 'exiting') : (sample.visible ? 'visible' : 'hidden');
  for (const cue of sample.cues) fx?.cue(cue, now, intent.direction);
  if (visibilityChanged) layoutCompanion();
}
function settlePresence() { applyPresenceSample(presenceTransition.settle(), performance.now()); }
function pauseRigPreparation() {
  if (!preparingRig) return;
  rigNeedsPreparation = true;
  const operation = preparingRig; preparingRig = undefined; operation.abort();
}
function setIntent(next: RigIntent) { intent = next; if (next.gesture || next.dragging || next.question || next.working) travel = undefined; redraw(); }
function gesture(name: string) {
  clearTimeout(gestureTimer);
  const greeting = { name, at: performance.now() };
  humanGesture = greeting; travel = undefined; redraw();
  gestureTimer = setTimeout(() => {
    if (humanGesture !== greeting) return;
    humanGesture = undefined; redraw();
  }, 2500);
}
function companionTheaterSafe() {
  const focused = document.activeElement;
  return Boolean(conversationRestored && engine && panel === 'chat' && !absent && !isReduced() && !document.hidden
    && !typing && !attention && !localBusy && !linkedBusy && !voiceSession && !voiceStarting
    && !(focused instanceof HTMLElement && focused.matches('input, textarea, select, [contenteditable="true"]')));
}
function companionTheaterAllowed() {
  return companionTheaterSafe() && (theaterExplicit || element('panel-chat').dataset.empty === 'true');
}
function maybeStartCompanionIntro() {
  // Never surprise someone with the delayed startup choreography after they
  // already began using the app. An explicit appearance may still replay it.
  if ((!introReplayPending && (introShown || lastCompanionInteraction !== -Infinity || element('panel-chat').dataset.empty !== 'true')) || !companionTheaterSafe() || theaterLoading) return;
  const replay = introReplayPending;
  const interactionAtRequest = companionInteractionRevision;
  theaterLoading = import('./companion-theater.tsx').then(({ createCompanionTheater }) => {
    theater ??= createCompanionTheater({ canPlay: companionTheaterAllowed, onGesture: gesture, onFinish(reason) {
      theaterExplicit = false;
      if (reason === 'complete') setTimeout(() => {
        if (performance.now() - lastCompanionInteraction > 3000 && companionTheaterAllowed()) theater?.startPossession();
      }, 8000);
    } });
    if (companionInteractionRevision !== interactionAtRequest) { if (replay) introReplayPending = false; return; }
    theaterExplicit = replay;
    if (companionTheaterAllowed() && theater.startIntro(replay)) { introShown = true; introReplayPending = false; }
    else theaterExplicit = false;
  }).catch(() => { /* The conversation and 2D rig do not depend on this optional effect. */ })
    .finally(() => { theaterLoading = undefined; });
}
async function startRig() {
  settlePresence();
  const previous = preparingRig; preparingRig = undefined; previous?.abort(); cancelAnimationFrame(frame); engine?.dispose(); engine = undefined;
  layoutCompanion();
  rigNeedsPreparation = Boolean(image);
  if (!image) return;
  rig.dataset.ready = 'false';
  // Do not poll shader compilation while WKWebView is in the background.
  // The current artwork remains in memory and gets one new attempt on return.
  if (document.hidden) return;
  const operation = new AbortController(); preparingRig = operation;
  try {
    const prepared = await createEngineAsync(canvas, image, { maskReadback: false }, operation.signal);
    if (operation.signal.aborted || preparingRig !== operation) { prepared.dispose(); return; }
    engine = prepared; rigNeedsPreparation = false; layoutCompanion(); lastFrame = -1; rig.dataset.ready = 'true'; element('art-placeholder').hidden = true; place(position.x, position.y); redraw();
    element('art-status').textContent = 'Tu Capri está aquí. Arrástrala, salúdala o déjala chillear.'; maybeStartCompanionIntro();
  }
  catch {
    if (operation.signal.aborted || preparingRig !== operation) return;
    rigNeedsPreparation = false;
    rig.dataset.ready = 'false'; element('art-placeholder').hidden = false; element('art-placeholder').textContent = 'No se pudo iniciar el personaje 2D. Vuelve a abrir Capri.'; element('art-status').textContent = 'WebGL no está disponible. La conversación sigue activa.';
  } finally { if (preparingRig === operation) preparingRig = undefined; }
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
    image = next; element('art-placeholder').hidden = true;
    if (persist) element('settings-status').textContent = 'Arte guardado en este dispositivo.';
    await startRig();
  } finally { URL.revokeObjectURL(url); }
}
canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); settlePresence(); const previous = preparingRig; preparingRig = undefined; previous?.abort(); rigNeedsPreparation = false; cancelAnimationFrame(frame); engine?.dispose(); engine = undefined; rig.dataset.ready = 'false'; layoutCompanion(); element('art-status').textContent = 'Recuperando el personaje…'; });
canvas.addEventListener('webglcontextrestored', startRig);
reduced.addEventListener('change', () => { if (isReduced()) settlePresence(); fx?.clear(); redraw(); });
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
  if (isReduced()) settlePresence(); fx?.clear(); redraw();
});
element('greet').addEventListener('click', () => { gesture('saludar'); element('scene-status').textContent = 'Hey. Aquí estoy.'; });
element('chill').addEventListener('click', () => { roaming = false; element('roam').setAttribute('aria-pressed', 'false'); setIntent({ resting: 'sit' }); element('scene-status').textContent = 'Chilleando contigo.'; });
element('roam').addEventListener('click', () => { roaming = !roaming; nextRoam = 0; element('roam').setAttribute('aria-pressed', String(roaming)); setIntent({}); element('scene-status').textContent = roaming ? 'Explorando mi espacio.' : 'Aquí contigo.'; });
element('appear').addEventListener('click', () => {
  absent = !absent; travel = undefined; theater?.stop(); introReplayPending = false;
  element('appear').textContent = absent ? 'Aparecer' : 'Desaparecer';
  element('scene-status').textContent = absent ? 'Vuelvo cuando me llames.' : 'De vuelta.';
  fx?.clear();
  const now = performance.now();
  applyPresenceSample(presenceTransition.request(!absent, now, Boolean(engine && conversationRestored && !document.hidden && !isReduced())), now);
  redraw();
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
function release() { if (!drag) return; suppressClick = drag.moved; drag = undefined; measuredAt = -Infinity; const { dragging: _dragging, ...current } = intent; setIntent(current); }
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
  if (next !== 'chat' && voiceRetry) {
    // Relinquish the view, not the preserved native recording. Its origin is
    // retained so only this conversation may later adopt it.
    voiceGeneration++; voiceSession = undefined; voiceOwner = undefined; voiceRetry = false; element('discard-voice').hidden = true;
  } else if (next !== 'chat' && (voiceSession || (voiceStarting && !voiceStopping))) void cancelDictation();
  for (const section of document.querySelectorAll<HTMLElement>('.panel')) section.hidden = section.id !== `panel-${next}`;
  for (const button of document.querySelectorAll<HTMLElement>('[data-panel]')) {
    if (button.dataset.panel === next) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  travel = undefined; nextRoam = 0; layoutCompanion(); redraw();
  if (next === 'chat') maybeStartCompanionIntro(); else theater?.stop();
  if (next === 'inbox') { void inbox.refresh(); void memoryView.refresh(); }
  if (next === 'chat') void recoverPendingVoice();
}
for (const button of document.querySelectorAll<HTMLElement>('[data-panel]')) button.addEventListener('click', () => showPanel(button.dataset.panel!));
const navigation = document.querySelector<HTMLElement>('.navigation');
navigation?.removeAttribute('inert');
navigation?.removeAttribute('aria-busy');
element('navigation-loading').hidden = true;
function errorText(error: unknown) { return error instanceof Error ? error.message : 'No se pudo completar la operación.'; }

// The UI owns one durable conversation; each transport has an explicit trust boundary.
const prompt = element<HTMLTextAreaElement>('prompt');
let entries: ChatEntry[] = [];
let selected: Engine = 'iphone';
let preference: Engine | 'auto' = 'auto';
let localController: AbortController | undefined;
let attachedWork: string | undefined;
function showAttachedWork(id: string | undefined, label?: string) {
  attachedWork = id;
  const button = element<HTMLButtonElement>('view-material');
  button.hidden = !id;
  // Do not let a fast navigation/reload outrun the durable conversation
  // reference. The work itself is saved independently in IndexedDB.
  button.disabled = Boolean(id);
  if (label !== undefined) element('attachment-context').textContent = label;
  else if (!id) element('attachment-context').textContent = '';
}
function releaseAttachedWork(id: string | undefined) {
  if (id && id === attachedWork && conversationReady) element<HTMLButtonElement>('view-material').disabled = false;
}
let connectionEpoch = 0;
const connectionSelection = createConnectionSelectionStore();
type ManualAttempt = { connection: SelectedConnection & { source: 'manual' }; ticket: number; epoch: number; previous?: SelectedConnection };
let manualAttempt: ManualAttempt | undefined;
let manualSavePending: ManualAttempt | undefined;
type PairingPending = { ticket: number; epoch: number; connection: SelectedConnection & { source: 'paired' }; previous?: SelectedConnection };
let pairingSavePending: PairingPending | undefined;
let pairingAttempt: (PairingPending & { resolve(): void; reject(error: Error): void }) | undefined;
let runtimeConnection: SelectedConnection | undefined;
let connectionBusy = false;
let restorationUncertain = false;
const retryManualSave = document.createElement('button');
retryManualSave.type = 'button'; retryManualSave.id = 'retry-manual-save'; retryManualSave.textContent = 'Volver a guardar acceso'; retryManualSave.hidden = true;
element('status').after(retryManualSave);
const recoverPreviousAccess = document.createElement('button');
recoverPreviousAccess.type = 'button'; recoverPreviousAccess.id = 'recover-previous-access'; recoverPreviousAccess.textContent = 'Recuperar acceso anterior'; recoverPreviousAccess.hidden = true;
element('pairing-status').after(recoverPreviousAccess);
const retryPendingAccess = document.createElement('button');
retryPendingAccess.type = 'button'; retryPendingAccess.id = 'retry-pending-access'; retryPendingAccess.textContent = 'Reintentar acceso pendiente'; retryPendingAccess.hidden = true;
recoverPreviousAccess.after(retryPendingAccess);
function connectionLock(value: boolean) {
  connectionBusy = value;
  element<HTMLButtonElement>('disconnect').disabled = value;
  element<HTMLFormElement>('connection').querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = value;
  pairingUI.setSubmitting(value);
}
function saveSelectedURL(url: string) {
  settings.url = url;
  if (!saveSettings(settings)) notice('Conectado, pero no pude recordar la dirección para el próximo inicio.');
}
let laptop: ReturnType<typeof import('./laptop-view.tsx')['mountLaptopView']> | undefined;
let laptopLoading = false;
function contentMoved() { manuallyPlaced = false; measuredAt = -Infinity; if (['agents', 'chat', 'inbox', 'settings'].includes(panel)) redraw(); }
const contentObserver = new MutationObserver(contentMoved);
for (const id of ['laptop-root', 'cards', 'requests', 'panel-inbox', 'panel-settings']) contentObserver.observe(element(id), { childList: true, subtree: true });
for (const id of ['panel-agents', 'laptop-root', 'conversation-scroll', 'panel-inbox', 'panel-settings']) element(id).addEventListener('scroll', contentMoved, { passive: true, capture: true });
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
const completionNotifications = mountCompletionNotifications(element('completion-notifications'));
const continuedInference = mountContinuedInferenceSettings(element('continued-inference-settings'));
let lockScreenSettings: ReturnType<typeof mountLiveActivitySettings> | undefined;
const lockScreenActivity = createLiveActivityCoordinator({ onChange: state => lockScreenSettings?.render(state) });
lockScreenSettings = mountLiveActivitySettings(element('live-activity-settings'), lockScreenActivity);
function observeLocalActivity(turnId: string, phase: ActivityPhase) {
  void lockScreenActivity.observe({ turnId, origin: 'iphone', phase }).catch(() => { /* The state is visible in Settings; never retry a mutation. */ });
}
function endLocalActivity(turnId: string, phase: ActivityEnd) {
  void lockScreenActivity.finish({ turnId, origin: 'iphone', phase }).catch(() => { /* Keep uncertain state for explicit inspection. */ });
}
let availability: Availability = { available: false, status: 'checking', supportsSpanish: false };
let linkedStatus: LinkedStatus = 'offline';
let linkedBusy = false;
let hostAgentState = 'idle';
let healthAction: HealthAction | undefined;
let localBusy = false;
let localTurnId: string | undefined;
let localRecoveryReady = false;
let recoveringLocal = false;
let recoveringNativeId: string | undefined;
let localRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
let localRecoveryWarning = '';
let localGeneration = 0;
let conversationReady = false;
let draftEdited = false;
let host = settings.url;
let remoteConversation = 'default';
let pendingRemote: { id: string; text: string; displayText: string } | undefined;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const rescueHistory = document.createElement('button');
rescueHistory.type = 'button'; rescueHistory.id = 'rescue-history'; rescueHistory.textContent = 'Rescatar datos guardados'; rescueHistory.hidden = true;
element('chat-notice').after(rescueHistory);
let recoveredHistoryAvailable = false;
let conversationRestoreFailed = false;
rescueHistory.addEventListener('click', () => {
  recoveredHistoryAvailable = false;
  rescueHistory.hidden = !persistence.status().blocked && !conversationRestoreFailed;
  showPanel('inbox'); void inbox.openAll();
});
let voiceSession: string | undefined;
let voiceOwner: string | undefined;
// If the native bridge cannot confirm cancellation, keep the original owner
// and offer an owner-scoped retry before starting any other recording.
let uncertainVoiceOwner: string | undefined;
let voiceCancelPending = false;
let voiceRetry = false;
let voiceStopping = false;
let foreignVoiceOwner: string | undefined;
let voiceStarting = false;
let voiceController: AbortController | undefined;
let voiceGeneration = 0;
let voiceTimer: ReturnType<typeof setTimeout> | undefined;
let voicePreviewTimer: ReturnType<typeof setInterval> | undefined;
let voiceRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
let persistenceWarning = '';
const persistence = createConversationPersistence({ onStatus(status) {
  rescueHistory.hidden = !status.blocked && !recoveredHistoryAvailable && !conversationRestoreFailed;
  if (status.blocked) {
    persistenceWarning = `No se confirmó el guardado local. ${status.archiveError ?? status.conversationError} ${status.pending} mensajes siguen en memoria. Los envíos están detenidos: usa Rescatar datos guardados para reintentar o exportar antes de cerrar Capri.`;
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
async function recoverLocalInference() {
  if (!conversationReady || localBusy || recoveringLocal || document.hidden) return;
  recoveringLocal = true; localRecoveryReady = false; clearTimeout(localRecoveryTimer); updateControls();
  try {
    const hadActive = recoveringNativeId;
    let recoveredFromArchive = false;
    const result = await recoverInferenceResults({ list: listInferenceResults,
      find: async id => entries.find(entry => entry.id === id && entry.engine === 'iphone')
        ?? await conversationArchive.load(JSON.stringify(['iphone', 'iphone:main', id])),
      apply(entry) {
        const current = entries.find(item => item.id === entry.id && item.engine === 'iphone');
        if (current?.localCancelled) return;
        if (current) add(entry);
        else { persistence.enqueue([entry]); recoveredFromArchive = true; }
      },
      commit: async () => { await persist(); return !persistence.status().blocked && persistence.status().pending === 0; },
      acknowledge: acknowledgeInference,
      onSettled: (record, cancelled) => endLocalActivity(record.id, !cancelled && record.status === 'answer' ? 'finished' : 'interrupted'),
    });
    recoveringNativeId = result.activeId;
    if (recoveredFromArchive) {
      recoveredHistoryAvailable = true; rescueHistory.hidden = false;
      notice('Recuperé una respuesta anterior. Puedes consultarla en tus datos guardados.', 'iphone');
    }
    localRecoveryReady = !result.activeId;
    element('retry-conversation').hidden = true;
    if (element('chat-notice').textContent === localRecoveryWarning) element('chat-notice').textContent = '';
    if (result.activeId) {
      element('scene-status').textContent = 'Terminando la respuesta en este iPhone…'; setIntent({ working: true, thinking: true });
      localRecoveryTimer = setTimeout(() => void recoverLocalInference(), 2000);
    } else if (hadActive) { element('scene-status').textContent = 'Aquí contigo.'; setIntent({ working: linkedBusy }); }
  } catch (error) {
    localRecoveryWarning = `${errorText(error)} Reintenta la recuperación antes de iniciar otra respuesta local.`;
    element('chat-notice').textContent = localRecoveryWarning;
    element('retry-conversation').hidden = false;
  } finally { recoveringLocal = false; updateControls(); }
}
function renderChat() {
  element('panel-chat').dataset.empty = String(entries.length === 0);
  conversationView.render(entries);
  element('empty-conversation').hidden = entries.length > 0 || !conversationReady;
  element('history-loading').hidden = conversationReady || entries.length > 0;
  measuredAt = -Infinity; redraw();
}

function add(entry: ChatEntry) {
  entries = applyConversationEntry(persistence, entries, entry); renderChat(); scheduleSave();
}
function notice(text: string, target: Engine = selected, id: string = localIdentifier()) { add({ id, role: 'notice', text, engine: target, state: 'complete', at: Date.now() }); }
function remoteId(id: string) { return `host:${host}|${remoteConversation}|${id}`; }
function interruptRemoteEntries() {
  // Only one host socket can be active. When it goes away, no pending remote
  // stream can still progress, including one from the host just replaced.
  entries = entries.map(entry => entry.engine === 'gentle' && entry.state === 'pending'
    ? { ...entry, state: 'interrupted', ...(entry.activities ? { activities: entry.activities.map(activity => activity.status === 'running' ? { ...activity, status: 'failed' as const } : activity) } : {}) }
    : entry);
}
function updateControls() {
  const health = connectionHealth({ local: availability, linkedStatus, agentState: hostAgentState, hostConfigured: Boolean(settings.url), preference, capabilities: { workSync: linked.supportsWorkSync(), meetingDrafts: linked.supportsMeetingDrafts() } });
  if (!localBusy && !recoveringNativeId && !pendingRemote) selected = preference === 'auto' && !localRecoveryReady && health.host.state === 'ready' ? 'gentle' : health.selectedEngine;
  const ready = selected === 'iphone' ? health.local.state === 'ready' && localRecoveryReady : health.host.state === 'ready';
  const busy = localBusy || !!recoveringNativeId || !!pendingRemote;
  element('settings-connection-state').textContent = linkedStatus === 'ready' ? 'Conectada' : linkedStatus === 'connecting' ? 'Conectando' : linkedStatus === 'rejected' ? 'Revisar acceso' : 'Sin conexión';
  element('settings-connection-state').dataset.state = health.host.state;
  element('settings-connection-detail').textContent = health.host.detail;
  element('engine-status').dataset.ready = String(ready);
  element('engine-summary').textContent = preference === 'auto' ? `Auto · ${selected === 'iphone' ? 'iPhone' : 'laptop'}` : selected === 'iphone' ? 'Este iPhone' : 'Laptop';
  element('engine-explanation').textContent = preference === 'auto'
    ? `Automático usa primero la IA del iPhone y, si no está disponible, la laptop conectada. Ahora: ${selected === 'iphone' ? 'iPhone' : 'laptop'}.`
    : selected === 'iphone' ? 'La conversación usa la IA local del iPhone.' : 'La conversación usa Gentle Dot en tu laptop conectada.';
  element<HTMLButtonElement>('send').disabled = !conversationReady || persistence.status().blocked || !ready || busy || voiceInProgress();
  element<HTMLSelectElement>('engine').disabled = localBusy || !!recoveringNativeId || !!pendingRemote;
  element('stop').hidden = !(localBusy || recoveringNativeId || (selected === 'gentle' && linkedBusy));
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
    interruptRemoteEntries();
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
async function commitManualSelection(attempt: ManualAttempt) {
  connectionLock(true); retryManualSave.hidden = true;
  try {
    await connectionSelection.commit(attempt.ticket, attempt.connection);
    if (attempt.epoch !== connectionEpoch || runtimeConnection !== attempt.connection) return;
    manualSavePending = undefined; recoverPreviousAccess.hidden = true; retryPendingAccess.hidden = true; saveSelectedURL(attempt.connection.url);
    element('status').textContent = 'Vinculado a Gentle Dot. Acceso guardado en Keychain.';
  } catch {
    if (attempt.epoch === connectionEpoch && runtimeConnection === attempt.connection) {
      manualSavePending = attempt; retryManualSave.hidden = false;
      element('status').textContent = 'Conectado, pero no pude guardar el acceso. Puedes reintentarlo mientras Capri siga abierta.';
    }
  } finally { if (attempt.epoch === connectionEpoch) connectionLock(false); }
}
async function restorePreviousSelection(attempt: ManualAttempt) {
  let restored: SelectedConnection | null = null;
  try { restored = await connectionSelection.rollback(attempt.ticket); } catch { /* The pending marker prevents an unsafe automatic restore. */ }
  if (attempt.epoch !== connectionEpoch) return;
  const previous = restored ?? attempt.previous;
  runtimeConnection = previous;
  manualSavePending = undefined; retryManualSave.hidden = true; connectionLock(false);
  if (previous) {
    host = previous.url; element<HTMLInputElement>('url').value = previous.url;
    linked.connect(previous.url, previous.token);
    notice('No se confirmó el nuevo acceso. Recuperé la conexión anterior.');
  } else { linked.disconnect(); element('status').textContent = 'No se confirmó el acceso. Revisa la conexión y vuelve a intentarlo.'; }
}
retryManualSave.addEventListener('click', () => { if (manualSavePending && !connectionBusy) void commitManualSelection(manualSavePending); });
function startPairingHandshake(pending: PairingPending): Promise<void> {
  return new Promise((resolve, reject) => {
    if (pending.epoch !== connectionEpoch || pairingAttempt) { reject(new Error('La conexión cambió.')); return; }
    pairingAttempt = { ...pending, resolve, reject };
    runtimeConnection = pending.connection; host = pending.connection.url;
    try { linked.connect(host, pending.connection.token); }
    catch { const attempt = pairingAttempt; pairingAttempt = undefined; if (attempt) failPairingHandshake(attempt); }
  });
}
async function finishPairingHandshake(attempt: NonNullable<typeof pairingAttempt>) {
  try {
    await connectionSelection.commit(attempt.ticket, attempt.connection);
    if (attempt.epoch !== connectionEpoch || runtimeConnection !== attempt.connection) throw new Error('La conexión cambió.');
    saveSelectedURL(attempt.connection.url); pairingSavePending = undefined;
    recoverPreviousAccess.hidden = true; retryPendingAccess.hidden = true;
    element<HTMLInputElement>('url').value = attempt.connection.url;
    element('pairing-status').textContent = 'iPhone vinculado. Acceso guardado en Keychain.';
    attempt.resolve();
  } catch {
    pairingSavePending = attempt;
    attempt.reject(new Error('La laptop aceptó el acceso, pero no pude confirmar su guardado.'));
  }
}
function failPairingHandshake(attempt: NonNullable<typeof pairingAttempt>) {
  pairingSavePending = attempt;
  runtimeConnection = attempt.previous;
  if (attempt.previous) {
    host = attempt.previous.url;
    // retry() schedules its timer after notifying offline; wait until that
    // callback returns so reconnecting the previous host cancels the timer.
    queueMicrotask(() => { if (attempt.epoch === connectionEpoch && runtimeConnection === attempt.previous) linked.connect(attempt.previous!.url, attempt.previous!.token); });
  } else linked.disconnect();
  attempt.reject(new Error('No se confirmó el nuevo acceso. Puedes reintentarlo o recuperar el anterior.'));
}
const linked = createLinkedChat({
  onStatus(value) {
    let pairingFailed = false;
    if (value === 'ready' && pairingAttempt) {
      const attempt = pairingAttempt; pairingAttempt = undefined;
      void finishPairingHandshake(attempt);
    } else if ((value === 'rejected' || value === 'offline') && pairingAttempt) {
      const attempt = pairingAttempt; pairingAttempt = undefined;
      pairingFailed = true;
      failPairingHandshake(attempt);
    }
    if (value === 'ready' && manualAttempt) {
      const attempt = manualAttempt; manualAttempt = undefined;
      void commitManualSelection(attempt);
    }
    if ((value === 'rejected' || value === 'offline') && manualAttempt) {
      const attempt = manualAttempt; manualAttempt = undefined;
      void restorePreviousSelection(attempt);
    } else if (value === 'rejected' && !pairingFailed) { if (!connectionBusy) connectionEpoch++; runtimeConnection = undefined; }
    updateLaptopView();
    linkedStatus = value; reviews.connection(value === 'ready');
    element('status').textContent = { offline: 'Sin conexión', connecting: 'Conectando…', ready: 'Vinculado a Gentle Dot', rejected: 'Acceso rechazado. Revisa token y versión.' }[value];
    element('connection-badge').textContent = value === 'ready' ? 'VINCULADO' : 'LOCAL';
    if (value !== 'ready') {
      linkedBusy = false; if (!localBusy) element('active-tool').textContent = '';
      interruptRemoteEntries();
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
  // Submission may be triggered by keyboard, accessibility or code without a
  // pointer event. It always ends startup theater and fences a delayed import.
  noteCompanionInteraction(); introReplayPending = false; theater?.stop();
  const text = prompt.value.trim();
  const promptText = text;
  if (!text || localBusy || recoveringNativeId || pendingRemote || !conversationReady || persistence.status().blocked || voiceInProgress()) return;
  element('chat-notice').textContent = '';
  if (selected === 'iphone') {
    if (!localRecoveryReady) return;
    if (!availability.available || !availability.supportsSpanish) { updateControls(); return; }
    if (Array.from(text).length > 2400) { element('chat-notice').textContent = 'Usa hasta 2400 caracteres con el motor local; puedes guardar un trabajo más largo.'; return; }
    const request = localPrompt(entries, text);
    if (Array.from(request).length > 4000) { element('chat-notice').textContent = 'Reduce el mensaje para dejar espacio al contexto local.'; return; }
    const generation = ++localGeneration;
    const allowBackground = continuedInference.enabled();
    const id = localIdentifier(); localBusy = true; localTurnId = id; localRecoveryReady = false;
    const controller = new AbortController(); localController = controller;
    const context = createAgentContext(entries, { ...(attachedWork ? { attachedWork } : {}) });
    const userId = localIdentifier();
    add({ id: userId, role: 'user', text, engine: 'iphone', state: 'complete', at: Date.now() });
    let turnEntry: ChatEntry = { id, replyTo: userId, role: 'assistant', text: '', engine: 'iphone', state: 'pending', at: Date.now() };
    add(turnEntry);
    prompt.value = ''; sizeDraft(); persist(); updateControls(); setIntent({ working: true, thinking: true }); element('scene-status').textContent = 'Pensando contigo…';
    try {
      // The native journal must always have a durable original turn to attach to.
      await persist();
      if (generation !== localGeneration) return;
      if (persistence.status().blocked || persistence.status().pending) throw new Error('No pude conservar la solicitud; no inicié el modelo local.');
      // Rebuild a bounded context from the visible timeline, also after app restarts.
      const reset = await resetLocal();
      if (!reset.ok) throw new Error('No pude confirmar que el motor local esté listo. La solicitud se conserva sin ejecutar.');
      if (generation !== localGeneration) return;
      observeLocalActivity(id, 'thinking');
      const runner = createAgentRunner({ waitUntilActive: waitForForeground, tools: [...createLocalTools(), ...createMemoryTools(), ...createConnectionTools(), ...createDesktopTools({ getConnection: () => runtimeConnection }), ...createWorkTools({ getHost: () => linked.ready() ? host : undefined, getDispatcher: operation => {
        if (!linked.ready()) return undefined;
        if (!linked.supportsWorkSync()) throw new Error('Actualiza Gentle Dot en la laptop para transferir trabajos. La conversación sigue disponible y el trabajo local se conserva.');
        if (operation === 'process' && !linked.supportsMeetingDrafts()) throw new Error('Este Gentle Dot no tiene disponible el procesamiento de reuniones. El material confirmado se conserva.');
        return createWorkDispatcher(linked.exchange, host);
      } }).filter(tool => ['work_sync', 'work_recover', 'work_process', 'work_result', 'work_correct'].includes(tool.definition.name))], step: prompt => agentStep(prompt, id, allowBackground), onTrace(trace) {
        const entry = entries.find(item => item.id === id) ?? turnEntry;
        const activities = [...entry.activities ?? []]; const at = activities.findIndex(item => item.id === trace.id);
        const activity = { id: trace.id, kind: 'other' as const, title: trace.label, status: trace.status, detail: trace.detail };
        if (at < 0) activities.push(activity); else activities[at] = activity;
        turnEntry = { ...entry, activities, state: generation !== localGeneration && entry.state === 'pending' ? 'interrupted' : entry.state };
        add(turnEntry);
        if (generation === localGeneration) { element('active-tool').textContent = trace.status === 'running' ? trace.label : ''; setIntent({ working: trace.status === 'running', thinking: trace.status !== 'running' }); observeLocalActivity(id, trace.status === 'running' ? 'working' : 'thinking'); }
      } });
      const text = await runner.run({ instruction: promptText, context, signal: controller.signal, askApproval: async request => {
        if (generation === localGeneration) { setIntent({ alert: true }); observeLocalActivity(id, 'attention'); }
        try { return await reviews.approve(request, controller.signal); }
        finally { if (generation === localGeneration) { setIntent({ thinking: true }); observeLocalActivity(id, 'thinking'); } }
      } });
      if (generation !== localGeneration) return;
      add({ ...turnEntry, text, state: 'complete' });
      endLocalActivity(id, 'finished');
      setIntent({ outcome: { kind: 'done', at: performance.now() } });
    } catch (error) {
      if (generation === localGeneration) { add({ ...turnEntry, text: errorText(error), state: 'interrupted' }); endLocalActivity(id, 'interrupted'); }
    } finally { if (generation === localGeneration) { localBusy = false; localTurnId = undefined; element('active-tool').textContent = ''; element('scene-status').textContent = 'Aquí contigo.'; updateControls(); await persist(); await recoverLocalInference(); updateControls(); } }
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
  const turnId = localTurnId ?? recoveringNativeId;
  const generation = ++localGeneration; localController?.abort();
  entries = entries.map(entry => entry.engine === 'iphone' && (entry.id === turnId || (!turnId && entry.state === 'pending'))
    ? { ...entry, state: 'interrupted', localCancelled: true, text: 'Respuesta interrumpida.' } : entry);
  renderChat();
  stoppingLocal = (async () => {
    let hasMarker = entries.some(entry => entry.id === turnId && entry.engine === 'iphone' && entry.localCancelled);
    if (turnId && !entries.some(entry => entry.id === turnId && entry.engine === 'iphone')) {
      try {
        const archived = await conversationArchive.load(JSON.stringify(['iphone', 'iphone:main', turnId]));
        if (archived && archived.role !== 'user') { persistence.enqueue([{ ...archived, state: 'interrupted', localCancelled: true, text: 'Respuesta interrumpida.' }]); hasMarker = true; }
      } catch { /* Native cancellation below still runs; failure remains visible. */ }
    }
    await persist();
    const markerConfirmed = hasMarker && !persistence.status().blocked && persistence.status().pending === 0;
    try {
      const cancelled = await withInferenceDeadline(cancelLocal(turnId));
      if (!cancelled.ok) throw new Error('La cancelación nativa no se confirmó.');
      if (turnId) endLocalActivity(turnId, 'interrupted');
    } catch { element('chat-notice').textContent = markerConfirmed
      ? 'No se confirmó la detención nativa. La solicitud quedó marcada como interrumpida; revisa su estado al volver.'
      : 'No pude confirmar la detención ni guardar su marca. Revisa el resultado antes de continuar.'; }
    if (generation !== localGeneration) return;
    localBusy = false; localTurnId = undefined;
    element('active-tool').textContent = ''; element('scene-status').textContent = 'Aquí contigo.';
    renderChat(); await persist(); setIntent({}); await recoverLocalInference(); updateControls();
  })().finally(() => { stoppingLocal = undefined; });
  return stoppingLocal;
}
element('stop').addEventListener('click', () => {
  if (localBusy || recoveringNativeId) void stopLocal();
  else if (selected === 'gentle' && linkedBusy && linked.abort()) element('chat-notice').textContent = 'Se pidió detener la respuesta de Gentle Dot; esperando al host.';
});
element<HTMLFormElement>('connection').addEventListener('submit', async event => {
  event.preventDefault();
  if (connectionBusy) return;
  if (restorationUncertain) { element('status').textContent = 'No pude verificar el acceso guardado. Desconecta antes de conectar otro.'; return; }
  let ticket: number | undefined;
  const previous = runtimeConnection;
  try {
    const nextHost = validDaemonUrl(element<HTMLInputElement>('url').value);
    const token = element<HTMLInputElement>('token').value.trim();
    if (!token || token.length > 4096) throw new Error('Introduce un token válido para conectar.');
    const epoch = ++connectionEpoch;
    if (isTauri()) {
      connectionLock(true);
      element('status').textContent = 'Preparando el acceso seguro…';
      ticket = await connectionSelection.begin(nextHost, previous);
      if (epoch !== connectionEpoch) return;
    }
    pairingSaveRecovery.clear(); pairingSavePending = undefined;
    const connection: SelectedConnection & { source: 'manual' } = { source: 'manual', url: nextHost, token };
    if (ticket !== undefined) {
      await connectionSelection.stage(ticket, connection);
      if (epoch !== connectionEpoch) throw new Error('La conexión cambió antes de guardar el acceso.');
    }
    runtimeConnection = connection;
    manualSavePending = undefined; retryManualSave.hidden = true;
    manualAttempt = ticket === undefined ? undefined : { connection, ticket, epoch, previous };
    host = nextHost;
    element<HTMLInputElement>('token').value = '';
    linked.connect(nextHost, token);
    if (!isTauri()) saveSelectedURL(host);
  } catch (error) {
    if (ticket !== undefined) try { await connectionSelection.rollback(ticket); } catch { /* The pending marker remains fail-closed. */ }
    runtimeConnection = previous; connectionLock(false); element('status').textContent = errorText(error);
  }
});
element('disconnect').addEventListener('click', () => void (async () => {
  if (connectionBusy) return;
  connectionLock(true);
  try {
    if (isTauri()) await connectionSelection.disconnect();
    connectionEpoch++; restorationUncertain = false; manualAttempt = undefined; manualSavePending = undefined; pairingSavePending = undefined;
    pairingSaveRecovery.clear(); retryManualSave.hidden = true; recoverPreviousAccess.hidden = true; retryPendingAccess.hidden = true; runtimeConnection = undefined;
    linked.disconnect(); element<HTMLInputElement>('token').value = '';
  } catch { element('status').textContent = 'No pude confirmar la desconexión. La conexión anterior se conserva.'; }
  finally { connectionLock(false); }
})());
element('check-local').addEventListener('click', () => void checkModel());
element<HTMLInputElement>('url').value = settings.url;
const connectionSettings = mountConnectionSettings();
const inbox = mountInbox(text => { draftEdited = true; prompt.value = text; scheduleSave(); showPanel('chat'); prompt.focus(); });
const memoryView = mountMemoryView({ status: persistence.status, pending: persistence.pending, visible: () => structuredClone(entries), draft: () => prompt.value, retry: persist });
element('view-material').addEventListener('click', () => {
  if (!attachedWork) return;
  const id = attachedWork;
  showPanel('inbox');
  void inbox.openWork(id);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { release(); settlePresence(); pauseRigPreparation(); }
  cancelAnimationFrame(frame); fx?.clear(); persist();
  if (document.hidden) {
    // The native permission sheet can temporarily hide WKWebView while the
    // microphone request is still pending. Native iOS lifecycle handling
    // cancels an actual background transition; do not invalidate that prompt.
    // Also avoid cancelling a capture owned by the laptop-session composer.
    if (voiceSession && !voiceRetry) void cancelDictation();
    director.update(intent, performance.now(), true); linked.suspend();
  }
  else { if (rigNeedsPreparation && image && !preparingRig) void startRig(); lastFrame = -1; redraw(); linked.resume(); void checkModel(); void importSharedFiles(); void recoverLocalInference(); void recoverPendingVoice(); void completionNotifications.refresh(); void lockScreenSettings?.refresh(); }
});
window.addEventListener('pagehide', () => { settlePresence(); pauseRigPreparation(); connectionSettings.cancel(); cancelAnimationFrame(frame); linked.suspend(); persist(); });
window.addEventListener('pageshow', event => { if (event.persisted) { if (!document.hidden && rigNeedsPreparation && image && !preparingRig) void startRig(); redraw(); linked.resume(); void recoverLocalInference(); } });
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
    if (!draftEdited) { prompt.value = saved.draft; if (!attachedWork) showAttachedWork(saved.attachedWork); }
    if (attachedWork) showAttachedWork(attachedWork, 'Material guardado en este iPhone');
    conversationReady = true;
    conversationRestoreFailed = false;
    retry.hidden = true;
    rescueHistory.hidden = !persistence.status().blocked && !recoveredHistoryAvailable;
    if (element('chat-notice').textContent === recoveryMessage) element('chat-notice').textContent = '';
    renderChat(); sizeDraft(); await persist(); releaseAttachedWork(attachedWork); await recoverLocalInference();
  } catch {
    element('history-loading').hidden = true;
    conversationRestoreFailed = true;
    // Never overwrite an unread stored timeline with the partial in-memory state.
    element('chat-notice').textContent = recoveryMessage;
    retry.hidden = false;
    rescueHistory.hidden = false;
  } finally {
    conversationLoading = false; retry.disabled = false; updateControls();
    conversationRestored = true; redraw(); maybeStartCompanionIntro();
  }
}
element('retry-conversation').addEventListener('click', () => void restoreConversation());
async function initialize() {
  updateControls();
  void completionNotifications.refresh();
  void lockScreenSettings?.initialize();
  void recoverPendingVoice();
  // Independent stores must not delay the character or the native availability
  // check. A late startup read must also never replace newly selected artwork.
  let initialArtworkRevision = assetRevision;
  const artworkReady = (async () => {
    // A selection may already be in progress when initialization starts. Its
    // revision owns the image and status, even before its IndexedDB save ends.
    if (initialArtworkRevision !== 0) return;
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

// A recoverable failure does not block sending independently typed text. While
// audio is active or finalizing, prevent a partial instruction from being sent.
function voiceInProgress() { return voiceStarting || voiceCancelPending || Boolean(voiceSession && !voiceRetry); }
function stopVoicePreview() { clearInterval(voicePreviewTimer); voicePreviewTimer = undefined; element('dictate').style.removeProperty('--voice-level'); }
async function recoverPendingVoice() {
  if (!isTauri() || document.hidden || panel !== 'chat' || voiceStarting || uncertainVoiceOwner || voiceCancelPending || (voiceSession && !voiceRetry)) return;
  const cancellation = pendingVoiceCancellation();
  if (cancellation) {
    uncertainVoiceOwner = cancellation;
    element('dictate').setAttribute('aria-label', 'Reintentar detener micrófono');
    element('voice-status').textContent = 'No pude confirmar que el micrófono se detuvo. Toca el micrófono para reintentar.';
    return;
  }
  const generation = voiceGeneration;
  try {
    const state = await checkVoice();
    if (generation !== voiceGeneration || document.hidden || panel !== 'chat' || voiceStarting) return;
    if (pendingVoiceCancellation()) { void recoverPendingVoice(); return; }
    if (state.recoveryPending && state.busy) {
      element('voice-status').textContent = 'Terminando el audio guardado…';
      clearTimeout(voiceRecoveryTimer);
      voiceRecoveryTimer = setTimeout(() => void recoverPendingVoice(), 500);
      return;
    }
    if (!state.recoveryPending || !state.sessionId || !state.ownerId) {
      if (voiceRetry) { voiceSession = undefined; voiceOwner = undefined; voiceRetry = false; element('discard-voice').hidden = true; element('dictate').setAttribute('aria-label', 'Dictar'); }
      return;
    }
    if (voiceOrigin(state.ownerId) !== 'chat') {
      element('voice-status').textContent = 'Hay un audio pendiente en otra sesión. Vuelve a esa conversación para reintentar su transcripción.';
      foreignVoiceOwner = state.ownerId;
      element('discard-voice').hidden = false;
      return;
    }
    foreignVoiceOwner = undefined;
    voiceSession = state.sessionId; voiceOwner = state.ownerId; voiceRetry = true;
    element('voice-status').textContent = state.recoveryIssue ?? 'Toca el micrófono para reintentar. El audio puede perderse si iOS cierra Capri.';
    element('dictate').setAttribute('aria-pressed', 'false'); element('dictate').setAttribute('aria-label', 'Reintentar transcripción');
    element('discard-voice').hidden = false;
  } catch { /* A failed status check cannot prove the recording was removed. */ }
}
function showVoicePreview(id: string, generation: number) {
  stopVoicePreview();
  let polling = false;
  const refresh = async () => {
    if (polling || generation !== voiceGeneration || voiceSession !== id || document.hidden) return;
    polling = true;
    try {
      const state = await checkVoice();
      if (generation !== voiceGeneration || voiceSession !== id || state.sessionId?.toLowerCase() !== id.toLowerCase()) return;
      element('dictate').style.setProperty('--voice-level', String(state.microphoneLevel ?? 0));
      if (!state.recording && state.readyToTranscribe) {
        // Finish the same native session once; stopVoice either yields a full
        // transcript or reports the capture failure without using the preview.
        stopVoicePreview();
        element<HTMLButtonElement>('dictate').click();
        return;
      }
      element('voice-status').textContent = state.previewIssue
        ? state.previewIssue
        : state.partial ? state.partial
        : 'Escuchando…';
    } catch { /* The final transcript does not depend on preview polling. */ }
    finally { polling = false; }
  };
  voicePreviewTimer = setInterval(() => void refresh(), 500);
  void refresh();
}
async function cancelDictation(reason: 'navigation' | 'manual' = 'navigation') {
  if (voiceCancelPending) return;
  const wasActive = voiceStarting || Boolean(voiceSession);
  const owner = voiceOwner; voiceOwner = undefined;
  voiceGeneration++; voiceController?.abort(); voiceSession = undefined; voiceRetry = false; voiceStopping = false; clearTimeout(voiceTimer); stopVoicePreview();
  element('discard-voice').hidden = true;
  voiceStarting = false;
  const control = element<HTMLButtonElement>('dictate');
  control.disabled = false; control.setAttribute('aria-pressed', 'false'); control.setAttribute('aria-label', 'Dictar');
  if (owner && isTauri()) {
    uncertainVoiceOwner = owner;
    markVoiceCancellation(owner);
    await retryVoiceCancellation(reason);
  } else {
    if (wasActive) element('voice-status').textContent = reason === 'manual'
      ? 'Dictado cancelado. Toca el micrófono para volver a intentarlo.'
      : 'El dictado se interrumpió al salir de Capri. Toca el micrófono para intentarlo de nuevo.';
    updateControls();
  }
}
async function retryVoiceCancellation(reason: 'navigation' | 'manual' = 'manual') {
  const owner = uncertainVoiceOwner;
  if (!owner || voiceCancelPending) return;
  voiceCancelPending = true;
  updateControls();
  const control = element<HTMLButtonElement>('dictate');
  control.disabled = true;
  element('voice-status').textContent = 'Deteniendo el micrófono…';
  try {
    await voiceCancelWithDeadline(() => cancelVoice(owner));
    if (uncertainVoiceOwner !== owner) return;
    uncertainVoiceOwner = undefined;
    clearVoiceCancellation(owner);
    forgetVoiceOrigin(owner);
    control.setAttribute('aria-label', 'Dictar');
    element('voice-status').textContent = reason === 'manual'
      ? 'Dictado cancelado. Toca el micrófono para volver a intentarlo.'
      : 'El dictado se interrumpió al salir de Capri. Toca el micrófono para intentarlo de nuevo.';
  } catch (error) {
    if (uncertainVoiceOwner !== owner) return;
    control.setAttribute('aria-label', 'Reintentar detener micrófono');
    element('voice-status').textContent = error instanceof VoiceCancelUnconfirmed ? error.message : 'No pude confirmar que el micrófono se detuvo. Toca el micrófono para reintentar.';
  } finally {
    voiceCancelPending = false;
    control.disabled = false;
    updateControls();
  }
}
element('dictate').addEventListener('click', async () => {
  uncertainVoiceOwner ??= pendingVoiceCancellation();
  if (uncertainVoiceOwner) { void retryVoiceCancellation(); return; }
  if (voiceStarting) { void cancelDictation('manual'); return; }
  const current = ++voiceGeneration;
  const owner = voiceSession ? voiceOwner : localIdentifier();
  voiceOwner = owner;
  if (owner && !voiceSession) rememberVoiceOrigin(owner, 'chat');
  voiceStarting = true;
  updateControls();
  const control = element<HTMLButtonElement>('dictate'); control.setAttribute('aria-label', 'Cancelar dictado');
  let stopping: string | undefined;
  try {
    if (voiceSession) {
      const id = voiceSession; stopping = id; voiceStopping = true; voiceSession = undefined; voiceRetry = false; element('discard-voice').hidden = true; clearTimeout(voiceTimer); stopVoicePreview();
      element('voice-status').textContent = 'Transcribiendo en este iPhone…';
      const transcript = await stopVoice(id);
      if (current !== voiceGeneration) return;
      // Voice edits the same draft; nothing is sent without the person's submit.
      prompt.value = `${prompt.value}${prompt.value.trim() ? '\n' : ''}${transcript.text}`;
      draftEdited = true; scheduleSave(); prompt.focus();
      element('voice-status').textContent = '';
      if (owner) forgetVoiceOrigin(owner);
      setIntent({});
    } else {
      voiceController = new AbortController();
      element('voice-status').textContent = 'Preparando el micrófono…';
      const availability = await checkVoice();
      if (availability.recoveryPending && availability.ownerId && voiceOrigin(availability.ownerId) !== 'chat') {
        throw new Error('Hay un audio pendiente en otra sesión. Vuelve a esa conversación para reintentar su transcripción.');
      }
      if (availability.status === 'assets_required') {
        element('voice-status').textContent = 'Descargando la voz en español de Apple. Necesitas internet para esta primera preparación…';
        const prepared = await prepareVoice(owner);
        if (!prepared.available) throw new Error(voiceAvailabilityNote(prepared) ?? 'Apple aún no terminó de preparar la voz en español. Comprueba la conexión y vuelve a intentarlo.');
      }
      if (current !== voiceGeneration) return;
      element('voice-status').textContent = 'Iniciando micrófono…';
      const session = await startVoice(owner);
      // Explicit cancellation already reached the native controller. A second
      // global cancel here could stop a newer capture owned by another panel.
      if (current !== voiceGeneration) return;
      voiceSession = session.sessionId;
      element('voice-status').textContent = 'Escuchando…';
      showVoicePreview(session.sessionId, current);
      setIntent({ alert: true });
      voiceTimer = setTimeout(() => control.click(), session.maxDurationSeconds * 1000 - 500);
    }
  } catch (error) {
    if (current === voiceGeneration) {
      if (error instanceof VoiceRetryPending && stopping && error.sessionId.toLowerCase() === stopping.toLowerCase()) {
        voiceSession = error.sessionId; voiceRetry = true; element('discard-voice').hidden = false;
      }
      if (error instanceof VoiceCancelUnconfirmed && owner) {
        uncertainVoiceOwner = owner;
        markVoiceCancellation(owner);
        voiceOwner = undefined;
      }
      element('voice-status').textContent = errorText(error);
    }
  }
  finally {
    if (current === voiceGeneration) {
      voiceStarting = false; control.disabled = false;
      voiceStopping = false;
      if (!voiceSession) { if (owner && !uncertainVoiceOwner) forgetVoiceOrigin(owner); voiceOwner = undefined; }
      control.setAttribute('aria-pressed', String(!!voiceSession && !voiceRetry)); control.setAttribute('aria-label', uncertainVoiceOwner ? 'Reintentar detener micrófono' : voiceRetry ? 'Reintentar transcripción' : voiceSession ? 'Terminar dictado' : 'Dictar');
      updateControls();
    }
  }
});
element('discard-voice').addEventListener('click', () => {
  if ((voiceRetry || foreignVoiceOwner) && window.confirm('¿Descartar el audio pendiente de transcripción?')) {
    if (voiceRetry) void cancelDictation('manual');
    else if (foreignVoiceOwner) {
      const owner = foreignVoiceOwner; foreignVoiceOwner = undefined;
      void cancelVoice(owner).then(() => { forgetVoiceOrigin(owner); element('discard-voice').hidden = true; element('voice-status').textContent = 'Audio pendiente descartado.'; }).catch(error => { foreignVoiceOwner = owner; element('voice-status').textContent = errorText(error); });
    }
  }
});
element('attach').addEventListener('click', async () => {
  if (!isTauri()) { element<HTMLInputElement>('chat-files').click(); return; }
  const button = element<HTMLButtonElement>('attach'); button.disabled = true;
  try { if (await pickDocuments()) await importDocumentFiles(true); }
  catch (error) { element('chat-notice').textContent = errorText(error); }
  finally { button.disabled = false; }
});
element('camera').addEventListener('click', () => element<HTMLInputElement>('chat-camera').click());
async function importComposerSelection(event: Event) {
  const control = event.target as HTMLInputElement;
  const files = Array.from(control.files ?? []); if (!files.length) return;
  try {
    const item = await createWork({ title: files[0]!.name.slice(0, 120), kind: files.some(file => file.type.startsWith('audio/')) ? 'meeting' : 'task', instruction: prompt.value.trim() || 'Material adjunto a la conversación de Capri.', files });
    showAttachedWork(item.id, item.title);
    element('attachment-context').title = 'Guardado en este iPhone';
    await persist(); releaseAttachedWork(item.id);
    control.value = ''; await inbox.refresh();
  } catch (error) { element('chat-notice').textContent = errorText(error); }
}
element<HTMLInputElement>('chat-files').addEventListener('change', importComposerSelection);
element<HTMLInputElement>('chat-camera').addEventListener('change', importComposerSelection);
const pairingUI = mountPairingInput(element<HTMLFormElement>('pairing'), element<HTMLInputElement>('pairing-invitation'));
const pairingSaveRecovery = mountPairingSaveRecovery({
  status: element('pairing-status'), pairingBusy: pairingUI.setSubmitting,
  manualForm: element<HTMLFormElement>('connection'), disconnect: element('disconnect'),
  current: () => pairingSavePending?.connection ?? runtimeConnection, epoch: () => connectionEpoch,
  save: async (_origin, connection) => {
    const pending = pairingSavePending;
    if (!pending || pending.epoch !== connectionEpoch || pending.connection !== connection) throw new Error('La conexión cambió.');
    await connectionSelection.stage(pending.ticket, pending.connection);
    await startPairingHandshake(pending);
  },
});
element<HTMLFormElement>('pairing').addEventListener('submit', async event => {
  event.preventDefault();
  if (connectionBusy) return;
  if (restorationUncertain) { element('pairing-status').textContent = 'No pude verificar el acceso guardado. Desconecta antes de vincular otro.'; return; }
  connectionLock(true);
  let ticket: number | undefined;
  let accepted = false;
  const previous = runtimeConnection;
  try {
    const invitation = parseInvitation(element<HTMLInputElement>('pairing-invitation').value);
    const epoch = ++connectionEpoch;
    const target = `${invitation.origin.replace('https:', 'wss:')}/ws`;
    ticket = await connectionSelection.begin(target, previous);
    if (epoch !== connectionEpoch) throw new Error('La conexión cambió antes de vincular.');
    element('pairing-status').textContent = 'Esperando a Gentle Dot. Si aparece una solicitud en tu laptop, aprueba el acceso allí.';
    const result = await pairDevice(invitation);
    if (epoch !== connectionEpoch) throw new Error('La conexión cambió durante la vinculación.');
    accepted = true;
    pairingSaveRecovery.clear();
    const connection: SelectedConnection & { source: 'paired' } = { source: 'paired', ...result.connection };
    manualSavePending = undefined; retryManualSave.hidden = true;
    element<HTMLInputElement>('pairing-invitation').value = '';
    element('pairing-invitation').dispatchEvent(new Event('input', { bubbles: true }));
    const pending: PairingPending = { ticket, epoch, connection, previous };
    pairingSavePending = pending;
    await connectionSelection.stage(ticket, connection);
    element('pairing-status').textContent = 'La laptop aprobó el acceso. Comprobando la conexión…';
    await startPairingHandshake(pending);
  } catch (error) {
    if (ticket !== undefined && !accepted) try { await connectionSelection.rollback(ticket); } catch { /* Keep the pending marker rather than restoring another credential. */ }
    if (accepted && pairingSavePending) {
      const pending = pairingSavePending;
      pairingSaveRecovery.offer(new URL(pending.connection.url.replace(/^wss:/, 'https:')).origin, pending.connection, pending.epoch);
      recoverPreviousAccess.hidden = !pending.previous;
    }
    element('pairing-status').textContent = errorText(error);
  }
  finally { connectionLock(false); }
});
async function restoreDeviceConnection() {
  if (!isTauri() || connectionBusy) return;
  const restoredURL = settings.url;
  const epoch = connectionEpoch;
  let timer: ReturnType<typeof setTimeout> | undefined;
  connectionLock(true);
  element('status').textContent = 'Recuperando acceso guardado…';
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('El llavero no respondió.')), 8000); });
    const selected = await Promise.race([connectionSelection.restore(restoredURL || undefined), timeout]);
    if (epoch !== connectionEpoch) return;
    restorationUncertain = false;
    if (selected) {
      runtimeConnection = selected; host = selected.url; settings.url = selected.url;
      element<HTMLInputElement>('url').value = selected.url; saveSettings(settings);
      linked.connect(selected.url, selected.token);
    } else element('status').textContent = 'Sin conexión';
  } catch (error) {
    if (epoch !== connectionEpoch) return;
    if (error instanceof ConnectionSelectionPending) {
      restorationUncertain = false; recoverPreviousAccess.hidden = !error.hasPrevious; retryPendingAccess.hidden = !error.hasCandidate;
      element('status').textContent = error.message; element('pairing-status').textContent = error.message;
    } else if (error instanceof ConnectionSelectionAmbiguous) {
      restorationUncertain = false; element('status').textContent = error.message;
    } else {
      // A late read cannot install a connection after this timeout/failure.
      connectionEpoch++; restorationUncertain = true;
      element('status').textContent = 'No pude verificar el acceso guardado. Desconecta antes de conectar otro.';
    }
  } finally { clearTimeout(timer); connectionLock(false); }
}
recoverPreviousAccess.addEventListener('click', () => void (async () => {
  if (connectionBusy) return;
  connectionLock(true);
  try {
    const previous = await connectionSelection.recoverPrevious();
    if (!previous) throw new Error('Ya no hay un acceso anterior que recuperar.');
    connectionEpoch++; restorationUncertain = false; pairingSavePending = undefined; manualSavePending = undefined;
    pairingSaveRecovery.clear(); retryManualSave.hidden = true; recoverPreviousAccess.hidden = true; retryPendingAccess.hidden = true;
    runtimeConnection = previous; host = previous.url; element<HTMLInputElement>('url').value = previous.url;
    saveSelectedURL(previous.url); linked.connect(previous.url, previous.token);
    element('pairing-status').textContent = 'Acceso anterior recuperado. Comprobando la conexión…';
  } catch (error) { element('pairing-status').textContent = errorText(error); }
  finally { connectionLock(false); }
})());
retryPendingAccess.addEventListener('click', () => void (async () => {
  if (connectionBusy) return;
  connectionLock(true);
  let waitingForManual = false;
  try {
    const pending = await connectionSelection.recoverCandidate();
    if (!pending) throw new Error('Ya no hay un acceso pendiente que reintentar.');
    const epoch = ++connectionEpoch;
    if (pending.connection.source === 'paired') {
      const attempt: PairingPending = { ...pending, epoch, connection: pending.connection };
      pairingSavePending = attempt; await startPairingHandshake(attempt);
    } else {
      const attempt: ManualAttempt = { ...pending, epoch, connection: pending.connection };
      manualAttempt = attempt; runtimeConnection = attempt.connection; host = attempt.connection.url;
      waitingForManual = true; linked.connect(host, attempt.connection.token);
    }
  } catch (error) { element('pairing-status').textContent = errorText(error); }
  finally { if (!waitingForManual) connectionLock(false); }
})());
function importSharedFiles(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  if (sharedImports) return sharedImports.then(() => importSharedFiles());
  void importDocumentFiles();
  sharedImports = (async () => {
    try {
      const result = await recoverImportBatch(await listSharedImports(), async item => {
        await importSharedItem(item, async ({ sourceId, files }) => {
          const work = await createImportedWork(sourceId, { title: item.title, kind: files.some(file => file.type.startsWith('audio/')) ? 'meeting' : 'task', instruction: item.notes || 'Material compartido con Capri. Pendiente de instrucciones.', files });
          showAttachedWork(work.id, work.title);
          notice(`Recibí ${work.title}. Material guardado localmente como trabajo ${work.id}; dime qué hacemos con él.`, 'iphone', `shared:${item.id}`);
          await persist(); releaseAttachedWork(work.id);
        });
      });
      await inbox.refresh();
      if (result.failures.length) {
        const first = result.failures[0]!;
        element('chat-notice').textContent = `No se pudo recuperar ${first.title}${result.failures.length > 1 ? ` y ${result.failures.length - 1} material(es) más` : ''}; siguen pendientes. ${first.message}`;
      }
    } catch (error) { element('chat-notice').textContent = errorText(error); }
  })().finally(() => { sharedImports = undefined; });
  return sharedImports;
}
function importDocumentFiles(fresh = false): Promise<void> {
  // Returning from UIKit can also trigger foreground recovery. If that older
  // scan began before publication, the explicit pick needs a fresh scan after it.
  if (documentImports) return fresh ? documentImports.then(() => importDocumentFiles()) : documentImports;
  documentImports = (async () => {
    try {
      const result = await recoverImportBatch(await listDocumentImports(), async item => {
        await importDocumentItem(item, async ({ sourceId, files }) => {
          const work = await createImportedWork(sourceId, { title: item.title, kind: files.some(file => file.type.startsWith('audio/')) ? 'meeting' : 'task',
            // The source identity must remain stable if native acknowledgement fails
            // and the user edits their message before the next recovery attempt.
            instruction: 'Material adjunto a la conversación de Capri.', files });
          showAttachedWork(work.id, `${files.length} archivo${files.length === 1 ? '' : 's'} · ${work.title}`);
          notice(`Conservé ${work.title} en este iPhone. Dime qué hacemos con el material.`, 'iphone', `document:${item.id}`);
          await persist(); releaseAttachedWork(work.id);
        });
      });
      await inbox.refresh();
      if (result.failures.length) {
        const first = result.failures[0]!;
        element('chat-notice').textContent = `No se pudieron recuperar ${result.failures.length} documento(s); siguen pendientes. ${first.title}: ${first.message}`;
      }
    } catch (error) { element('chat-notice').textContent = errorText(error); }
  })().finally(() => { documentImports = undefined; });
  return documentImports;
}
