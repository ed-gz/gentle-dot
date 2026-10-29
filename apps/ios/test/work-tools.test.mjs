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

const savedResult = () => ({ schema: 1, manifestHash: 'a'.repeat(64), createdAt: 9, model: 'fixture', minutes: { title: 'Minuta', summary: 'Acuerdo', items: [] }, evidence: [], transcriptComparison: 'Fuentes revisadas', requiresReview: true });
test('saved meeting draft remains available to the agent offline without claiming the current host state', async () => {
  const item = { id: 'work-1', title: 'Reunión', kind: 'meeting', instruction: 'Minuta', createdAt: 1, updatedAt: 9, revision: 3, status: 'local', files: [], versions: [], result: savedResult() };
  let dispatcherCalls = 0;
  const tools = createWorkTools({ inbox: { ...inbox, readWork: async () => structuredClone(item) }, getHost: () => undefined, getDispatcher: () => { dispatcherCalls++; return undefined; } });
  const result = await tools.find(tool => tool.definition.name === 'work_result').execute({ id: item.id }, context());
  assert.equal(dispatcherCalls, 0); assert.equal(result.processing, undefined);
  assert.equal(JSON.parse(result.cachedDraft.content.text).summary, 'Acuerdo');
  assert.equal(result.cachedDraft.requiresReview, true); assert.equal(result.cachedDraft.savedLocally, true);
  assert.equal(result.cachedDraft.hostStatus, 'not_verified'); assert.equal(result.cachedDraft.minuteApprovedLocally, false);
  assert.equal(result.cachedDraft.untrustedContent, true);
});
test('work_read directs minute access to paginated work_result without returning the full result', async () => {
  const item = { id: 'work-1', title: 'Reunión', kind: 'meeting', instruction: 'Minuta', createdAt: 1, updatedAt: 9, revision: 3, status: 'local', files: [], versions: [], result: savedResult() };
  const tool = createWorkTools({ inbox: { ...inbox, readWork: async () => item }, getHost: () => undefined, getDispatcher: () => undefined }).find(tool => tool.definition.name === 'work_read');
  const output = await tool.execute({ id: item.id }, context());
  assert.equal(output.hasResult, true); assert.equal(output.result, undefined); assert.match(tool.definition.description, /work_result/);
});
test('work_result retains the saved draft if a host query fails or is still running', async () => {
  const item = { id: 'work-1', title: 'Reunión', kind: 'meeting', instruction: 'Minuta', createdAt: 1, updatedAt: 9, revision: 3, status: 'sent', files: [], versions: [], result: savedResult() };
  for (const mode of ['error', 'running']) {
    const tools = createWorkTools({ inbox: { ...inbox, readWork: async () => structuredClone(item) }, getHost: () => 'wss://host/ws', getDispatcher: () => ({ result: async () => { if (mode === 'error') throw new Error('red sin confirmar'); return { status: 'running', message: 'Procesando' }; } }) });
    const result = await tools.find(tool => tool.definition.name === 'work_result').execute({ id: item.id }, context());
    assert.equal(JSON.parse(result.cachedDraft.content.text).summary, 'Acuerdo'); assert.equal(result.cachedDraft.hostStatus, 'not_verified');
    if (mode === 'running') assert.equal(result.processing.status, 'running'); else assert.equal(result.processing, undefined);
  }
});
test('work_result never fabricates a cached draft or masks cancellation', async () => {
  const item = { id: 'work-1', title: 'Reunión', kind: 'meeting', instruction: 'Minuta', createdAt: 1, updatedAt: 9, revision: 3, status: 'local', files: [], versions: [] };
  const tools = createWorkTools({ inbox: { ...inbox, readWork: async () => structuredClone(item) }, getHost: () => undefined, getDispatcher: () => undefined });
  const tool = tools.find(tool => tool.definition.name === 'work_result');
  await assert.rejects(tool.execute({ id: item.id }, context()), /Conecta el host/);
  item.result = { ...savedResult(), requiresReview: false };
  await assert.rejects(tool.execute({ id: item.id }, context()), /No pude verificar/);
  item.result = savedResult(); const controller = new AbortController(); controller.abort();
  await assert.rejects(tool.execute({ id: item.id }, { signal: controller.signal }), /abort/i);
});
test('saved minutes and evidence can be read in bounded Unicode-safe pages without network', async () => {
  const result = savedResult();
  result.minutes.summary = '🦊'.repeat(1800);
  result.evidence = [{ id: 'ev-1', fileId: 'file-1', source: 'imported-text', text: 'Prueba documental', startMs: 1200, endMs: 2400 }];
  const item = { id: 'work-1', title: 'Reunión', kind: 'meeting', instruction: 'Minuta', createdAt: 1, updatedAt: 9, revision: 3, status: 'local', files: [], versions: [], result };
  let calls = 0;
  const tools = createWorkTools({ inbox: { ...inbox, readWork: async () => structuredClone(item) }, getHost: () => { calls++; throw new Error('unexpected network'); }, getDispatcher: () => { calls++; throw new Error('unexpected network'); } });
  const tool = tools.find(tool => tool.definition.name === 'work_result');
  const first = (await tool.execute({ id: item.id, mode: 'local', maxChars: 1000 }, context())).cachedDraft;
  assert.equal(first.source, 'iphone'); assert.equal(first.hostStatus, 'not_verified'); assert.equal(first.provenance.status, 'not_verified');
  assert.equal(first.content.truncated, true); assert.equal(first.content.nextOffset, 1000);
  let combined = first.content.text, next = first.content.nextOffset;
  while (next !== undefined) {
    const page = (await tool.execute({ id: item.id, mode: 'local', maxChars: 1000, offset: next }, context())).cachedDraft.content;
    assert.equal(page.offset, next); combined += page.text; next = page.nextOffset;
  }
  assert.equal(JSON.parse(combined).summary, result.minutes.summary);
  const evidence = (await tool.execute({ id: item.id, mode: 'local', section: 'evidence' }, context())).cachedDraft;
  assert.deepEqual(JSON.parse(evidence.content.text), result.evidence); assert.equal(calls, 0);
  await assert.rejects(tool.execute({ id: item.id, mode: 'local', maxChars: 2001 }, context()), /rango válidos/);
});
test('cached fallback never converts an explicit host refresh into success', async () => {
  const item = { id: 'work-1', title: 'Reunión', kind: 'meeting', instruction: 'Minuta', createdAt: 1, updatedAt: 9, revision: 3, status: 'local', files: [], versions: [], result: savedResult() };
  const tools = createWorkTools({ inbox: { ...inbox, readWork: async () => structuredClone(item) }, getHost: () => undefined, getDispatcher: () => undefined });
  await assert.rejects(tools.find(tool => tool.definition.name === 'work_result').execute({ id: item.id, mode: 'host' }, context()), /Conecta el host/);
});
test('host ready returns the saved result as a bounded draft with verified receipt provenance', async () => {
  const result = savedResult(); const receipt = { workId: 'work-1', transferId: 'transfer-1', manifestHash: result.manifestHash, revision: 2, committedAt: 9 };
  const item = { id: 'work-1', title: 'Reunión', kind: 'meeting', instruction: 'Minuta', createdAt: 1, updatedAt: 9, revision: 3, status: 'sent', files: [], versions: [], result, transfer: { transferId: 'transfer-1', manifestHash: result.manifestHash, manifest: { workId: 'work-1', revision: 2 }, receipt } };
  const tools = createWorkTools({ inbox: { ...inbox, readWork: async () => structuredClone(item) }, getHost: () => 'wss://host/ws', getDispatcher: () => ({ result: async () => ({ status: 'ready', result }) }) });
  const output = await tools.find(tool => tool.definition.name === 'work_result').execute({ id: item.id, mode: 'host' }, context());
  assert.equal(output.processing.status, 'ready'); assert.equal(output.processing.result, undefined);
  assert.equal(output.draft.hostStatus, 'responded'); assert.deepEqual(output.draft.provenance.receipt, receipt);
  assert.equal(output.draft.requiresReview, true); assert.equal(output.draft.minuteApprovedLocally, false);
  item.transfer.manifest = undefined;
  const local = await tools.find(tool => tool.definition.name === 'work_result').execute({ id: item.id, mode: 'local' }, context());
  assert.equal(local.cachedDraft.provenance.status, 'not_verified');
});
test('result approval only applies to the exact saved result, not an approved correction', async () => {
  const result = savedResult();
  const item = { id: 'work-1', title: 'Reunión', kind: 'meeting', instruction: 'Minuta', createdAt: 1, updatedAt: 9, revision: 3, status: 'local', files: [], versions: [{ id: 'correction', text: 'Corrección revisada', createdAt: 8 }], result,
    minuteApproval: { kind: 'version', revision: 3, versionId: 'correction', snapshot: 'Corrección revisada', approvedAt: 9 } };
  assert.equal(inbox.validMinuteApproval(item), true);
  const tools = createWorkTools({ inbox: { ...inbox, readWork: async () => structuredClone(item) }, getHost: () => undefined, getDispatcher: () => undefined });
  const page = (await tools.find(tool => tool.definition.name === 'work_result').execute({ id: item.id, mode: 'local' }, context())).cachedDraft;
  assert.equal(page.minuteApprovedLocally, false); assert.equal(page.requiresReview, true);
});
test('a host result changed before its local reread never borrows the newer approval', async () => {
  const first = savedResult(), next = { ...savedResult(), createdAt: 10, minutes: { ...first.minutes, summary: 'Otro borrador' } };
  const old = { id: 'work-1', title: 'Reunión', kind: 'meeting', instruction: 'Minuta', createdAt: 1, updatedAt: 9, revision: 3, status: 'sent', files: [], versions: [], result: first };
  const newer = { ...old, revision: 4, result: next };
  let reads = 0;
  const tools = createWorkTools({ inbox: { ...inbox, readWork: async () => structuredClone(++reads === 1 ? old : newer) }, getHost: () => 'wss://host/ws', getDispatcher: () => ({ result: async () => ({ status: 'ready', result: first }) }) });
  const output = await tools.find(tool => tool.definition.name === 'work_result').execute({ id: old.id }, context());
  assert.equal(output.draft, undefined); assert.equal(output.cachedDraft.source, 'iphone'); assert.equal(output.cachedDraft.hostStatus, 'not_verified');
  assert.equal(output.cachedDraft.minuteApprovedLocally, false);
});
test('all offsets of a maximally escaped admissible draft remain readable', async () => {
  const result = savedResult(), marker = '\u0001'; const ids = Array.from({ length: 5 }, (_, i) => String(i) + 'x'.repeat(127));
  result.evidence = ids.map(id => ({ id, fileId: 'file-1', source: 'imported-text', text: marker.repeat(20000) }));
  result.minutes = { title: 'M', summary: marker.repeat(12000), items: Array.from({ length: 100 }, () => ({ kind: 'task', certainty: 'confirmed', text: marker.repeat(700), owner: marker.repeat(200), due: marker.repeat(200), evidenceIds: Array(20).fill(ids[0]) })) };
  assert.ok(Array.from(JSON.stringify(result.minutes)).length > 1_000_000);
  const item = { id: 'work-1', title: 'Reunión', kind: 'meeting', instruction: 'Minuta', createdAt: 1, updatedAt: 9, revision: 3, status: 'local', files: [], versions: [], result };
  const tool = createWorkTools({ inbox: { ...inbox, readWork: async () => item }, getHost: () => undefined, getDispatcher: () => undefined }).find(tool => tool.definition.name === 'work_result');
  const page = (await tool.execute({ id: item.id, mode: 'local', offset: 1_000_000, maxChars: 2000 }, context())).cachedDraft;
  assert.equal(page.content.offset, 1_000_000); assert.ok(page.content.text.length); assert.ok(page.content.totalChars > 1_000_000);
  if (page.content.nextOffset !== undefined) assert.ok((await tool.execute({ id: item.id, mode: 'local', offset: page.content.nextOffset }, context())).cachedDraft);
});
