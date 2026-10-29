import { parseClientMessage, type ServerPayload } from '@gentle-dot/protocol';
import { expect, it, vi } from 'vitest';
import { DotBridge, type BridgeClient } from '../src/bridge.ts';
import { fakeSupervisor, waitFor } from './helpers.ts';

it('reports successful engine acceptance only to the requesting client, without identifying an echo', async () => {
  const { supervisor, dataDir } = fakeSupervisor();
  let accept!: (value: any) => void;
  const result = new Promise(resolve => { accept = resolve; });
  const request = vi.spyOn(supervisor, 'request').mockImplementation(() => result as any);
  const bridge = new DotBridge(supervisor, { dataDir });
  const sent: ServerPayload[] = [], other: ServerPayload[] = [];
  const client: BridgeClient = { send: value => sent.push(value) };
  bridge.attach(client); bridge.attach({ send: value => other.push(value) });
  expect(sent.find(value => value.type === 'ready')).toMatchObject({ features: { sendAccepted: 1 } });
  const message = parseClientMessage(JSON.stringify({ type: 'send', text: 'la misma instrucción', requestId: 'one', receipt: 'accepted-v1' }));
  if (!message) throw new Error('invalid fixture');
  const pending = bridge.handle(client, message);
  await waitFor(() => request.mock.calls.length > 0);
  expect(sent.some(value => value.type === 'request_accepted')).toBe(false);
  accept({ type: 'response', command: 'prompt', success: true });
  await pending;
  expect(sent.filter(value => value.type === 'request_accepted')).toEqual([{ type: 'request_accepted', requestId: 'one' }]);
  expect(other.some(value => value.type === 'request_accepted')).toBe(false);
  await bridge.handle(client, message);
  expect(request).toHaveBeenCalledTimes(1);
  expect(sent.filter(value => value.type === 'request_accepted')).toHaveLength(1);
});

it('does not deliver a late acceptance to a disconnected client', async () => {
  const { supervisor, dataDir } = fakeSupervisor();
  let accept!: (value: any) => void;
  const result = new Promise(resolve => { accept = resolve; });
  const request = vi.spyOn(supervisor, 'request').mockImplementation(() => result as any);
  const bridge = new DotBridge(supervisor, { dataDir });
  const sent: ServerPayload[] = []; const client: BridgeClient = { send: value => sent.push(value) };
  const detach = bridge.attach(client);
  const pending = bridge.handle(client, { type: 'send', text: 'x', requestId: 'detached', receipt: 'accepted-v1' });
  await waitFor(() => request.mock.calls.length > 0);
  detach(); accept({ type: 'response', command: 'prompt', success: true }); await pending;
  expect(sent.some(value => value.type === 'request_accepted')).toBe(false);
});

it('does not send acceptance for errors, rejected input, legacy requests or malformed opt-in', async () => {
  const { supervisor, dataDir } = fakeSupervisor();
  const request = vi.spyOn(supervisor, 'request').mockRejectedValueOnce(new Error('private engine failure')).mockResolvedValue({ type: 'response', command: 'prompt', success: true } as any);
  const bridge = new DotBridge(supervisor, { dataDir });
  const sent: ServerPayload[] = []; const client: BridgeClient = { send: value => sent.push(value) }; bridge.attach(client);
  await bridge.handle(client, { type: 'send', text: 'fallo', requestId: 'failed', receipt: 'accepted-v1' });
  await bridge.handle(client, { type: 'send', text: 'legacy', requestId: 'legacy' });
  expect(request).toHaveBeenCalledTimes(2);
  expect(sent.some(value => value.type === 'request_accepted')).toBe(false);
  for (const value of [{ receipt: 'accepted-v1' }, { requestId: '', receipt: 'accepted-v1' }, { requestId: 'x'.repeat(201), receipt: 'accepted-v1' }, { requestId: 'x', receipt: 'other' }]) {
    expect(parseClientMessage(JSON.stringify({ type: 'send', text: 'x', ...value }))).toBeUndefined();
  }
});
