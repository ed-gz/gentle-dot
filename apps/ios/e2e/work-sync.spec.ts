import { expect, test } from './fixtures.ts';

test('lost commit ACK stays uncertain, then recovers exact receipt after reload without retransmission', async ({ page }) => {
  await page.goto('/');
  const sent = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts'); const sync = await import('/src/work-sync.ts');
    let item = await inbox.createWork({ title: 'Meeting evidence', kind: 'meeting', instruction: 'Prepare a draft', files: [new File(['audio-original'], 'meeting.m4a', { type: 'audio/mp4' })] });
    item = await inbox.addWorkVersion(item.id, item.revision, 'First transcript');
    item = await inbox.transitionWork(item.id, item.revision, 'prepared'); item = await inbox.transitionWork(item.id, item.revision, 'approved');
    let manifest: any; let transferId = ''; let manifestHash = ''; let receipt: any; const offsets: Record<string, number> = {}; const bytes: Record<string, string> = {};
    const dispatcher = sync.createWorkDispatcher(async (request: any) => {
      transferId = request.transferId; const base = { type: 'work_sync_reply', requestId: request.requestId, transferId };
      if (request.operation === 'begin') { manifest = request.manifest; manifestHash = request.manifestHash; for (const file of manifest.files) offsets[file.id] = 0; }
      if (request.operation === 'chunk') { bytes[request.fileId] = (bytes[request.fileId] ?? '') + atob(request.data); offsets[request.fileId]! += atob(request.data).length; }
      if (request.operation === 'commit') { receipt = { transferId, workId: manifest.workId, revision: manifest.revision, manifestHash, committedAt: 123 }; throw new Error('Connection lost after host committed'); }
      return { ...base, state: 'uploading', manifestHash, offsets: { ...offsets } };
    }, 'wss://host/ws');
    const attempt = await Promise.allSettled([dispatcher.send(item.id, item.revision)]);
    return { receipt, id: item.id, status: (await inbox.readWork(item.id)).status, attempt: attempt[0].status, values: Object.values(bytes), revision: item.revision };
  });
  expect(sent).toMatchObject({ status: 'uncertain', attempt: 'rejected' }); expect(sent.values).toContain('audio-original'); expect(sent.values).toContain('First transcript');
  await page.reload();
  const recovered = await page.evaluate(async ({ receipt, id }) => {
    const sync = await import('/src/work-sync.ts'); const operations: string[] = [];
    const dispatcher = sync.createWorkDispatcher(async (request: any) => { operations.push(request.operation); return { type: 'work_sync_reply', requestId: request.requestId, transferId: request.transferId, state: 'committed', receipt }; }, 'wss://host/ws');
    const work = await dispatcher.recover(id); return { status: work.status, receipt: work.transfer.receipt, operations };
  }, sent);
  expect(recovered).toEqual({ status: 'sent', receipt: sent.receipt, operations: ['status'] });
});

test('share imports deduplicate atomically before native acknowledgement and detect changed bytes', async ({ page }) => {
  await page.goto('/');
  const imported = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts'); const sourceId = `share:${crypto.randomUUID()}`;
    const input = { title: 'Voice Memos', kind: 'meeting', instruction: '', files: [new File(['original-audio'], 'meeting.m4a', { type: 'audio/mp4' })] };
    const items = await Promise.all([inbox.createImportedWork(sourceId, input), inbox.createImportedWork(sourceId, input)]);
    const changed = await Promise.allSettled([inbox.createImportedWork(sourceId, { ...input, files: [new File(['changed--audio'], 'meeting.m4a', { type: 'audio/mp4' })] })]);
    const file = await inbox.readWorkFile(items[0].id, items[0].files[0].id);
    return { ids: items.map((item: any) => item.id), count: (await inbox.listWork()).length, text: await file.text(), changed: changed[0].status, sourceId };
  });
  expect(imported.ids[0]).toBe(imported.ids[1]); expect(imported).toMatchObject({ count: 1, text: 'original-audio', changed: 'rejected' });
  await page.reload();
  expect(await page.evaluate(async () => { const inbox = await import('/src/work-inbox.ts'); return (await inbox.listWork()).map((item: any) => item.source.id); })).toEqual([imported.sourceId]);
});

