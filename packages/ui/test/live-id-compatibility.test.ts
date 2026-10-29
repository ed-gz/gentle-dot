import { expect, it } from 'vitest';
import { initialState, reduce } from '../src/store.ts';
import type { ServerMessage } from '@gentle-dot/protocol';

it('keeps namespaced live IDs associated through streaming and completion', () => {
  const user='u123e4567-e89b-42d3-a456-426614174000:1';
  const assistant='m123e4567-e89b-42d3-a456-426614174000:2';
  const events: ServerMessage[] = [
    {type:'user_message',seq:1,messageId:user,text:'Hola'},
    {type:'message_delta',seq:2,messageId:assistant,delta:'Res'},
    {type:'activity',seq:3,messageId:assistant,activity:{id:'a',title:'Revisar',kind:'read',status:'done'}},
    {type:'message_done',seq:4,messageId:assistant,text:'Respuesta'},
  ];
  const state=events.reduce((current,message)=>reduce(current,{type:'server',message}),initialState);
  expect(state.messages).toHaveLength(2);
  expect(state.messages[0]).toMatchObject({id:user,text:'Hola'});
  expect(state.messages[1]).toMatchObject({id:assistant,text:'Respuesta',streaming:false,activities:[{id:'a',status:'done'}]});
});
