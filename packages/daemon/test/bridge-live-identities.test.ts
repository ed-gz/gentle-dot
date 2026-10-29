import type { ServerPayload } from '@gentle-dot/protocol';
import { expect, it, vi } from 'vitest';
import { DotBridge } from '../src/bridge.ts';
import type { SupervisorEvent } from '../src/supervisor.ts';
import { fakeSupervisor } from './helpers.ts';

function bridgeInstance() {
  const { supervisor, dataDir } = fakeSupervisor();
  let relay: (event: SupervisorEvent) => void = () => {};
  vi.spyOn(supervisor, 'onEvent').mockImplementation(listener => { relay=listener; return () => {}; });
  const bridge = new DotBridge(supervisor, {dataDir});
  const received: ServerPayload[]=[]; bridge.attach({send: event=>received.push(event)});
  return {received, emit:(event:SupervisorEvent)=>relay(event)};
}

it('live IDs do not collide between bridge instances and stay stable throughout a streamed response', () => {
  const first=bridgeInstance(), restarted=bridgeInstance();
  for(const bridge of [first,restarted]) {
    bridge.emit({type:'message_start', message:{role:'user', content:'Repetir'}});
    bridge.emit({type:'message_start', message:{role:'assistant', content:[]}});
    bridge.emit({type:'message_update', assistantMessageEvent:{type:'text_delta',delta:'Respuesta'}});
    bridge.emit({type:'message_end', message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Respuesta'}]}});
  }
  const firstUser=first.received.find(m=>m.type==='user_message');
  const laterUser=restarted.received.find(m=>m.type==='user_message');
  const firstDelta=first.received.find(m=>m.type==='message_delta');
  const firstDone=first.received.find(m=>m.type==='message_done');
  const laterDelta=restarted.received.find(m=>m.type==='message_delta');
  expect(firstUser?.type).toBe('user_message'); expect(laterUser?.type).toBe('user_message');
  if(firstUser?.type!=='user_message'||laterUser?.type!=='user_message'||firstDelta?.type!=='message_delta'||firstDone?.type!=='message_done'||laterDelta?.type!=='message_delta') throw new Error('Missing event');
  expect(firstUser.messageId).not.toBe(laterUser.messageId);
  expect(firstDelta.messageId).toBe(firstDone.messageId);
  expect(firstDelta.messageId).not.toBe(laterDelta.messageId);
  for (const id of [firstUser.messageId,laterUser.messageId,firstDelta.messageId,laterDelta.messageId]) expect(id.length).toBeLessThanOrEqual(512);
});

it('keeps a fallback stream ID through its final message when the start event is absent', () => {
  const bridge=bridgeInstance();
  bridge.emit({type:'message_update', assistantMessageEvent:{type:'text_delta',delta:'Parcial'}});
  const delta=bridge.received.find(m=>m.type==='message_delta');
  bridge.emit({type:'message_end', message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Completa'}]}});
  const done=bridge.received.find(m=>m.type==='message_done');
  if(delta?.type!=='message_delta'||done?.type!=='message_done') throw new Error('Missing stream event');
  expect(done.messageId).toBe(delta.messageId);
});
