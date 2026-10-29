import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopSessionClient, createDesktopTools, parseDesktopPage, parseDesktopSessions } from '../src/desktop-tools.ts';
import { DeviceBridgeError } from '../src/device-bridge.ts';

const conn = { url: 'wss://computer.example.ts.net/ws', token: 'never-print-this-credential', deviceId: 'device-1' };
const target = { paneId: 'pane-1', sessionId: 'session-1' };
const session = { ...target, label: 'Operations', connected: true, state: 'idle', capabilities: { inspect: true, prompt: true, abort: true, deliveryReceipts: true } };
const page = () => ({ sessionId: target.sessionId, instanceId: 'instance-1', messages: [{ id: 'message-1', role: 'assistant', content: [{ type: 'text', text: 'Waiting for instruction' }] }], deliveries: [], history: { hasEarlier: false } });
const context = askApproval => ({ signal: new AbortController().signal, askApproval });
function memoryJournal() {
  const records = new Map(), pending = new Map();
  const get = id => { const item = records.get(id); if (!item) throw new Error('Envío desconocido'); return item; };
  return {
    async find(key) { const id = pending.get(key); return id ? structuredClone(get(id)) : null; },
    async begin(item) { if (pending.has(item.key)) throw new Error('Esta instrucción ya tiene un envío sin resolver.'); records.set(item.id, structuredClone(item)); pending.set(item.key,item.id); },
    async dispatching(id) { get(id).state='dispatching'; },
    async cancelBeforeDispatch(expected) { const item=get(expected.id); if (item.owner!==expected.owner) throw new Error('Dueño distinto'); item.state='cancelled'; pending.delete(item.key); },
    async unconfirmed(id) { get(id).state='unconfirmed'; },
    async recoverUnconfirmed(expected) { const item=get(expected.id); if (JSON.stringify(item)!==JSON.stringify(expected)) throw new Error('Envío cambió'); item.state='unconfirmed'; },
    async delivered(id, instanceId) { const item=get(id); if (item.instanceId !== instanceId) throw new Error('Instancia distinta'); item.state='delivered'; pending.delete(item.key); },
    async confirmControlDelivery() { return false; },
    async getPending(host,id) { const item=records.get(id);return item && item.host===host && pending.get(item.key)===id ? structuredClone(item) : null; },
    async page(host,offset,limit) { const items=await this.list(host);return {items:items.slice(offset,offset+limit),total:items.length}; },
    async list(host) { return [...pending.values()].map(id => structuredClone(get(id))).filter(item => item.host===host); },
    async reviewed(expected) { const item=get(expected.id); if (JSON.stringify(item)!==JSON.stringify(expected)) throw new Error('Envío cambió'); item.state='reviewed'; pending.delete(item.key); },
  };
}
function fixture(overrides = {}) {
  const calls = []; let receipt; let current = conn;
  const client = createDesktopSessionClient({ journal: overrides.journal ?? memoryJournal(), controlJournal: overrides.controlJournal ?? memoryJournal(), receiptState: overrides.receiptState ?? (async () => 'terminal'), getConnection: () => current, request: async request => {
    calls.push(request); const payload = request.body ? JSON.parse(request.body) : undefined;
    let value;
    if (!payload) value = { available: true, mutationInstanceFence:1, sessions: [session], approvals: [{ secret: 'do-not-project' }] };
    else if (payload.action === 'inspect') value = { ...page(), deliveries: receipt ? [receipt] : [] };
    else if (payload.action === 'prompt') {
      if (overrides.failSend) throw new Error('socket disconnected');
      receipt = { id: payload.clientMessageId, status: 'queued', acceptedAt: '2026-10-27T20:00:00Z', preview: payload.text, deliverAs: payload.deliverAs };
      value = { accepted: true, sessionId: target.sessionId, instanceId: overrides.wrongAck ? 'other-instance' : 'instance-1' };
    } else value = { accepted: true, sessionId: target.sessionId, instanceId: 'instance-1' };
    if (overrides.inspect && payload?.action === 'inspect') value = overrides.inspect(calls, value);
    return { status: 200, body: JSON.stringify(value), headers: {} };
  } });
  return { client, calls, changeConnection: value => { current = value; } };
}
test('session tools reuse existing sessions and expose no create/answer/permission tool', async () => {
  const f = fixture(); const sessions = await f.client.list(); assert.equal(sessions.length, 1); assert.equal(sessions[0].label, 'Operations'); assert.equal(sessions[0].approvals, undefined);
  assert.deepEqual(createDesktopTools({ getConnection: () => conn }).map(tool => tool.definition.name), ['session_list','session_read','session_delivery_list','session_delivery_resolve','session_send','session_control_list','session_control_resolve','session_abort']);
  const history = await f.client.read(target); assert.equal(history.messages[0].text, 'Waiting for instruction');
  assert.equal(f.calls[0].url, 'https://computer.example.ts.net/orchestration'); assert.equal(f.calls[0].headers.Authorization, `Bearer ${conn.token}`);
});
test('a late session inventory cannot be attributed to a newly selected laptop', async () => {
  let current = conn;
  let resolveRequest;
  const client = createDesktopSessionClient({ journal: memoryJournal(), controlJournal: memoryJournal(), receiptState: async () => 'terminal', getConnection: () => current, request: () => new Promise(resolve => { resolveRequest = resolve; }) });
  const listing = client.list();
  current = { ...conn, url: 'wss://other.example.ts.net/ws', deviceId: 'other-device' };
  resolveRequest({ status: 200, body: JSON.stringify({ available: true, mutationInstanceFence:1, sessions: [session] }), headers: {} });
  await assert.rejects(listing, /conexión cambió/);
});
test('send displays exact target and text before one mutation, then correlates a receipt without claiming completion', async () => {
  const f = fixture(); let reviewed;
  const result = await f.client.send({ ...target, text: 'Analyze deploy risks', deliverAs: 'followUp' }, context(async approval => {
    reviewed = JSON.parse(approval.details); assert.equal(f.calls.some(call => call.body && JSON.parse(call.body).action === 'prompt'), false); return true;
  }));
  assert.equal(reviewed.text, 'Analyze deploy risks'); assert.equal(reviewed.sessionId, target.sessionId); assert.equal(reviewed.token, undefined);
  assert.equal(result.status, 'queued'); assert.equal(result.completed, false); assert.equal(result.clientMessageId, reviewed.clientMessageId);
  const sends = f.calls.filter(call => call.body && JSON.parse(call.body).action === 'prompt'); assert.equal(sends.length, 1); assert.equal(JSON.parse(sends[0].body).clientMessageId, result.receipt.id);
});
test('legacy delivered receipts stay unconfirmed despite identical text from another client', async () => {
  for (const evidence of [undefined, 'correlated-v0', true]) {
    const f = fixture({ inspect: (calls, value) => {
      if (!calls.some(call => call.body && JSON.parse(call.body).action === 'prompt')) return value;
      return { ...value, messages: [{ id:'other-client', role:'user', content:'Analyze deploy risks' }], deliveries: value.deliveries.map(receipt => ({...receipt,status:'delivered',evidence,deliveredAt:'2026-10-27T20:01:00Z'})) };
    } });
    const result = await f.client.send({ ...target, text: 'Analyze deploy risks' }, context(async () => true));
    assert.equal(result.status, 'unconfirmed');
    assert.equal(result.receipt.status, 'unconfirmed');
    assert.equal(result.receipt.evidence, undefined);
    assert.equal(result.receipt.deliveredAt, undefined);
    assert.match(result.message, /no confirma que Pi haya consumido/);
    assert.equal(f.calls.filter(call => call.body && JSON.parse(call.body).action === 'prompt').length, 1);
    const read = await f.client.read(target);
    assert.equal(read.deliveries[0].status, 'unconfirmed');
  }
});
test('only an exact correlated receipt confirms delivery, not task completion', async () => {
  const f = fixture({ inspect: (calls, value) => calls.some(call => call.body && JSON.parse(call.body).action === 'prompt')
    ? { ...value, deliveries: value.deliveries.map(receipt => ({...receipt,status:'delivered',evidence:'correlated-v1',deliveredAt:'2026-10-27T20:01:00Z'})) }
    : value });
  const result = await f.client.send({ ...target, text: 'Analyze deploy risks' }, context(async () => true));
  assert.equal(result.status, 'delivered'); assert.equal(result.receipt.evidence, 'correlated-v1');
  assert.equal(result.completed, false); assert.match(result.message, /no confirma que el trabajo haya terminado/);
});
test('a replacement Pi process cannot confirm a prior send', async () => {
  const f = fixture({ inspect: (calls, value) => calls.some(call => call.body && JSON.parse(call.body).action === 'prompt')
    ? { ...value, instanceId:'new-process', deliveries:value.deliveries.map(receipt => ({...receipt,status:'delivered',evidence:'correlated-v1'})) }
    : value });
  const result = await f.client.send({ ...target, text: 'Analyze deploy risks' }, context(async () => true));
  assert.equal(result.status, 'unconfirmed'); assert.equal(result.receipt, undefined);
  assert.equal(f.calls.filter(call => call.body && JSON.parse(call.body).action === 'prompt').length, 1);
});
test('a connection changed during post-ack inspection stays unconfirmed', async () => {
  let current = conn, sends = 0;
  const client = createDesktopSessionClient({ journal: memoryJournal(), controlJournal: memoryJournal(), receiptState: async () => 'terminal', getConnection: () => current, request: async request => {
    const payload = request.body ? JSON.parse(request.body) : undefined;
    if (!payload) return { status:200, headers:{}, body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[session]}) };
    if (payload.action === 'prompt') { sends++; return {status:200,headers:{},body:JSON.stringify({accepted:true,sessionId:target.sessionId,instanceId:'instance-1'})}; }
    if (sends) current = {...conn, deviceId:'new-device'};
    return {status:200,headers:{},body:JSON.stringify(page())};
  } });
  const result = await client.send({...target,text:'Analyze deploy risks'},context(async () => true));
  assert.equal(result.status, 'unconfirmed'); assert.match(result.message, /host original/); assert.equal(sends, 1);
});
test('missing/denied approval, changed connection and replaced Pi process prevent mutation', async () => {
  for (const ask of [undefined, async () => false]) {
    const f = fixture(); await assert.rejects(f.client.send({ ...target, text: 'Do work' }, context(ask)), /no fue aprobada/);
    assert.equal(f.calls.some(call => call.body && JSON.parse(call.body).action === 'prompt'), false);
  }
  const f = fixture(); await assert.rejects(f.client.send({ ...target, text: 'Do work' }, context(async () => { f.changeConnection({ ...conn, deviceId: 'new-device' }); return true; })), /conexión cambió/);
  let reads = 0; const changed = fixture({ inspect: (_calls, value) => ({ ...value, instanceId: ++reads > 1 ? 'restarted-instance' : 'instance-1' }) });
  await assert.rejects(changed.client.send({ ...target, text: 'Do work' }, context(async () => true)), /reinició/);
  assert.equal(changed.calls.some(call => call.body && JSON.parse(call.body).action === 'prompt'), false);
});
test('lost or mismatched acknowledgement is uncertain and never retried automatically', async () => {
  for (const flags of [{ failSend: true }, { wrongAck: true }]) {
    const f = fixture(flags); const result = await f.client.send({ ...target, text: 'Do work' }, context(async () => true));
    assert.equal(result.status, 'uncertain'); assert.match(result.clientMessageId, /^[a-f0-9-]{36}$/);
    assert.equal(f.calls.filter(call => call.body && JSON.parse(call.body).action === 'prompt').length, 1);
  }
});
test('an uncertain send remains blocked after client restart, while a distinct instruction is allowed', async () => {
  const journal = memoryJournal();
  const first = fixture({journal, failSend:true});
  const uncertain = await first.client.send({...target,text:'Revisar compilación'},context(async () => true));
  assert.equal(uncertain.status,'uncertain');
  const restarted = fixture({journal}); let approvals=0;
  const duplicate = await restarted.client.send({...target,text:'Revisar compilación',deliverAs:'steer'},context(async () => { approvals++; return true; }));
  assert.equal(duplicate.status,'unconfirmed'); assert.equal(duplicate.clientMessageId,uncertain.clientMessageId);
  assert.equal(approvals,0); assert.equal(restarted.calls.filter(call => call.body && JSON.parse(call.body).action==='prompt').length,0);
  const different = await restarted.client.send({...target,text:'Revisar pruebas'},context(async () => true));
  assert.equal(different.status,'queued');
});
test('review closes only the exact pending record with explicit approval and never sends', async () => {
  const journal = memoryJournal(); const f = fixture({journal,failSend:true});
  const result = await f.client.send({...target,text:'Revisar compilación'},context(async () => true));
  const {items:[record]} = await f.client.listDeliveries(); assert.equal(record.id,result.clientMessageId);
  const sends = f.calls.filter(call => call.body && JSON.parse(call.body).action==='prompt').length;
  await assert.rejects(f.client.resolveDelivery({clientMessageId:record.id},context(async () => false)),/no fue aprobada/);
  let review;
  const resolved = await f.client.resolveDelivery({clientMessageId:record.id},context(async input => { review=JSON.parse(input.details); return true; }));
  assert.equal(review.attempt.text,'Revisar compilación'); assert.equal(review.attempt.host,'https://computer.example.ts.net/orchestration');
  assert.match(review.warning,/no.*reenvía/); assert.equal(review.token,undefined);
  assert.equal(resolved.resent,false); assert.deepEqual((await f.client.listDeliveries()).items,[]);
  assert.equal(f.calls.filter(call => call.body && JSON.parse(call.body).action==='prompt').length,sends);
});
test('review rejects changed records and a different host after approval', async () => {
  const journal=memoryJournal(), f=fixture({journal,failSend:true});
  const result=await f.client.send({...target,text:'Revisar antes'},context(async () => true));
  await assert.rejects(f.client.resolveDelivery({clientMessageId:result.clientMessageId},context(async () => {
    await journal.reviewed((await journal.list('https://computer.example.ts.net/orchestration'))[0]);
    return true;
  })),/cambió/);
  const again=fixture({journal,failSend:true});
  const second=await again.client.send({...target,text:'Revisar otra'},context(async () => true));
  await assert.rejects(again.client.resolveDelivery({clientMessageId:second.clientMessageId},context(async () => {
    again.changeConnection({...conn,deviceId:'otro'}); return true;
  })),/conexión cambió/);
  assert.equal((await journal.list('https://computer.example.ts.net/orchestration')).length,1);
});
test('storage failure prevents dispatch even after user approval', async () => {
  const base=memoryJournal(), journal={...base,async begin() { throw new Error('Almacenamiento no disponible'); }};
  const f=fixture({journal});
  await assert.rejects(f.client.send({...target,text:'Sin registro'},context(async () => true)),/Almacenamiento/);
  assert.equal(f.calls.filter(call => call.body && JSON.parse(call.body).action==='prompt').length,0);
});
test('a lost reservation callback cancels the known pre-transport attempt', async () => {
  const base=memoryJournal(), journal={...base,async begin(item) { await base.begin(item); throw new Error('callback perdido'); }};
  const f=fixture({journal});
  await assert.rejects(f.client.send({...target,text:'Sin enviar'},context(async () => true)),/callback perdido/);
  assert.deepEqual((await f.client.listDeliveries()).items,[]);
  assert.equal(f.calls.filter(call => call.body && JSON.parse(call.body).action==='prompt').length,0);
});
test('cancellation before transport closes the reservation without calling prompt', async () => {
  const base=memoryJournal(), controller=new AbortController();
  const journal={...base,async dispatching(id) { await base.dispatching(id); controller.abort(); }};
  const f=fixture({journal});
  await assert.rejects(f.client.send({...target,text:'Cancelar antes'}, {signal:controller.signal,askApproval:async () => true}),{name:'AbortError'});
  assert.deepEqual((await f.client.listDeliveries()).items,[]);
  assert.equal(f.calls.filter(call => call.body && JSON.parse(call.body).action==='prompt').length,0);
});
test('cancellation after transport starts preserves uncertainty and prevents replay', async () => {
  const journal=memoryJournal(), controller=new AbortController(); let sends=0;
  const client=createDesktopSessionClient({journal,controlJournal:memoryJournal(),receiptState:async()=> 'terminal',getConnection:()=>conn,request:async request => {
    const payload=request.body?JSON.parse(request.body):undefined;
    if (!payload) return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[session]})};
    if (payload.action==='prompt') { sends++; controller.abort(); throw new Error('interrupted'); }
    return {status:200,headers:{},body:JSON.stringify(page())};
  }});
  const result=await client.send({...target,text:'Ya empezó'}, {signal:controller.signal,askApproval:async()=>true});
  assert.equal(result.status,'uncertain'); assert.equal(sends,1);
  const restored=fixture({journal});
  const duplicate=await restored.client.send({...target,text:'Ya empezó'},context(async()=>true));
  assert.equal(duplicate.status,'unconfirmed');
  assert.equal(restored.calls.filter(call=>call.body && JSON.parse(call.body).action==='prompt').length,0);
});
test('a different host cannot list the original host pending records', async () => {
  const journal=memoryJournal(), f=fixture({journal,failSend:true});
  await f.client.send({...target,text:'Trabajo original'},context(async()=>true));
  f.changeConnection({...conn,url:'wss://other.example.ts.net/ws'});
  assert.deepEqual((await f.client.listDeliveries()).items,[]);
  f.changeConnection(conn);
  assert.equal((await f.client.listDeliveries()).items.length,1);
});
test('concurrent identical approvals reserve at most one dispatch', async () => {
  const journal=memoryJournal(), one=fixture({journal}), two=fixture({journal});
  const results=await Promise.allSettled([one.client.send({...target,text:'Una sola'},context(async () => true)),two.client.send({...target,text:'Una sola'},context(async () => true))]);
  assert.equal(results.filter(item => item.status==='fulfilled').length,1);
  assert.equal([...one.calls,...two.calls].filter(call => call.body && JSON.parse(call.body).action==='prompt').length,1);
});
test('a session prompt whose connection changes in flight remains uncertain and is not retried', async () => {
  let current = conn;
  let sends = 0;
  const client = createDesktopSessionClient({ journal: memoryJournal(), controlJournal: memoryJournal(), receiptState: async () => 'terminal', getConnection: () => current, request: async request => {
    const payload = request.body ? JSON.parse(request.body) : undefined;
    if (!payload) return { status: 200, headers: {}, body: JSON.stringify({ available: true, mutationInstanceFence:1, sessions: [session] }) };
    if (payload.action === 'inspect') return { status: 200, headers: {}, body: JSON.stringify(page()) };
    sends++;
    current = { ...conn, url: 'wss://other.example.ts.net/ws', deviceId: 'other-device' };
    return { status: 200, headers: {}, body: JSON.stringify({ accepted: true, sessionId: target.sessionId, instanceId: 'instance-1' }) };
  } });
  const result = await client.send({ ...target, text: 'Revisar trabajo' }, context(async () => true));
  assert.equal(result.status, 'uncertain');
  assert.equal(sends, 1);
});
test('a late stop acknowledgement after switching laptops stays unconfirmed', async () => {
  let current = conn;
  let stops = 0;
  const client = createDesktopSessionClient({ journal: memoryJournal(), controlJournal: memoryJournal(), receiptState: async () => 'terminal', getConnection: () => current, request: async request => {
    const payload = request.body ? JSON.parse(request.body) : null;
    if (!payload) return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[session]})};
    if (payload.action === 'inspect') return { status: 200, headers: {}, body: JSON.stringify(page()) };
    stops++;
    current = { ...conn, deviceId: 'other-device' };
    return { status: 200, headers: {}, body: JSON.stringify({ accepted: true, sessionId: target.sessionId, instanceId: 'instance-1' }) };
  } });
  await assert.rejects(client.abort(target, context(async () => true)), /No se confirmó si la sesión recibió/);
  assert.equal(stops, 1);
});
test('abort approval identifies shared session, and schema guards reject forged or oversized host data', async () => {
  const f = fixture(); let approval;
  assert.equal((await f.client.abort(target, context(async input => { approval = input; return true; }))).accepted, true);
  assert.equal(JSON.parse(approval.details).action, 'abort'); assert.equal(JSON.parse(approval.details).sessionId, target.sessionId);
  assert.throws(() => parseDesktopPage({ ...page(), sessionId: 'foreign' }, target.sessionId), /distinta/);
  assert.throws(() => parseDesktopPage({ ...page(), deliveries: [{ id: 'r', status: 'done' }] }, target.sessionId), /inválida/);
  assert.throws(() => parseDesktopSessions({ available: true, mutationInstanceFence:1, sessions: [{ ...session, paneId: '\0' }] }), /válida/);
});
test('human-only answer rechecks the exact current question after approval', async () => {
  const question = { id: 'q1', title: 'Enviar correo', message: 'A: Ana. Texto exacto.', kind: 'confirm', expiresAt: new Date(Date.now() + 60000).toISOString() };
  let reads = 0; const f = fixture({ inspect: (_calls, value) => ({ ...value, questionRevision:'a'.repeat(64), capabilities:{questionBinding:1}, question: { ...question, message: ++reads > 1 ? 'Texto cambiado.' : question.message } }) });
  await assert.rejects(f.client.answerFromHuman({ ...target, requestId: 'q1', confirmed: true }, context(async () => true)), /permiso cambió/);
  assert.equal(f.calls.some(call => call.body && JSON.parse(call.body).action === 'answer'), false);
});
test('human review preserves authored option effects and refuses a changed consequence', async () => {
  let reads = 0; const question = { id: 'q1', title: 'Publicar', message: 'Elige el alcance.', kind: 'select', expiresAt: new Date(Date.now() + 60000).toISOString(), fingerprint: 'content-hash', options: [{ id: 'publish', label: 'Publicar', description: 'Envía el documento completo', effect: 'Visible para el equipo', consequence: 'Comunicación externa' }] };
  const f = fixture({ inspect: (_calls, value) => ({ ...value, questionRevision:'a'.repeat(64), capabilities:{questionBinding:1}, question: { ...question, options: question.options.map(option => ({ ...option, consequence: ++reads > 1 ? 'Público en internet' : option.consequence })) } }) });
  let reviewed;
  await assert.rejects(f.client.answerFromHuman({ ...target, requestId: 'q1', optionId: 'publish' }, context(async approval => { reviewed = JSON.parse(approval.details); return true; })), /permiso cambió/);
  assert.equal(reviewed.request.options[0].description, question.options[0].description); assert.equal(reviewed.request.options[0].consequence, 'Comunicación externa');
  assert.equal(f.calls.some(call => call.body && JSON.parse(call.body).action === 'answer'), false);
});
test('cancellation during the post-approval reread prevents the pending mutation', async () => {
  const controller = new AbortController(); let reads = 0;
  const f = fixture({ inspect: (_calls, value) => { if (++reads === 2) controller.abort(); return value; } });
  await assert.rejects(f.client.send({ ...target, text: 'Do work' }, { signal: controller.signal, askApproval: async () => true }));
  assert.equal(f.calls.some(call => call.body && JSON.parse(call.body).action === 'prompt'), false);
});

