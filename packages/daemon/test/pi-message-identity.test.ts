import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';
import { persistedPiMessageIdentity } from '../src/extensions/pi-message-identity.ts';
import { tempDir } from './helpers.ts';

it('uses Pi entry identity for equal text, and only after the entry exists', () => {
  const manager=SessionManager.inMemory('/tmp'); const session=manager.getSessionId();
  const first={role:'user' as const,content:'Repetir',timestamp:1};
  const second={role:'user' as const,content:'Repetir',timestamp:2};
  expect(persistedPiMessageIdentity(manager,session,first)).toBeUndefined();
  const firstId=manager.appendMessage(first); const secondId=manager.appendMessage(second);
  expect(persistedPiMessageIdentity(manager,session,first)).toEqual({sessionId:session,entryId:firstId});
  expect(persistedPiMessageIdentity(manager,session,second)).toEqual({sessionId:session,entryId:secondId});
  expect(firstId).not.toBe(secondId);
  expect(persistedPiMessageIdentity(manager,session,{...first})).toBeUndefined();
  expect(persistedPiMessageIdentity(manager,'another-session',first)).toBeUndefined();
});

it('does not assert an identity for an ambiguous, malformed or missing branch record', () => {
  const message={role:'assistant',content:'Igual'};
  const manager=(branch: unknown[])=>({getSessionId:()=> 'session',getBranch:()=>branch});
  expect(persistedPiMessageIdentity(manager([{type:'message',id:'a',message},{type:'message',id:'b',message}]),'session',message)).toBeUndefined();
  expect(persistedPiMessageIdentity(manager([{type:'message',id:'a',message},{type:'message',id:'a',message:{role:'user'}}]),'session',message)).toBeUndefined();
  expect(persistedPiMessageIdentity(manager([{type:'message',id:'',message}]),'session',message)).toBeUndefined();
  expect(persistedPiMessageIdentity(manager([{type:'custom',id:'a',message}]),'session',message)).toBeUndefined();
});

it('keeps Pi session and entry identifiers across disk reload without matching the old object by text', () => {
  const dir=tempDir(); const manager=SessionManager.create(dir,dir);
  const message={role:'user' as const,content:'Repetir',timestamp:1};
  const entryId=manager.appendMessage(message); const sessionId=manager.getSessionId();
  const path=manager.getSessionFile(); if(!path) throw new Error('No session file');
  const reopened=SessionManager.open(path);
  expect(reopened.getSessionId()).toBe(sessionId);
  expect(persistedPiMessageIdentity(reopened,sessionId,message)).toBeUndefined();
  const entry=reopened.getBranch().find(item=>item.type==='message' && item.id===entryId);
  if(!entry||entry.type!=='message') throw new Error('Missing persisted entry');
  expect(persistedPiMessageIdentity(reopened,sessionId,entry.message)).toEqual({sessionId,entryId});
});
