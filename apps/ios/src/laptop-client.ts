import { createOrchestrationClient, type AgentApproval, type OrchestrationClient } from '@gentle-dot/ui/src/orchestration.ts';
import { DeviceBridgeError, httpsRequest, httpsReceiptState, type HTTPSRequest, type HTTPSResponse } from './device-bridge.ts';
import { validDaemonUrl } from './local-state.ts';
import type { DesktopConnection } from './desktop-tools.ts';
import { createControlJournal, runSessionControl, promptDigest } from './desktop-control-journal.ts';
import { uploadSessionFile } from './session-upload.ts';

/** Reuse the desktop session contract through the phone's authenticated native
 * transport. A connection change fences both outgoing requests and late reads. */
export function createLaptopClient(connection: DesktopConnection, options: {
  current: () => DesktopConnection | undefined;
  request?: (request: HTTPSRequest) => Promise<HTTPSResponse>;
  receiptState?: typeof httpsReceiptState;
  controlTimeoutMs?: number;
}): OrchestrationClient {
  const url = new URL(validDaemonUrl(connection.url));
  if (url.pathname !== '/ws' || !connection.token || /\s/.test(connection.token)) throw new Error('Vincula una laptop válida.');
  const origin = url.origin.replace('wss:', 'https:');
  const captured = { ...connection };
  const request = options.request ?? httpsRequest;
  function current() {
    const live = options.current();
    if (!live || live.url !== captured.url || live.token !== captured.token || live.deviceId !== captured.deviceId) throw new Error('Cambió la laptop vinculada. Actualiza las sesiones antes de continuar.');
  }
  const transport: typeof fetch = async (input, init) => {
    current(); init?.signal?.throwIfAborted();
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (target.origin !== origin || target.username || target.password || target.search || target.hash ||
      !['/orchestration', '/api/mobile/workflows', '/api/mobile/approvals', '/api/mobile/answer', '/api/mobile/computer', '/browser'].includes(target.pathname)) throw new Error('Destino de sesión no permitido.');
    const method = init?.method ?? 'GET';
    if (!['GET', 'POST'].includes(method) || (init?.body !== undefined && typeof init.body !== 'string')) throw new Error('Esta operación necesita un transporte de archivos.');
    let body = typeof init?.body === 'string' ? init.body : undefined;
    if (target.pathname === '/orchestration' && body) {
      const action: unknown = JSON.parse(body);
      if (action && typeof action === 'object' && 'action' in action && action.action === 'inspect')
        body = JSON.stringify({ ...action, historyContent: 'text-only-v1' });
    }
    const pending = request({ url: target.href, method: method as 'GET' | 'POST',
      headers: { Authorization: `Bearer ${captured.token}`, ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body } : {}) });
    let onAbort: (() => void) | undefined;
    const reply = await (init?.signal ? Promise.race([pending, new Promise<never>((_, reject) => {
      onAbort = () => reject(init.signal!.reason);
      init.signal!.addEventListener('abort', onAbort, { once: true });
      if (init.signal!.aborted) onAbort();
    })]) : pending).finally(() => { if (onAbort) init?.signal?.removeEventListener('abort', onAbort); });
    current(); init?.signal?.throwIfAborted();
    if (new TextEncoder().encode(reply.body).byteLength > 2 * 1024 * 1024) throw new DeviceBridgeError('size_limit', 'La sesión devolvió demasiados datos. Carga una página más pequeña.');
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  };
  const client = createOrchestrationClient(captured, { fetch: transport, terminalMood: false });
  client.requiresReviewedApproval = true;
  client.dotApprovalDeclineOnly = true;
  const snapshot = client.snapshot;
  client.snapshot = async signal => {
    const value = await snapshot(signal);
    if (value.sessions.length > 200 || value.sessions.some(session => !session ||
      typeof session.paneId !== 'string' || !session.paneId || session.paneId.length > 256 ||
      typeof session.label !== 'string' ||
      (session.provider !== undefined && !['herdr', 'orca', 'terminal'].includes(session.provider)) ||
      !['idle', 'working', 'blocked', 'done', 'unknown'].includes(session.state) ||
      typeof session.connected !== 'boolean' || (session.sessionId !== undefined && (typeof session.sessionId !== 'string' || session.sessionId.length > 256)))) {
      throw new Error('El equipo devolvió una sesión no válida.');
    }
    // HERDR and terminal titles are display text, and the daemon does not cap
    // them at 120 characters. A long title must not hide every other session.
    // Bound only the displayed label; never change routing identities.
    return { ...value, sessions: value.sessions.map(session => {
      const label = Array.from(session.label);
      return { ...session, label: label.length > 1000 ? `${label.slice(0, 999).join('')}…` : session.label };
    }) };
  };
  const inspect = client.inspect;
  // The daemon permits 50 messages by default, each potentially 32k UTF-16
  // units. A legitimate page can exceed the native 2 MiB response cap. Retry
  // only this read, preserving the cursor; actions are never replayed.
  let inspectionLimit = 50;
  client.inspect = async (paneId, sessionId, signal, page) => {
    let limit = Math.min(page?.limit ?? 50, inspectionLimit);
    let value;
    for (;;) {
      try {
        value = await inspect(paneId, sessionId, signal, { ...page, limit });
        break;
      } catch (error) {
        if (!(error instanceof DeviceBridgeError) || error.code !== 'size_limit' || limit <= 1) throw error;
        signal?.throwIfAborted();
        current();
        limit = Math.max(1, Math.floor(limit / 2));
        inspectionLimit = Math.min(inspectionLimit, limit);
      }
    }
    if (value.sessionId !== sessionId || (value.instanceId !== undefined && (typeof value.instanceId !== 'string' || !value.instanceId || value.instanceId.length > 256)) || value.messages.length > 200 || value.messages.some(message =>
      typeof message.id !== 'string' || message.id.length > 256 ||
      !['user', 'assistant', 'system', 'tool', 'toolResult'].includes(message.role) ||
      !Array.isArray(message.content) || message.content.length > 1000 || message.content.some(block => {
        const part = block as unknown as { type?: unknown; text?: unknown } | null;
        return !part || (part.type !== 'image' && (part.type !== 'text' || typeof part.text !== 'string' || part.text.length > 200_000));
      }))) throw new Error('El historial no corresponde a esta sesión.');
    // Reconcile only explicit, uniquely attributable Pi delivery evidence.
    const instanceId=(value as typeof value & {instanceId?:unknown}).instanceId;
    if(typeof instanceId==='string' && instanceId) for(const receipt of (value.deliveries ?? []).filter(item=>item.status==='delivered' && item.evidence==='correlated-v1').slice(-20)) {
      if(receipt.status==='delivered' && receipt.evidence==='correlated-v1') {
        current();try {await controlJournal.confirmControlDelivery(`${origin}/orchestration`,paneId,sessionId,instanceId,receipt.id);} catch { /* Keep the local notice when storage cannot be confirmed. */ }
        current();
      }
    }
    // Older adapters use Pi's `toolResult` role. The shared session view uses
    // `tool`; accepting the former without translating it silently hides real
    // history. Keep identity, text, error flags and ordering unchanged.
    return { ...value, messages: value.messages.map(message => ({ ...message,
      role: (message as { role: string }).role === 'toolResult' ? 'tool' as const : message.role,
      // Legacy adapters can return inline images. Keep surrounding captions and
      // order, but do not retain or silently claim to display image bytes.
      content: message.content.map(block => (block as { type: string }).type === 'image'
        ? { type: 'text' as const, text: '[Imagen adjunta no disponible en esta vista]' }
        : { type: 'text' as const, text: block.text }),
    })) };
  };
  // Human controls share the agent journal. Do not use the fetch adapter's
  // Promise.race here: cancellation of JS does not stop URLSession natively.
  const act = client.act, controlJournal = createControlJournal();
  client.act = async action => {
    if (action.action === 'grant') throw new Error('La autorización temporal desde el teléfono aún no tiene revisión vinculada al contenido; gestiona ese permiso en la laptop.');
    if (action.action === 'create' || action.action === 'revoke') {
      current();const kind=action.action;
      const payload=structuredClone(action) as unknown as Record<string,unknown>;
      const paneId=kind==='create'?'@create':'@policy', sessionId=kind==='create'?'@create':action.policyId;
      await runSessionControl(controlJournal,{kind,host:`${origin}/orchestration`,paneId,sessionId,instanceId:'global',payload,...(captured.deviceId?{deviceId:captured.deviceId}:{})},current,async receipt=>{
        current();const reply=await request({...receipt,url:`${origin}/orchestration`,method:'POST',headers:{Authorization:`Bearer ${captured.token}`,'Content-Type':'application/json'},body:JSON.stringify(action)});current();
        let ack:unknown;try{ack=JSON.parse(reply.body);}catch{throw new Error('Respuesta inválida.');}
        if(reply.status<200||reply.status>=300||!ack||typeof ack!=='object'||(kind==='create'?(!('created' in ack)||ack.created!==true):(!('revoked' in ack)||ack.revoked!==true))) throw new Error('Confirmación no verificable.');
      },options.receiptState ?? httpsReceiptState,undefined,options.controlTimeoutMs ?? 35000);
      return;
    }
    if (action.action !== 'abort' && action.action !== 'answer' && action.action !== 'prompt' && action.action !== 'close' && action.action !== 'duplicate') return act(action);
    current();
    const page = await client.inspect(action.paneId, action.sessionId, undefined, {limit:1});
    const instanceId=(page as typeof page & {instanceId?:unknown}).instanceId;
    if (typeof instanceId !== 'string' || !instanceId || instanceId.length>256) throw new Error('No se pudo identificar la instancia de la sesión.');
    const snapshot=await client.snapshot();current();
    if(snapshot.mutationInstanceFence!==1) throw new Error('La laptop necesita actualizarse para controlar una instancia verificada. Puedes seguir leyendo sus sesiones.');
    let wireAction = {...action,expectedInstanceId:instanceId};
    let review:AgentApproval | undefined;
    if (action.action==='answer') {
      const {reviewedApproval,expectedQuestionRevision:_untrustedRevision,...wire}=action;wireAction={...wire,expectedInstanceId:instanceId};
      if(!reviewedApproval || reviewedApproval.id!==action.requestId || reviewedApproval.paneId!==action.paneId || reviewedApproval.sessionId!==action.sessionId) throw new Error('Vuelve a abrir y revisar la solicitud humana.');
      const supplied=snapshot.approvals.find(item=>item.id===action.requestId && item.paneId===action.paneId && item.sessionId===action.sessionId);
      const q=page.question;
      const fresh:AgentApproval | undefined=supplied ?? (q?.id===action.requestId ? {...q,kind:q.kind as AgentApproval['kind'],paneId:action.paneId,sessionId:action.sessionId,message:q.message??'',action:q.title,createdAt:'',expiresAt:'expiresAt' in q && typeof q.expiresAt==='string'?q.expiresAt:''} : undefined);
      const reviewedFields=(a:AgentApproval)=>JSON.stringify([a.id,a.paneId,a.sessionId,a.title,a.message,a.action,a.expiresAt,a.answerable,a.kind,a.requiresConfirmation,a.options,a.placeholder,a.questions,a.questionRevision]);
      if(!fresh || reviewedFields(fresh)!==reviewedFields(reviewedApproval) || (fresh.expiresAt && Date.parse(fresh.expiresAt)<=Date.now())) throw new Error('La solicitud humana cambió o venció; vuelve a revisarla.');
      if (typeof reviewedApproval.questionRevision !== 'string' || !/^[a-f0-9]{64}$/.test(reviewedApproval.questionRevision)) throw new Error('Esta sesión no puede verificar el contenido al responder. Actualiza el adaptador o responde en la laptop.');
      wireAction={...wire,expectedInstanceId:instanceId,expectedQuestionRevision:reviewedApproval.questionRevision};
      review=structuredClone(reviewedApproval);
    }
    const operationDigest=action.action==='prompt' ? await promptDigest(action.text) : undefined;
    current();
    const payload={...structuredClone(wireAction),...(review?{reviewedApproval:review}:{}),...(operationDigest?{operationDigest}:{})} as unknown as Record<string,unknown>;
    await runSessionControl(controlJournal,{kind:action.action,host:`${origin}/orchestration`,paneId:action.paneId,sessionId:action.sessionId,instanceId,payload,...(captured.deviceId?{deviceId:captured.deviceId}:{})},current,async receipt=>{
      current();
      const reply=await request({...receipt,url:`${origin}/orchestration/guarded-v1`,method:'POST',headers:{Authorization:`Bearer ${captured.token}`,'Content-Type':'application/json'},body:JSON.stringify(wireAction)});
      current();
      let ack:unknown;try{ack=JSON.parse(reply.body);}catch{throw new Error('Respuesta inválida.');}
      if(reply.status<200||reply.status>=300||!ack||typeof ack!=='object') throw new Error('Confirmación no correlacionada.');
      if(action.action==='duplicate') {
        if(!('created' in ack)||ack.created!==true||!('sourceSessionId' in ack)||ack.sourceSessionId!==action.sessionId||!('sessionId' in ack)||typeof ack.sessionId!=='string'||ack.sessionId===action.sessionId) throw new Error('Confirmación de copia no verificable.');
      } else if(!('accepted' in ack)||ack.accepted!==true||!('sessionId' in ack)||ack.sessionId!==action.sessionId||!('instanceId' in ack)||ack.instanceId!==instanceId||(action.action==='close'&&(!('closing' in ack)||ack.closing!==true))) throw new Error('Confirmación no correlacionada.');
    },options.receiptState ?? httpsReceiptState,undefined,options.controlTimeoutMs ?? 35000,action.action === 'prompt');
  };
  // These answers are always human actions; bind the complete card to an
  // atomic versioned endpoint and retain uncertainty across app restarts.
  client.answerDotApproval = async (requestId, approved, reviewed) => {
    current();
    if(approved) throw new Error('Para permitir esta solicitud, revísala y responde en la laptop.');
    if(!reviewed || reviewed.id!==requestId || typeof approved!=='boolean' || typeof reviewed.title!=='string' || typeof reviewed.message!=='string' || typeof reviewed.expiresAt!=='string' || !Number.isFinite(Date.parse(reviewed.expiresAt)) || Date.parse(reviewed.expiresAt)<=Date.now() || JSON.stringify(reviewed).length>100000) throw new Error('Vuelve a abrir y revisar el permiso de Dot.');
    if(typeof reviewed.revision!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reviewed.revision)) throw new Error('La laptop necesita actualizarse para responder permisos de Dot desde el iPhone.');
    const card=structuredClone(reviewed);
    const approvals=await client.dotApprovals!();current();
    const fresh=approvals.approvals.find(item=>item.id===requestId);
    if(!approvals.allowed || !fresh || fresh.title!==card.title || fresh.message!==card.message || fresh.expiresAt!==card.expiresAt || fresh.revision!==card.revision) throw new Error('El permiso de Dot cambió o venció; vuelve a revisarlo.');
    const payload={requestId,approved,review:{id:card.id,title:card.title,message:card.message,expiresAt:card.expiresAt,revision:card.revision}};
    await runSessionControl(controlJournal,{kind:'dotAnswer',host:`${origin}/orchestration`,paneId:'@dot-approval',sessionId:requestId,instanceId:'global',payload,...(captured.deviceId?{deviceId:captured.deviceId}:{})},
      ()=>{current();if(Date.parse(card.expiresAt)<=Date.now())throw new Error('El permiso venció.');},async receipt=>{
        const reply=await request({...receipt,url:`${origin}/api/mobile/answer-v1`,method:'POST',headers:{Authorization:`Bearer ${captured.token}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});current();
        let ack:unknown;try{ack=JSON.parse(reply.body);}catch{throw new Error('Respuesta inválida.');}
        if(reply.status<200||reply.status>=300||!ack||typeof ack!=='object'||!('ok' in ack)||ack.ok!==true||!('requestId' in ack)||ack.requestId!==requestId||!('revision' in ack)||ack.revision!==card.revision) throw new Error('Confirmación de permiso no verificable.');
      },options.receiptState ?? httpsReceiptState,undefined,options.controlTimeoutMs ?? 35000);
  };
  client.uploadAttachment = (paneId, sessionId, file, uploadId, signal) => {
    current();
    return uploadSessionFile(captured, paneId, sessionId, file, { current: options.current, uploadId, signal });
  };
  return client;
}