test('agent session read adapts valid large history while preserving cursor and reuses the safe limit', async () => {
  const calls = [];
  const client = createDesktopSessionClient({ journal: memoryJournal(), controlJournal: memoryJournal(), receiptState: async () => 'terminal', getConnection: () => conn, request: async request => {
    const payload = JSON.parse(request.body); calls.push(payload);
    if (payload.limit === 50) throw new DeviceBridgeError('size_limit', 'native limit');
    return { status: 200, headers: {}, body: JSON.stringify({ ...page(),
      messages: Array.from({ length: payload.limit }, (_, index) => ({ id: `m${index}`, role: 'assistant', content: 'x'.repeat(25000) })),
      history: { hasEarlier: true, before: 'previous' } }) };
  } });
  const value = await client.read({ ...target, limit: 50, before: 'original' });
  assert.deepEqual(calls.map(call => call.limit), [50, 25, 12, 6]);
  assert.ok(calls.every(call => call.action === 'inspect' && call.before === 'original' && call.sessionId === target.sessionId));
  assert.equal(value.messages.length, 6); assert.equal(value.history.before, 'previous');
  calls.length = 0; await client.read(target); assert.equal(calls[0].limit, 6);
});

test('agent session read never retries network failure, cancellation or a changed connection', async () => {
  let current = conn, calls = 0;
  const controller = new AbortController();
  const client = createDesktopSessionClient({ journal: memoryJournal(), controlJournal: memoryJournal(), receiptState: async () => 'terminal', getConnection: () => current, request: async () => {
    calls++;
    if (calls === 1) throw new Error('offline');
    if (calls === 2) { controller.abort(); throw new DeviceBridgeError('size_limit', 'large'); }
    current = { ...conn, deviceId: 'replacement' };
    throw new DeviceBridgeError('size_limit', 'large');
  } });
  await assert.rejects(client.read(target), /no confirmó/); assert.equal(calls, 1);
  await assert.rejects(client.read(target, controller.signal), { name: 'AbortError' }); assert.equal(calls, 2);
  await assert.rejects(client.read(target), /conexión cambió/); assert.equal(calls, 3);
});

