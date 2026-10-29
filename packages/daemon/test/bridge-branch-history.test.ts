import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { ServerPayload } from '@gentle-dot/protocol';
import { expect, it, vi } from 'vitest';
import { DotBridge } from '../src/bridge.ts';
import { fakeSupervisor, tempDir } from './helpers.ts';

function setup() {
  const dataDir = tempDir(), sessionDir = join(dataDir, 'sessions'); mkdirSync(sessionDir);
  const manager = SessionManager.create(dataDir, sessionDir);
  const root = manager.appendMessage({ role: 'user', content: 'Root', timestamp: 1 });
  const abandoned = manager.appendMessage({ role: 'user', content: 'Abandoned', timestamp: 2 });
  manager.branch(root); const current = manager.appendMessage({ role: 'user', content: 'Current', timestamp: 3 });
  const { supervisor } = fakeSupervisor({ dataDir }); supervisor.state = 'ready'; supervisor.sessionFile = manager.getSessionFile(); supervisor.sessionId = manager.getSessionId();
  let leaves: (string | null)[] = [], calls = 0;
  vi.spyOn(supervisor, 'request').mockImplementation(async command => {
    if (command.type === 'get_state') return { type: 'response', command: 'get_state', success: true };
    if (command.type === 'get_entries') {
      calls++; const entries = manager.getEntries(); const index = entries.findIndex(entry => entry.id === command.since);
      if (index < 0) throw Error('unknown cursor');
      return { type: 'response', command: 'get_entries', success: true, data: { entries: entries.slice(index + 1), leafId: leaves.length ? leaves.shift() : manager.getLeafId() } };
    }
    throw Error('unexpected command');
  });
  const bridge = new DotBridge(supervisor, { dataDir, historyPage: 1 }); const received: ServerPayload[] = [];
  const client = { send: (message: ServerPayload) => received.push(message) }; bridge.attach(client);
  return { manager, supervisor, root, abandoned, current, bridge, client, received, setLeaves: (values: (string | null)[]) => { leaves = values; }, calls: () => calls };
}

it('serves only the live Pi branch, with source-bound IDs and branch-aware pagination', async () => {
  const f = setup(); await f.bridge.handle(f.client, { type: 'get_history' });
  const history = f.received.findLast(message => message.type === 'history'); if (history?.type !== 'history') throw Error('history');
  expect(history.messages.map(message => message.text)).toEqual(['Current']); expect(history.hasEarlier).toBe(true);
  expect(history.branchVerified).toBe(true);
  await f.bridge.handle(f.client, { type: 'get_earlier', before: history.messages[0]!.id });
  const earlier = f.received.findLast(message => message.type === 'earlier'); if (earlier?.type !== 'earlier') throw Error('earlier');
  expect(earlier.messages.map(message => message.text)).toEqual(['Root']); expect(earlier.hasEarlier).toBe(false);
  expect(f.calls()).toBe(4);
});

it('correlates pages and errors to the requested conversation while preserving legacy responses', async () => {
  const f = setup();
  expect(f.received[0]).toMatchObject({ type: 'ready', features: { historyPaging: 1 } });
  const conversationId = (f.received[0] as Extract<ServerPayload, { type: 'ready' }>).conversationId!;
  await f.bridge.handle(f.client, { type: 'get_history' });
  const history = f.received.findLast(message => message.type === 'history'); if (history?.type !== 'history') throw Error('history');
  const before = history.messages[0]!.id;
  await f.bridge.handle(f.client, { type: 'get_earlier', before, requestId: 'page-1', conversationId });
  expect(f.received.at(-1)).toMatchObject({ type: 'earlier', before, requestId: 'page-1', conversationId, messages: [{ text: 'Root' }] });
  await f.bridge.handle(f.client, { type: 'get_earlier', before, requestId: 'page-2', conversationId: 'other.jsonl' });
  expect(f.received.at(-1)).toMatchObject({ type: 'error', code: 'history_unavailable', requestId: 'page-2', conversationId: 'other.jsonl' });
  await f.bridge.handle(f.client, { type: 'get_earlier', before: 'stale-cursor', requestId: 'stale', conversationId });
  expect(f.received.at(-1)).toMatchObject({ type: 'error', code: 'history_unavailable', requestId: 'stale', conversationId });
  await f.bridge.handle(f.client, { type: 'get_earlier', before, requestId: 'page-3', conversationId });
  expect(f.received.at(-1)).toMatchObject({ type: 'earlier', requestId: 'page-3', conversationId });
  await f.bridge.handle(f.client, { type: 'get_earlier', before });
  expect(f.received.at(-1)).toMatchObject({ type: 'earlier', before });
  expect(f.received.at(-1)).not.toHaveProperty('requestId'); expect(f.received.at(-1)).not.toHaveProperty('conversationId');
});

