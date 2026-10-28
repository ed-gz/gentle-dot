import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { canonicalWorkManifest, type ServerMessage, type WorkSyncManifest } from '@gentle-dot/protocol';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { startDaemon } from '../src/daemon.ts';
import { fakeAuthRuntime } from './fake-auth-runtime.ts';
import { FAKE_AGENT, tempDir, waitFor } from './helpers.ts';
it('routes durable work through authenticated WebSocket independently from Pi prompts', async () => {
  const dir = tempDir();
  const daemon = await startDaemon({ port: 0, host: '127.0.0.1', dataDir: dir, workspace: join(dir, 'workspace'), uiDir: dir, agentCommand: process.execPath, agentArgs: [FAKE_AGENT], authRuntime: async () => fakeAuthRuntime().runtime });
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`); const messages: ServerMessage[] = [];
  socket.on('message', raw => messages.push(JSON.parse(String(raw))));
  try {
    await new Promise<void>((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject); });
    socket.send(JSON.stringify({ type: 'hello', protocol: 1, token: daemon.token }));
    await waitFor(() => messages.some(m => m.type === 'ready'));
    const transferId = randomUUID(); const content: WorkSyncManifest = { schema: 1, workId: 'work-a', revision: 3, title: 'Offline task', kind: 'task', instruction: 'Save only', files: [] };
    const manifestHash = createHash('sha256').update(canonicalWorkManifest(content)).digest('hex');
    for (const operation of [{ operation: 'begin', manifest: content, manifestHash }, { operation: 'commit' }]) {
      const requestId = randomUUID(); socket.send(JSON.stringify({ type: 'work_sync', requestId, transferId, ...operation }));
      const reply = await waitFor(() => messages.find(m => m.type === 'work_sync_reply' && m.requestId === requestId));
      expect(reply).toMatchObject({ type: 'work_sync_reply', transferId, state: operation.operation === 'begin' ? 'uploading' : 'committed' });
    }
    expect(messages.some(m => m.type === 'user_message')).toBe(false);
    expect(messages.filter(m => m.type === 'work_sync_reply').map(m => m.seq)).toEqual([...messages.filter(m => m.type === 'work_sync_reply').map(m => m.seq)].sort((a,b) => a-b));
  } finally { socket.terminate(); await daemon.close(); }
});