test('agent session read does not retry malformed or oversized individual messages', async () => {
  let calls = 0;
  const client = createDesktopSessionClient({ journal: memoryJournal(), controlJournal: memoryJournal(), receiptState: async () => 'terminal', getConnection: () => conn, request: async () => {
    calls++;
    return { status: 200, headers: {}, body: JSON.stringify({ ...page(), messages: [{ id: 'm', role: 'assistant', content: 'x'.repeat(32001) }] }) };
  } });
  await assert.rejects(client.read(target), /mensaje.*supera/); assert.equal(calls, 1);
});

test('agent session read also adapts when the JavaScript response limit is exceeded', async () => {
  const limits = [];
  const client = createDesktopSessionClient({ journal: memoryJournal(), controlJournal: memoryJournal(), receiptState: async () => 'terminal', getConnection: () => conn, request: async request => {
    const payload = JSON.parse(request.body); limits.push(payload.limit);
    return { status: 200, headers: {}, body: JSON.stringify({ ...page(),
      messages: Array.from({ length: payload.limit }, (_, index) => ({ id: `m${index}`, role: 'assistant', content: 'x'.repeat(25000) })) }) };
  } });
  assert.equal((await client.read({ ...target, limit: 50 })).messages.length, 6);
  assert.deepEqual(limits, [50, 25, 12, 6]);
});