it('rejects an older page if the session changes while its read is in flight', async () => {
  const f = setup(); const internal = f.bridge as any;
  const conversationId = (f.received[0] as Extract<ServerPayload, { type: 'ready' }>).conversationId!;
  let release!: () => void; let started!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  vi.spyOn(internal, 'currentHistory').mockImplementation(async () => { started(); await wait; return { messages: [], hasEarlier: false }; });
  const pending = f.bridge.handle(f.client, { type: 'get_earlier', before: 's0-0', requestId: 'in-flight', conversationId });
  await reading; f.supervisor.sessionFile = join(tempDir(), 'different.jsonl'); release(); await pending;
  expect(f.received.at(-1)).toMatchObject({ type: 'error', code: 'history_unavailable', requestId: 'in-flight', conversationId });
  expect(f.received.some(message => message.type === 'earlier')).toBe(false);
});

it('retries when the live leaf changes without an append and refuses an old branch cursor', async () => {
  const f = setup(); f.setLeaves([f.current, f.root, f.root, f.root]);
  await f.bridge.handle(f.client, { type: 'get_history' });
  const history = f.received.findLast(message => message.type === 'history'); if (history?.type !== 'history') throw Error('history');
  expect(history.messages.map(message => message.text)).toEqual(['Root']); expect(f.calls()).toBe(4);
  f.manager.branch(f.abandoned);
  await f.bridge.handle(f.client, { type: 'get_earlier', before: 's0-2' });
  expect(f.received.at(-1)).toMatchObject({ type: 'error', code: 'history_unavailable' });
});

it('keeps previous history on malformed Pi leaf responses', async () => {
  const f = setup(); vi.spyOn(f.manager, 'getLeafId').mockReturnValue('unknown-entry');
  await f.bridge.handle(f.client, { type: 'get_history' });
  expect(f.received.at(-1)).toMatchObject({ type: 'error', code: 'history_unavailable' });
  expect(f.received.some(message => message.type === 'history')).toBe(false);
});
it('a verified empty leaf returns no active messages, without inventing a branch', async () => {
  const f = setup(); f.setLeaves([null, null]);
  await f.bridge.handle(f.client, { type: 'get_history' });
  const history = f.received.findLast(message => message.type === 'history'); if (history?.type !== 'history') throw Error('history');
  expect(history.messages).toEqual([]); expect(history.hasEarlier).toBe(false);
});
it('an unsupported or interrupted leaf RPC reports failure without returning a partial history', async () => {
  const f = setup(); vi.mocked(f.supervisor.request).mockImplementation(async command => {
    if (command.type === 'get_state') return { type: 'response', command: 'get_state', success: true };
    throw new Error('unsupported or disconnected');
  });
  await f.bridge.handle(f.client, { type: 'get_history' });
  expect(f.received.at(-1)).toMatchObject({ type: 'error', code: 'history_unavailable' });
  expect(f.received.some(message => message.type === 'history')).toBe(false);
});
it('does not return an incomplete chain when a prior session file is missing', async () => {
  const f = setup(); f.supervisor.linkSessions(f.supervisor.sessionFile!, [join(tempDir(), 'missing.jsonl')]);
  await f.bridge.handle(f.client, { type: 'get_history' });
  expect(f.received.at(-1)).toMatchObject({ type: 'error', code: 'history_unavailable' });
  expect(f.received.some(message => message.type === 'history')).toBe(false);
});
it('a failed history read after rotation notifies clients without sending a partial snapshot or leaving an unhandled rejection', async () => {
  const f = setup(); const internal = f.bridge as any; const unhandled: unknown[] = [];
  const listener = (error: unknown) => unhandled.push(error); process.on('unhandledRejection', listener);
  try {
    vi.spyOn(internal.rotator, 'maybeRotate').mockResolvedValue(true);
    vi.spyOn(internal, 'currentHistory').mockRejectedValue(new Error('private details'));
    internal.rotateWhenIdle();
    await vi.waitFor(() => expect(f.received.at(-1)).toMatchObject({ type: 'error', code: 'history_unavailable' }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]); expect(f.received.some(message => message.type === 'history')).toBe(false);
    expect(JSON.stringify(f.received)).not.toContain('private details');
  } finally { process.off('unhandledRejection', listener); }
});
