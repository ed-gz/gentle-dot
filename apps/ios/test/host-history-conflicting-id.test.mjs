import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reconcileHostHistory,updateEntry} from '../src/conversation.ts';

const prefix='host:wss://fixture.example/ws|c1|';
const record=(id,role,text)=>({id,role,text,activities:[]});
test('conflicting historical IDs are rejected before a visible or archive snapshot can be changed',()=>{
  const initial=[{id:prefix+'s0-1',role:'user',text:'Mensaje previo',engine:'gentle',state:'complete',at:1}];
  let archived=false;
  assert.throws(()=>reconcileHostHistory(initial,prefix,[record('s0-1','assistant','Respuesta distinta')],2,()=>{archived=true;}),/identidad/iu);
  assert.equal(archived,false);assert.equal(initial[0].text,'Mensaje previo');
  assert.throws(()=>reconcileHostHistory([],prefix,[record('s0-1','user','Uno'),record('s0-1','assistant','Dos')],2,()=>{archived=true;}),/identidad/iu);
  assert.equal(archived,false);
  assert.throws(()=>reconcileHostHistory([],prefix,[record('s0-1','user','Uno'),record('s0-1','user','Uno')],2,()=>{archived=true;}),/identidad/iu);
  assert.equal(archived,false);
  const repeated=reconcileHostHistory([],prefix,[record('s0-1','user','Sí'),record('s0-2','user','Sí')]);
  assert.deepEqual(repeated.map(item=>item.id),[prefix+'s0-1',prefix+'s0-2']);
});

test('a rejected snapshot never exposes or replaces a private transport alias',()=>{
  const original=[{id:prefix+'s0-1',role:'user',text:'Solicitud',transportText:'CONTEXTO PRIVADO',engine:'gentle',state:'complete',at:1}];
  const copy=structuredClone(original);let queued;
  assert.throws(()=>reconcileHostHistory(original,prefix,[record('s0-1','assistant','CONTEXTO PRIVADO')],2,items=>{queued=items;}),/identidad/iu);
  assert.deepEqual(original,copy);assert.equal(queued,undefined);
});

test('live updates cannot change an existing message role or engine',()=>{
  const original=[{id:'same',role:'user',text:'Conservar',engine:'gentle',state:'complete',at:1}];
  assert.equal(updateEntry(original,{...original[0],role:'assistant',text:'Cambio'}),original);
  assert.equal(updateEntry(original,{...original[0],engine:'iphone',text:'Cambio'}),original);
});
