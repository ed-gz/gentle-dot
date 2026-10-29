import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { ServerPayload } from '@gentle-dot/protocol';
import { expect, it } from 'vitest';
import { AgentSupervisor } from '../src/supervisor.ts';
import { DotBridge } from '../src/bridge.ts';
import { lastIndexedPiEntry } from '../src/branch-history.ts';
import { tempDir } from './helpers.ts';

it.each([false, true])('queries the actual offline Pi RPC leaf in continuous mode (branched=%s)', async branched => {
  const dataDir = tempDir(), sessions = join(dataDir, 'sessions'), agentHome = join(dataDir, 'agent'); mkdirSync(sessions); mkdirSync(agentHome);
  const manager = SessionManager.create(dataDir, sessions);
  const root = manager.appendMessage({ role: 'user', content: 'Synthetic root', timestamp: 1 });
  manager.appendMessage({ role: 'user', content: 'Synthetic abandoned', timestamp: 2 }); if (branched) manager.branch(root);
  manager.appendMessage({ role: 'user', content: 'Synthetic current', timestamp: 3 });
  const file = manager.getSessionFile()!;
  const executable = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
  const supervisor = new AgentSupervisor({ command: process.execPath, args: [executable], cwd: dataDir, dataDir,
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8', PI_CODING_AGENT_DIR: agentHome, PI_OFFLINE: '1' },
    extraArgs: ['--session', file, '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-tools'] });
  try {
    await supervisor.start();
    const latest = lastIndexedPiEntry(file).id!;
    const proof = await supervisor.request({ type: 'get_entries', since: latest });
    expect(proof.data).toMatchObject({ entries: [], leafId: latest });
    const bridge = new DotBridge(supervisor, { dataDir, historyPage: 1 }); const received: ServerPayload[] = [];
    const client = { send: (message: ServerPayload) => received.push(message) }; bridge.attach(client);
    const ready = received.find(message => message.type === 'ready'); if (ready?.type !== 'ready') throw Error('ready');
    expect(ready.features).toMatchObject({ conversations: false, historyPaging: 1 });
    expect(ready.conversationId).toBeTruthy(); expect(ready.conversationId).not.toBe('default');
    await bridge.handle(client, { type: 'get_history' });
    const history = received.findLast(message => message.type === 'history'); if (history?.type !== 'history') throw Error('history');
    expect(history.branchVerified).toBe(true);
    expect(history.conversationId).toBe(ready.conversationId);
    expect(history.messages.map(message => message.text)).toEqual(['Synthetic current']);
    await bridge.handle(client, { type: 'get_earlier', before: history.messages[0]!.id, requestId: 'page-1', conversationId: history.conversationId });
    expect(received.at(-1)).toMatchObject({ type: 'earlier', requestId: 'page-1', conversationId: history.conversationId, branchVerified: true,
      messages: [{ text: branched ? 'Synthetic root' : 'Synthetic abandoned' }] });
  } finally { await supervisor.stop(); }
}, 60_000);