test('an oversized response to a session mutation remains uncertain and is never replayed', async () => {
  let sends = 0;
  const client = createDesktopSessionClient({ journal: memoryJournal(), controlJournal: memoryJournal(), receiptState: async () => 'terminal', getConnection: () => conn, request: async request => {
    const payload = request.body && JSON.parse(request.body);
    if (payload?.action === 'prompt') { sends++; throw new DeviceBridgeError('size_limit', 'large'); }
    return { status: 200, headers: {}, body: JSON.stringify(payload ? page() : { available: true, mutationInstanceFence:1, sessions: [session] }) };
  } });
  const result = await client.send({ ...target, text: 'Revisa la sesión' }, context(async () => true));
  assert.equal(result.status, 'uncertain'); assert.equal(sends, 1);
});

test('a host advertising question binding cannot omit the revision', () => {
  assert.throws(() => parseDesktopPage({...page(),capabilities:{questionBinding:1},question:{id:'q',kind:'confirm',title:'Revisar',message:'Contenido',expiresAt:new Date(Date.now()+60000).toISOString()}},target.sessionId), /no confirmó la revisión/);
});

test('human-only answer binds the reviewed revision and refuses a changed revision', async () => {
 const revision='a'.repeat(64),question={id:'q1',title:'Revisar',message:'Contenido exacto',kind:'confirm',expiresAt:new Date(Date.now()+60000).toISOString()};
 let reads=0,change=false,sent;
 const client=createDesktopSessionClient({journal:memoryJournal(),controlJournal:memoryJournal(),getConnection:()=>conn,request:async request=>{
  const payload=request.body?JSON.parse(request.body):null;if(!payload)return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[session]})};if(payload.action==='inspect'){reads++;return {status:200,headers:{},body:JSON.stringify({...page(),question,questionRevision:change&&reads>1?'b'.repeat(64):revision,capabilities:{questionBinding:1}})};}
  sent=payload;return {status:200,headers:{},body:JSON.stringify({accepted:true,sessionId:target.sessionId,instanceId:'instance-1'})};
 }});
 change=true;await assert.rejects(client.answerFromHuman({...target,requestId:'q1',confirmed:true},context(async()=>true)),/permiso cambió/);assert.equal(sent,undefined);
 change=false;reads=0;assert.equal((await client.answerFromHuman({...target,requestId:'q1',confirmed:true},context(async()=>true))).accepted,true);assert.equal(sent.expectedQuestionRevision,revision);
});

