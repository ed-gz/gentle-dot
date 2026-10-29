import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTrustedApprovals } from '../src/trusted-approvals.ts';

const token = 't'.repeat(48);
const connection = { url: 'wss://workstation.tail1234.ts.net/ws', token };
const view = () => ({ id:'approval-unique-id', title:'Enviar mensaje', message:'Destinatario: Ana\nTexto: Confirmo el acuerdo.', expiresAt:'2099-01-01T00:00:00.000Z', revision:'550e8400-e29b-41d4-a716-446655440000' });
const response = (approvals, status = 200) => ({ status, headers: {}, body: JSON.stringify({ approvals }) });

test('a human card cannot approve or call the legacy endpoint even when the preview looks complete', async () => {
  const calls=[];const helper=createTrustedApprovals({getConnection:()=>connection,request:async request=>{calls.push(request);return response([view()]);}});
  const [snapshot]=await helper.list();assert.equal(Object.isFrozen(snapshot),true);assert.equal(snapshot.body,view().message);
  await assert.rejects(helper.answer(snapshot,true),error=>error.code==='forbidden' && /laptop/.test(error.message));
  await assert.rejects(helper.answer({...snapshot},false),error=>error.code==='invalid');
  assert.deepEqual(calls.map(call=>call.method),['GET']);
});

test('changed content, revision, expiry, connection or missing old-host revision blocks a refusal before transport', async () => {
  for(const mutate of [item=>({...item,title:'Otro'}),item=>({...item,message:'Otro'}),item=>({...item,revision:'a50e8400-e29b-41d4-a716-446655440000'}),item=>({...item,expiresAt:'2098-01-01T00:00:00.000Z'}),()=>undefined]) {
    let reads=0,posts=0;const helper=createTrustedApprovals({getConnection:()=>connection,request:async request=>{if(request.method==='POST')posts++;const item=++reads===1?view():mutate(view());return response(item?[item]:[]);}});
    const [snapshot]=await helper.list();await assert.rejects(helper.answer(snapshot,false),error=>['changed','expired'].includes(error.code));assert.equal(posts,0);
  }
  let posts=0;const old=createTrustedApprovals({getConnection:()=>connection,request:async request=>{if(request.method==='POST')posts++;const {revision,...legacy}=view();return response([legacy]);}});
  const [snapshot]=await old.list();await assert.rejects(old.answer(snapshot,false),error=>error.code==='forbidden' && /actualizarse/.test(error.message));assert.equal(posts,0);
  let current=connection;const changed=createTrustedApprovals({getConnection:()=>current,request:async()=>response([view()])});const [previous]=await changed.list();current={...connection,token:'r'.repeat(48)};
  await assert.rejects(changed.answer(previous,false),error=>error.code==='changed');
});

test('unauthorized and malformed listings remain explicit and never trigger answers', async () => {
  const forbidden=createTrustedApprovals({getConnection:()=>connection,request:async()=>response([],403)});
  await assert.rejects(forbidden.list(),error=>error.code==='forbidden' && /token maestro/.test(error.message));
  const duplicates=createTrustedApprovals({getConnection:()=>connection,request:async()=>response([view(),view()])});
  await assert.rejects(duplicates.list(),error=>error.code==='invalid');
  const expired=createTrustedApprovals({getConnection:()=>connection,now:()=>Date.parse('2100-01-01T00:00:00.000Z'),request:async()=>response([view()])});
  assert.deepEqual(await expired.list(),[]);
});