test('draft results persist offline; correction copies evidence and starts unapproved local work', async ({ page }) => {
  await page.goto('/');
  const saved = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts'); const sync = await import('/src/work-sync.ts');
    let item = await inbox.createWork({ title: 'Review', kind: 'meeting', instruction: 'Draft only', files: [new File(['Ana revisará logs.'], 'transcript.txt', { type: 'text/plain' })] });
    item = await inbox.transitionWork(item.id, item.revision, 'prepared'); item = await inbox.transitionWork(item.id, item.revision, 'approved');
    const transfer = await sync.prepareWorkTransfer(item, 'wss://host/ws'); item = await inbox.beginWorkTransfer(item.id, item.revision, transfer);
    const receipt = { transferId: transfer.transferId, workId: item.id, revision: transfer.manifest.revision, manifestHash: transfer.manifestHash, committedAt: 123 };
    item = await inbox.settleWorkTransfer(item.id, transfer.transferId, receipt);
    const result = { schema: 1, manifestHash: transfer.manifestHash, createdAt: 200, model: 'fixture', minutes: { title: 'Review', summary: 'Acuerdo de revisión', items: [{ kind: 'task', certainty: 'confirmed', text: 'Revisar logs', owner: 'Ana', due: null, evidenceIds: ['e1'] }] }, evidence: [{ id: 'e1', fileId: item.files[0].id, text: 'Ana revisará logs.', source: 'imported-text' }], transcriptComparison: 'Sólo texto.', requiresReview: true };
    item = await inbox.saveWorkResult(item.id, transfer.transferId, result);
    const correction = await inbox.createWorkFromResult(item.id, item.revision);
    const blob = await inbox.readWorkFile(correction.id, correction.files[0].id);
    return { id: item.id, correction: { status: correction.status, hasTransfer: Boolean(correction.transfer), text: await blob.text(), trace: correction.versions[0].text.includes(transfer.manifestHash) } };
  });
  expect(saved.correction).toEqual({ status: 'local', hasTransfer: false, text: 'Ana revisará logs.', trace: true });
  await page.reload();
  expect(await page.evaluate(async id => { const inbox = await import('/src/work-inbox.ts'); const work = await inbox.readWork(id); return work.result; }, saved.id)).toMatchObject({ requiresReview: true, minutes: { items: [{ owner: 'Ana', due: null }] } });
});

test('a draft cannot replace saved minutes with evidence unrelated to confirmed source files', async ({ page }) => {
  await page.goto('/');
  const checks = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts'); const sync = await import('/src/work-sync.ts');
    let item = await inbox.createWork({ title: 'Meeting', kind: 'meeting', instruction: 'Draft', files: [new File(['Ana revisará logs.'], 'transcript.txt', { type: 'text/plain' }), new File(['audio'], 'meeting.m4a', { type: 'audio/mp4' })] });
    item = await inbox.transitionWork(item.id, item.revision, 'prepared'); item = await inbox.transitionWork(item.id, item.revision, 'approved');
    const transfer = await sync.prepareWorkTransfer(item, 'wss://host/ws'); item = await inbox.beginWorkTransfer(item.id, item.revision, transfer);
    item = await inbox.settleWorkTransfer(item.id, transfer.transferId, { transferId: transfer.transferId, workId: item.id, revision: transfer.manifest.revision, manifestHash: transfer.manifestHash, committedAt: 123 });
    const result = { schema: 1, manifestHash: transfer.manifestHash, createdAt: 200, model: 'fixture', minutes: { title: 'Review', summary: 'First result', items: [{ kind: 'task', certainty: 'confirmed', text: 'Revisar logs', owner: 'Ana', due: null, evidenceIds: ['e1'] }] }, evidence: [{ id: 'e1', fileId: item.files[0].id, text: 'Ana revisará logs.', source: 'imported-text' }], transcriptComparison: 'Sólo texto.', requiresReview: true };
    item = await inbox.saveWorkResult(item.id, transfer.transferId, result);
    const cases = [
      { ...result.evidence[0], fileId: 'unrelated-file' },
      { ...result.evidence[0], fileId: item.files[1].id },
      { ...result.evidence[0], startMs: 1000, endMs: 999 },
      { ...result.evidence[0], startMs: 1000 },
      { ...result.evidence[0], endMs: 1000 },
      { ...result.evidence[0], source: 'desktop-transcriber', startMs: 0, endMs: 1000 },
    ];
    const outcomes = [];
    for (const evidence of cases) {
      try { await inbox.saveWorkResult(item.id, transfer.transferId, { ...result, minutes: { ...result.minutes, summary: 'Replacement' }, evidence: [evidence] }); outcomes.push('accepted'); }
      catch { outcomes.push('rejected'); }
    }
    const saved = await inbox.readWork(item.id);
    return { outcomes, summary: saved.result?.minutes.summary, revision: saved.revision, expectedRevision: item.revision };
  });
  expect(checks.outcomes).toEqual(Array(6).fill('rejected'));
  expect(checks.summary).toBe('First result');
  expect(checks.revision).toBe(checks.expectedRevision);
});

