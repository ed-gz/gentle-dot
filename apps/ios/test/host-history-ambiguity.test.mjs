import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reconcileHostHistory} from '../src/conversation.ts';

test('a late host snapshot with identical text must not replace an unlinked later live turn', () => {
  const prefix='host:wss://example.invalid/ws|c1|';
  const visible=[{id:prefix+'u-live',role:'user',text:'Sí',engine:'gentle',state:'complete',at:2000}];
  const history=[{id:'s0-1',role:'user',text:'Sí',activities:[]}];
  const result=reconcileHostHistory(visible,prefix,history,3000);
  assert.deepEqual(new Set(result.map(entry=>entry.id)),new Set([prefix+'u-live',prefix+'s0-1']));
  assert.equal(result.find(entry=>entry.id===prefix+'u-live')?.at,2000);
});