test('session transport error stays dispatching until the exact native terminal callback', async () => {
 let state='active';const journal=memoryJournal();const f=fixture({journal,failSend:true,receiptState:async()=>state});
 const first=await f.client.send({...target,text:'Instrucción exacta'},context(async()=>true));assert.equal(first.status,'uncertain');
 const request=f.calls.find(call=>call.body&&JSON.parse(call.body).action==='prompt');assert.equal(request.receiptId,first.clientMessageId);assert.match(request.receiptOwner,/^[a-f0-9-]{36}$/);
 const pending=(await f.client.listDeliveries()).items[0];assert.equal(pending.state,'dispatching');
 await assert.rejects(f.client.resolveDelivery({clientMessageId:first.clientMessageId},context(async()=>true)),/permanece bloqueado/);
 state='terminal';let reviewed;const result=await f.client.resolveDelivery({clientMessageId:first.clientMessageId},context(async value=>{reviewed=JSON.parse(value.details);return true;}));
 assert.equal(result.reviewed,true);assert.match(reviewed.warning,/podría seguir en curso/);
});

test('agent timeout frees the caller without treating the native request as finished', async () => {
 const journal=memoryJournal(),controlJournal=memoryJournal();let sends=0;
 const client=createDesktopSessionClient({journal,controlJournal,controlTimeoutMs:15,receiptState:async()=> 'active',getConnection:()=>conn,request:async request=>{
  const payload=request.body?JSON.parse(request.body):null;if(!payload)return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[session]})};
  if(payload.action==='prompt'){sends++;return new Promise(()=>{});}return {status:200,headers:{},body:JSON.stringify(page())};
 }});
 const first=await client.send({...target,text:'Pendiente'},context(async()=>true));assert.equal(first.status,'uncertain');assert.equal(sends,1);
 const pending=(await client.listDeliveries()).items[0];assert.equal(pending.state,'dispatching');
 const second=await client.send({...target,text:'Pendiente'},context(async()=>true));assert.equal(second.status,'unconfirmed');assert.equal(sends,1);
});
