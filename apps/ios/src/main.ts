import { createEngine, frameAt } from '@gentle-dot/ui/src/capri2d/engine.ts';
import { RigDirector, type RigIntent } from '@gentle-dot/ui/src/capri2d/director.ts';
import { RigFx } from '@gentle-dot/ui/src/capri2d/fx.ts';
import { CloseCode, PROTOCOL_VERSION } from '@gentle-dot/protocol';
import './style.css';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element('status');
const artStatus = element('art-status');
const canvas = element<HTMLCanvasElement>('capri');
const cards = element('cards');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
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
try { fx = new RigFx(element<HTMLCanvasElement>('fx')); } catch { /* Optional FX. */ }

function animate(now: number) {
  if (!engine || document.hidden) return;
  director.update(intent, now);
  const next = reduced.matches ? 0 : frameAt(now, director.fps());
  if (next !== lastFrame || revision !== lastRevision) {
    const sample = director.sample(now, reduced.matches);
    engine.draw(sample.pose, next);
    if (!reduced.matches) for (const cue of sample.cues) fx?.cue(cue, now, intent.direction);
    lastFrame = next;
    lastRevision = revision;
  }
  if (!reduced.matches) fx?.draw(now);
  frame = requestAnimationFrame(animate);
}
function startRig() {
  cancelAnimationFrame(frame);
  engine?.dispose();
  engine = undefined;
  if (!image) return;
  try {
    engine = createEngine(canvas, image);
    lastFrame = -1;
    artStatus.textContent = 'Capri 2D · motor compartido de PC';
    animate(performance.now());
  } catch { artStatus.textContent = 'WebGL no disponible. Las viñetas siguen activas.'; }
}
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  cancelAnimationFrame(frame);
  engine?.dispose();
  engine = undefined;
  artStatus.textContent = 'Recuperando WebGL…';
});
canvas.addEventListener('webglcontextrestored', startRig);
reduced.addEventListener('change', () => {
  revision++;
  fx?.clear();
  cancelAnimationFrame(frame);
  animate(performance.now());
});
element<HTMLInputElement>('art').addEventListener('change', async event => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const current = ++assetRevision;
  const url = URL.createObjectURL(file);
  try {
    const next = new Image();
    next.src = url;
    await next.decode();
    if (current !== assetRevision) return;
    if (next.naturalWidth !== 240 || next.naturalHeight !== 420) throw new Error('dimensions');
    image = next;
    startRig();
  } catch { artStatus.textContent = 'Se necesita un PNG válido de 240 × 420.'; }
  finally { URL.revokeObjectURL(url); }
});

// Foreground-only, bounded cards; credentials stay in memory, never in a URL or storage.
let socket: WebSocket | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
let credentials: { url: string; token: string } | undefined;
let attempts = 0;
function card(id: string, text: string) {
  let item = Array.from(cards.children).find(child => (child as HTMLElement).dataset.id === id);
  if (!item) {
    item = document.createElement('article');
    (item as HTMLElement).dataset.id = id;
    cards.append(item);
  }
  item.textContent = text.slice(0, 2000);
  while (cards.children.length > 4) cards.firstElementChild?.remove();
}
function closeSocket() {
  clearTimeout(timer);
  clearTimeout(timeout);
  const old = socket;
  socket = undefined;
  old?.close();
}
function connect() {
  closeSocket();
  if (!credentials || document.hidden) return;
  status.textContent = 'Conectando…';
  const ws = new WebSocket(credentials.url);
  socket = ws;
  const current = () => ws === socket;
  timeout = setTimeout(() => { if (current()) ws.close(); }, 12000);
  ws.onopen = () => {
    if (current() && credentials) ws.send(JSON.stringify({ type: 'hello', token: credentials.token, protocol: PROTOCOL_VERSION }));
  };
  ws.onmessage = event => {
    if (!current() || typeof event.data !== 'string' || event.data.length > 1_000_000) return;
    try {
      const message = JSON.parse(event.data);
      if (!message || typeof message !== 'object') return;
      if (message.type === 'ready') {
        clearTimeout(timeout);
        attempts = 0;
        status.textContent = 'Conectado';
        ws.send(JSON.stringify({ type: 'get_history' }));
      }
      if (message.type === 'message_done' && typeof message.text === 'string' && typeof message.messageId === 'string') {
        card(message.messageId, message.text);
        intent = { outcome: { kind: message.error ? 'error' : 'done', at: performance.now() } };
        revision++;
      }
      if (message.type === 'history' && Array.isArray(message.messages)) {
        cards.replaceChildren();
        for (const entry of message.messages.slice(-4)) {
          if (entry && typeof entry.text === 'string' && typeof entry.id === 'string') card(entry.id, entry.text);
        }
      }
      if (message.type === 'toast' && typeof message.message === 'string') card('notice', message.message);
    } catch { /* Ignore malformed network messages; never render HTML. */ }
  };
  ws.onclose = event => {
    if (!current()) return;
    closeSocket();
    if (event.code === CloseCode.unauthorized || event.code === CloseCode.badProtocol) {
      credentials = undefined;
      status.textContent = 'Acceso rechazado. Comprueba token y versión.';
      return;
    }
    status.textContent = 'Sin conexión · reintentando';
    if (credentials && !document.hidden) timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)));
  };
}
element<HTMLFormElement>('connection').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const url = new URL(element<HTMLInputElement>('url').value);
    if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash) throw new Error('url');
    const token = element<HTMLInputElement>('token');
    credentials = { url: url.href, token: token.value };
    token.value = '';
    cards.replaceChildren();
    attempts = 0;
    connect();
  } catch { status.textContent = 'Usa wss://host/ws sin credenciales ni parámetros en la URL.'; }
});
element('disconnect').addEventListener('click', () => {
  credentials = undefined;
  closeSocket();
  cards.replaceChildren();
  status.textContent = 'Desconectado';
});
document.addEventListener('visibilitychange', () => {
  cancelAnimationFrame(frame);
  fx?.clear();
  if (document.hidden) {
    director.update(intent, performance.now(), true);
    closeSocket();
  } else {
    lastFrame = -1;
    animate(performance.now());
    connect();
  }
});
window.addEventListener('pagehide', () => { cancelAnimationFrame(frame); closeSocket(); engine?.dispose(); });
