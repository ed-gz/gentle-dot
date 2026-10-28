import type { ServerPayload, WorkSyncRequest } from '@gentle-dot/protocol';
import { afterEach, expect, it } from 'vitest';
import { DotBridge, type BridgeClient } from '../src/bridge.ts';
import type { AgentSupervisor } from '../src/supervisor.ts';
import { fakeSupervisor } from './helpers.ts';
const supervisors: AgentSupervisor[] = [];
afterEach(async () => { await Promise.all(supervisors.splice(0).map(supervisor => supervisor.stop())); });
function setup(workSync?: BridgeClient['workSync']) {
  const { supervisor, dataDir } = fakeSupervisor(); supervisors.push(supervisor);
  // Static feature claims alone must never advertise an absent transport handler.
  const bridge = new DotBridge(supervisor, { dataDir, features: { conversations: false, workSync: 1, meetingDrafts: 1 } });
  const messages: ServerPayload[] = []; const client: BridgeClient = { send: payload => messages.push(payload), ...(workSync ? { workSync } : {}) };
  bridge.attach(client); return { bridge, client, messages };
}
const request: WorkSyncRequest = { type: 'work_sync', requestId: 'request-1', transferId: 'transfer-1', operation: 'status' };
it('advertises no durable work capability without the configured handler and returns a correlated refusal', async () => {
  const h = setup(); expect(h.messages.find(message => message.type === 'ready')).toMatchObject({ features: { conversations: false, historyRefresh: true } });
  const ready = h.messages.find(message => message.type === 'ready'); if (ready?.type !== 'ready') throw new Error('No ready');
  expect(ready.features).not.toHaveProperty('workSync'); expect(ready.features).not.toHaveProperty('meetingDrafts');
  await h.bridge.handle(h.client, request);
  expect(h.messages.at(-1)).toMatchObject({ type: 'work_sync_reply', requestId: request.requestId, transferId: request.transferId, state: 'error', code: 'storage' });
});
it('storage and meeting capabilities correspond to the installed handler and processor', async () => {
  for (const meetingDrafts of [false, true]) {
    const calls: WorkSyncRequest[] = [];
    const h = setup({ meetingDrafts, handle: async message => { calls.push(message); return { type: 'work_sync_reply', requestId: message.requestId, transferId: message.transferId, state: 'missing' }; } });
    const ready = h.messages.find(message => message.type === 'ready'); if (ready?.type !== 'ready') throw new Error('No ready');
    expect(ready.features?.workSync).toBe(1); expect(ready.features?.meetingDrafts).toBe(meetingDrafts ? 1 : undefined);
    await h.bridge.handle(h.client, request); expect(calls).toEqual([request]); expect(h.messages.at(-1)).toMatchObject({ state: 'missing', requestId: 'request-1', transferId: 'transfer-1' });
    await h.bridge.handle(h.client, { ...request, operation: 'process', approvedManifestHash: 'a'.repeat(64) }); expect(calls).toHaveLength(meetingDrafts ? 2 : 1);
  }
});
it('handler failure is a correlated storage failure without leaking exception text', async () => {
  const h = setup({ meetingDrafts: true, handle: async () => { throw new Error('private host details'); } });
  await h.bridge.handle(h.client, request);
  expect(h.messages.at(-1)).toMatchObject({ state: 'error', code: 'storage', requestId: 'request-1' }); expect(JSON.stringify(h.messages)).not.toContain('private host details');
});