test('source validation accepts audio transcription and timed text from confirmed attachments', async ({ page }) => {
  await page.goto('/');
  const saved = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts'); const sync = await import('/src/work-sync.ts');
    let item = await inbox.createWork({ title: 'Meeting', kind: 'meeting', instruction: '', files: [new File(['audio'], 'meeting.m4a', { type: 'audio/mp4' }), new File(['captions'], 'meeting.srt', { type: 'application/x-subrip' })] });
    item = await inbox.transitionWork(item.id, item.revision, 'prepared'); item = await inbox.transitionWork(item.id, item.revision, 'approved');
    const transfer = await sync.prepareWorkTransfer(item, 'wss://host/ws'); item = await inbox.beginWorkTransfer(item.id, item.revision, transfer);
    item = await inbox.settleWorkTransfer(item.id, transfer.transferId, { transferId: transfer.transferId, workId: item.id, revision: transfer.manifest.revision, manifestHash: transfer.manifestHash, committedAt: 123 });
    const result = { schema: 1, manifestHash: transfer.manifestHash, createdAt: 200, model: 'fixture', minutes: { title: 'Meeting', summary: 'Draft', items: [] }, evidence: [
      { id: 'audio-evidence', fileId: item.files[0].id, text: 'Segmento', source: 'desktop-transcriber', startMs: 0, endMs: 1000 },
      { id: 'text-evidence', fileId: item.files[1].id, text: 'Texto importado', source: 'imported-text', startMs: 1000, endMs: 2500 },
    ], transcriptComparison: 'Borrador.', requiresReview: true };
    return (await inbox.saveWorkResult(item.id, transfer.transferId, result)).result;
  });
  expect(saved.evidence.map((item: any) => item.source)).toEqual(['desktop-transcriber', 'imported-text']);
});

test('cancelling an approved upload stops subsequent chunks and keeps its immutable recovery snapshot', async ({ page }) => {
  await page.goto('/');
  const stopped = await page.evaluate(async () => {
    const inbox = await import('/src/work-inbox.ts'); const sync = await import('/src/work-sync.ts');
    let item = await inbox.createWork({ title: 'Audio transfer', kind: 'meeting', instruction: 'Draft', files: [new File([new Uint8Array(150000)], 'audio.wav', { type: 'audio/wav' })] });
    item = await inbox.transitionWork(item.id, item.revision, 'prepared'); item = await inbox.transitionWork(item.id, item.revision, 'approved');
    const controller = new AbortController(); const operations: string[] = []; let manifestHash = ''; const offsets: Record<string, number> = {};
    const dispatcher = sync.createWorkDispatcher(async (request: any) => {
      operations.push(request.operation);
      if (request.operation === 'begin') { manifestHash = request.manifestHash; for (const file of request.manifest.files) offsets[file.id] = 0; }
      if (request.operation === 'chunk') { offsets[request.fileId] = request.offset + atob(request.data).length; controller.abort(); }
      return { type: 'work_sync_reply', requestId: request.requestId, transferId: request.transferId, state: 'uploading', manifestHash, offsets: { ...offsets } };
    }, 'wss://host/ws');
    const result = await Promise.allSettled([dispatcher.send(item.id, item.revision, undefined, controller.signal)]);
    const saved = await inbox.readWork(item.id);
    return { operations, rejected: result[0].status, status: saved.status, savedHash: saved.transfer.manifestHash, manifestHash };
  });
  expect(stopped.operations).toEqual(['begin','chunk']); expect(stopped.rejected).toBe('rejected'); expect(stopped.status).toBe('uncertain'); expect(stopped.savedHash).toBe(stopped.manifestHash);
});
