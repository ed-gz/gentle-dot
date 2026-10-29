import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as inbox from '../src/work-inbox.ts';
import { createWorkTools } from '../src/work-tools.ts';
import { createWorkDispatcher } from '../src/work-sync.ts';

function fixture() {
  let item = { id: 'work-1', title: 'Meeting', kind: 'meeting', instruction: 'Prepare a draft', createdAt: 1, updatedAt: 1, revision: 1, status: 'local', files: [], versions: [] };
  let host = 'wss://host/ws'; const transitions = []; const sends = []; const processes = [];
  const store = { ...inbox, readWork: async () => structuredClone(item), listWork: async () => [structuredClone(item)], transitionWork: async (id, revision, status) => { inbox.assertWorkRevision(item, revision); item = inbox.transitionWorkItem(item, status); transitions.push(status); return structuredClone(item); } };
  const tools = createWorkTools({ inbox: store, getHost: () => host, prepareTransfer: async approved => ({ host, transferId: 'transfer-1', manifestHash: 'a'.repeat(64), manifest: { schema: 1, workId: approved.id, revision: approved.revision, title: approved.title, kind: approved.kind, instruction: approved.instruction, files: [] } }), getDispatcher: () => ({ checkTransferLimits() {}, send: async (...args) => { sends.push(args); item = { ...item, status: 'sent', revision: item.revision + 2, transfer: { host, transferId: 'transfer-1', manifestHash: 'a'.repeat(64), manifest: { instruction: item.instruction }, receipt: { workId: item.id, revision: item.revision, manifestHash: 'a'.repeat(64) } } }; return structuredClone(item); }, process: async (...args) => { processes.push(args); return { status: 'running', message: 'Draft only' }; } }) });
  return { tools, sends, processes, transitions, changeHost: () => { host = 'wss://other/ws'; }, mutate: () => { item.revision++; item.instruction = 'Changed'; }, get: () => item };
}
const context = askApproval => ({ signal: new AbortController().signal, askApproval });
test('legacy host rejects large audio before hashing, approval or any network operation', async () => {
  const item = { id: 'w', title: 'Reunión', kind: 'meeting', instruction: '', createdAt: 1, updatedAt: 1, revision: 1, status: 'local', versions: [], files: [{ id: 'f', name: 'audio.m4a', type: 'audio/mp4', size: 26 * 1024 * 1024 }] };
  let approvals = 0, preparations = 0, calls = 0;
  const dispatcher = createWorkDispatcher(async () => { calls++; throw Error('unexpected network'); }, 'wss://host/ws');
  const tools = createWorkTools({ inbox: { ...inbox, readWork: async () => item }, getHost: () => 'wss://host/ws', getDispatcher: () => dispatcher, prepareTransfer: async () => { preparations++; throw Error('unexpected hash'); } });
  const tool = tools.find(tool => tool.definition.name === 'work_sync');
  await assert.rejects(tool.execute({ id: 'w', revision: 1 }, context(async () => { approvals++; return true; })), /Actualiza Gentle Dot/);
  assert.deepEqual({ approvals, preparations, calls }, { approvals: 0, preparations: 0, calls: 0 });
});
test('work_sync reviews the exact future approved revision and binds dispatch to its hash', async () => {
  const f = fixture(); const tool = f.tools.find(tool => tool.definition.name === 'work_sync'); let approval;
  const result = await tool.execute({ id: 'work-1', revision: 1 }, context(async request => { approval = JSON.parse(request.details); assert.deepEqual(f.transitions, []); return true; }));
  assert.equal(approval.manifest.revision, 3); assert.equal(approval.manifest.instruction, 'Prepare a draft');
  assert.deepEqual(f.transitions, ['prepared','approved']); assert.deepEqual(f.sends[0].slice(0,3), ['work-1', 3, 'a'.repeat(64)]); assert.ok(f.sends[0][3] instanceof AbortSignal); assert.equal(result.executed, false);
});
test('denied approval, changed host or concurrently edited content never sends', async () => {
  for (const change of ['deny','host','content']) {
    const f = fixture(); const tool = f.tools.find(tool => tool.definition.name === 'work_sync');
    await assert.rejects(tool.execute({ id: 'work-1', revision: 1 }, context(async () => { if (change === 'host') f.changeHost(); if (change === 'content') f.mutate(); return change !== 'deny'; })));
    assert.deepEqual(f.sends, []); assert.deepEqual(f.transitions, []);
  }
});
test('processing is a separate exact-content approval and its result remains a draft', async () => {
  const f = fixture(); await f.tools.find(tool => tool.definition.name === 'work_sync').execute({ id: 'work-1', revision: 1 }, context(async () => true));
  const tool = f.tools.find(tool => tool.definition.name === 'work_process'); let approval;
  const result = await tool.execute({ id: 'work-1', revision: f.get().revision }, context(async request => { approval = JSON.parse(request.details); return true; }));
  assert.equal(approval.operation, 'meeting-draft-only'); assert.equal(approval.requiresReview, true); assert.deepEqual(f.processes[0].slice(0,2), ['work-1', 'a'.repeat(64)]); assert.equal(result.processing.status, 'running');
});
