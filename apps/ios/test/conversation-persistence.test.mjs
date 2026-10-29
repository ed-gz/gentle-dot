import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyConversationEntry, createConversationPersistence } from '../src/conversation-persistence.ts';
import { updateEntry, reconcileHostHistory } from '../src/conversation.ts';
const entry = (id, extra = {}) => ({ id, engine: 'iphone', role: 'assistant', state: 'complete', text: `Mensaje ${id}`, at: 1000, ...extra });
const defer = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise,resolve,reject }; };

test('only the accepted normalized linked response reaches the archive queue', async () => {
  const saved = [];
  const persistence = createConversationPersistence({ archive: { upsert: async rows => { saved.push(...rows); } }, save: async () => {} });
  const request = '02bce422-1da0-4ebc-b2fb-9df32a25434e';
  const turn = 'd3dba896-4b5c-4c1c-98c9-4e60238fe6b9';
  const activity = { id: 'lookup', title: 'Consultar', kind: 'read', status: 'done' };
  const original = [entry(turn, { state: 'pending', text: 'Parcial', at: 100, replyTo: request, activities: [activity] })];
  // A later valid update may omit inherited fields; archival must use the
  // visible, accepted turn and retain its link and original event time.
  const current = applyConversationEntry(persistence, original, entry(turn, { state: 'complete', text: 'Final', at: 200 }));
  assert.equal(current[0].replyTo, request);
  assert.equal(current[0].at, 100);
  assert.deepEqual(current[0].activities, [activity]);
  // A conflicting link is refused by the timeline and must not be queued.
  const rejected = applyConversationEntry(persistence, current, entry(turn, { text: 'No archivar', replyTo: 'a3dba896-4b5c-4c1c-98c9-4e60238fe6b9' }));
  assert.equal(rejected, current);
  await persistence.persist({ entries: rejected, draft: '' });
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], current[0]);
  assert.equal(saved[0].text, 'Final');
});

test('pruned messages stay queued until archival transaction confirms and latest window persists', async () => {
  const gate = defer(), writes = [], snapshots = [];
  const persistence = createConversationPersistence({ archive: { upsert: async rows => { writes.push(rows); await gate.promise; } }, save: async value => snapshots.push(value) });
  let visible = [];
  for (let i=0; i<205; i++) { const next=entry(`m${i}`); persistence.enqueue(visible); persistence.enqueue([next]); visible=updateEntry(visible,next); }
  const saving=persistence.persist({ entries:visible,draft:'Borrador' });
  await Promise.resolve(); assert.equal(writes[0].length,205); assert.equal(persistence.status().pending,205); assert.equal(visible.length,120);
  gate.resolve(); await saving;
  assert.equal(persistence.status().pending,0); assert.equal(snapshots[0].entries.length,120); assert.equal(snapshots[0].draft,'Borrador');
});
test('late commit never deletes a newer receipt or interrupted state queued under the same ID', async () => {
  const gate=defer(), writes=[]; let first=true;
  const persistence=createConversationPersistence({ archive: { upsert: async rows=> { writes.push(rows); if(first){first=false;await gate.promise;} } }, save:async()=>{} });
  const old=entry('operation',{state:'pending',activities:[{id:'call',kind:'other',title:'Guardar trabajo',status:'running'}]});
  const saving=persistence.persist({ entries:[old],draft:'' }); await Promise.resolve();
  const latest=entry('operation',{state:'interrupted',activities:[{id:'call',kind:'other',title:'Guardar trabajo',status:'done',detail:'receipt:local-42'}]});
  persistence.enqueue([latest]); gate.resolve(); await saving;
  assert.equal(persistence.status().pending,1); assert.equal(persistence.pending()[0].activities[0].detail,'receipt:local-42');
  await persistence.persist({entries:[latest],draft:''});
  assert.equal(persistence.status().pending,0); assert.equal(writes[1][0].state,'interrupted'); assert.equal(writes[1][0].activities[0].status,'done');
});
test('quota failure preserves all pending messages and still saves the visible window and draft; retry recovers', async () => {
  let fail=true; const snapshots=[];
  const persistence=createConversationPersistence({ archive:{upsert:async()=>{if(fail)throw Error('QuotaExceededError');}}, save:async value=>snapshots.push(value) });
  const rows=Array.from({length:200},(_,index)=>entry(String(index))); persistence.enqueue(rows);
  await persistence.persist({entries:rows.slice(-120),draft:'No perder'});
  assert.equal(persistence.status().blocked,true); assert.equal(persistence.pending().length,200); assert.equal(snapshots[0].draft,'No perder');
  fail=false; await persistence.persist({entries:rows.slice(-120),draft:'No perder'}); assert.equal(persistence.status().blocked,false); assert.equal(persistence.pending().length,0);
});
test('archive success does not hide failure to persist the visible draft', async () => {
  const persistence=createConversationPersistence({archive:{upsert:async()=>{}},save:async()=>{throw Error('Draft unavailable');}});
  await persistence.persist({entries:[entry('a')],draft:'Borrador'});
  assert.equal(persistence.status().blocked,true); assert.equal(persistence.status().conversationError,'Draft unavailable');
});
test('history reconciliation exposes older inserted messages before clipping the visible window', () => {
  const entries=Array.from({length:120},(_,index)=>entry('local-'+index)); let captured=[];
  const result=reconcileHostHistory(entries,'host:wss://a.example/ws|session|',[{id:'old',role:'user',text:'Earlier host message'}],2000,values=>captured=values);
  assert.equal(result.length,120); assert.equal(captured.length,121); assert.equal(captured[0].id,'local-0');
});

test('a late restore cannot replace newer live entries already pruned out of the visible window', async () => {
  const persistence=createConversationPersistence({ archive:{upsert:async()=>{}},save:async()=>{} });
  const live=entry('pruned-live',{text:'Confirmed live receipt',state:'complete'});
  persistence.enqueue([live]);
  persistence.seed([entry('pruned-live',{text:'Stale restore',state:'interrupted'})]);
  assert.equal(persistence.pending()[0].text,'Confirmed live receipt');
});
