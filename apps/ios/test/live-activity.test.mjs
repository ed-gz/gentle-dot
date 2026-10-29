import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveActivityBridge } from '../src/live-activity.ts';
const id = 'd3dba896-4b5c-4c1c-98c9-4e60238fe6b9';
const request = { turnId: id, origin: 'iphone', phase: 'thinking', sequence: 1 };
const item = { ...request, id: 'activity-1', observedAt: 1000, stale: false };
test('inspects the real system before any start; only whitelisted fields cross the bridge', async () => {
  const calls = []; const bridge = createLiveActivityBridge({ installed: true, call: async (name, args) => {
    calls.push([name, args]); if (name === 'list') return { ok: true, items: [] };
    return { ok: true, id: item.id, items: [item] };
  } });
  await assert.rejects(bridge.start(request), /Consulta/);
  assert.deepEqual(await bridge.list(), []);
  assert.deepEqual(await bridge.start({ ...request, credential: 'must-not-cross' }), item);
  assert.deepEqual(calls[1], ['start', request]);
});
test('rejects unknown origins, fabricated phases, invalid identifiers and stale/negative sequences', async () => {
  const bridge = createLiveActivityBridge({ installed: true, call: async () => ({ ok: true, items: [] }) }); await bridge.list();
  for (const bad of [{ ...request, turnId: '../bad' }, { ...request, phase: 'completed' }, { ...request, origin: 'arbitrary' }, { ...request, sequence: -1 }, { ...request, sequence: 1.5 }]) await assert.rejects(bridge.start(bad));
  await assert.rejects(bridge.update({ ...request, id: '../bad' }));
  await assert.rejects(bridge.update({ ...request, id: 'ok', phase: 'working' }, true));
});
test('does not replay a start after an uncertain native response; listing is required again', async () => {
  let starts = 0; const bridge = createLiveActivityBridge({ installed: true, timeoutMs: 5, call: async name => {
    if (name === 'list') return { ok: true, items: starts ? [item] : [] };
    starts++; return new Promise(() => {});
  } });
  await bridge.list(); await assert.rejects(bridge.start(request), /tiempo/);
  await assert.rejects(bridge.start(request), /Consulta/); assert.equal(starts, 1);
  assert.deepEqual(await bridge.list(), [item]);
});
test('mismatched responses invalidate the inspection, while unsupported browser stays honest', async () => {
  const bridge = createLiveActivityBridge({ installed: true, call: async name => name === 'list' ? { ok: true, items: [] } : { ok: true, id: 'other', items: [item] } });
  await bridge.list(); await assert.rejects(bridge.start(request), /coincide/);
  await assert.rejects(bridge.start(request), /Consulta/);
  await assert.rejects(createLiveActivityBridge({ installed: false }).list(), /instalada/);
});
test('laptop activity carries the actual observation time and rejects a rewritten timestamp', async () => {
  const observedAt=1_800_000_000_000, laptop={...request,origin:'laptop',phase:'working',observedAt};let sent;
  const bridge=createLiveActivityBridge({installed:true,call:async(name,args)=>{
    if(name==='list')return {ok:true,items:[]};sent=args;return {ok:true,id:item.id,items:[{...item,...laptop,observedAt:observedAt+5000}]};
  }});
  await bridge.list();await assert.rejects(bridge.start(laptop),/observación/);assert.equal(sent.observedAt,observedAt);
  await assert.rejects(bridge.start({...laptop,observedAt:undefined}),/no es válido/);
});
