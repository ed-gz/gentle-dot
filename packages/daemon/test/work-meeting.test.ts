import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalWorkManifest, type WorkSyncManifest, type WorkResult, type WorkSyncRequest } from '@gentle-dot/protocol';
import { expect, it } from 'vitest';
import { checkMeetingContextBudget, createMeetingProcessor } from '../src/work-meeting.ts';
import { WorkProcessorFailure, WorkSyncStore } from '../src/work-sync.ts';
import { tempDir } from './helpers.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const minutes = { title: 'Release review', summary: 'Revisar el despliegue; todavía falta una fecha confirmada.', items: [{ kind: 'task', certainty: 'confirmed', text: 'Ana revisará los logs.', owner: 'Ana', due: null, evidenceIds: ['audio-0'] }, { kind: 'risk', certainty: 'inference', text: 'El ruido puede afectar la evidencia.', owner: null, due: null, evidenceIds: ['apple-0'] }] };
it('budgets the complete prompt against the selected model without silently truncating it', () => {
  expect(() => checkMeetingContextBudget('á'.repeat(12000), 32768)).toThrow('no cabe');
  expect(() => checkMeetingContextBudget('x'.repeat(1000), 32768)).not.toThrow();
  expect(() => checkMeetingContextBudget('x'.repeat(1000), 4096, 512)).not.toThrow();
  expect(() => checkMeetingContextBudget('x', 4096, 0)).toThrow('no cabe');
  expect(() => checkMeetingContextBudget('x', 0)).toThrow('no cabe');
});
it.skipIf(spawnSync('ffmpeg', ['-version']).status !== 0 || spawnSync('ffprobe', ['-version']).status !== 0)('real ffmpeg decoding splits a 31-second WAV into bounded local-transcriber segments', async () => {
  const directory = tempDir(); const dataBytes = 31 * 16000 * 2; const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  await writeFile(join(directory, 'audio'), wav); const sizes: number[] = [];
  const manifest: WorkSyncManifest = { schema: 1, workId: 'w', revision: 1, title: 'Recording', kind: 'meeting', instruction: '', files: [{ id: 'audio', name: 'recording.wav', mime: 'audio/wav', bytes: wav.length, sha256: createHash('sha256').update(wav).digest('hex'), role: 'attachment' }] };
  const processor = createMeetingProcessor({ voice: { available: async () => true, transcribe: async (mime, data) => { expect(mime).toBe('audio/wav'); sizes.push(Buffer.from(data, 'base64').length); return { ok: true, text: 'Ana revisará los logs.' }; } }, generate: async () => ({ text: JSON.stringify({ minutes: { ...minutes, items: [minutes.items[0]] }, transcriptComparison: 'Sólo transcripción desktop.' }), model: 'fixture' }) });
  const result = await processor({ directory, manifest, receipt: { transferId: 't', workId: 'w', revision: 1, manifestHash: hash(canonicalWorkManifest(manifest)), committedAt: 1 } }, new AbortController().signal);
  expect(sizes).toHaveLength(2); expect(sizes.every(size => size <= 1_000_000)).toBe(true);
  expect(result.evidence.map(item => [item.startMs, item.endMs])).toEqual([[0,30000], [30000,31000]]);
});
it('contrasts original audio and imported transcript with coarse temporal evidence; no tools or external action', async () => {
  const directory = tempDir(); await writeFile(join(directory, 'apple'), 'Ana revisará los logs. ¿El viernes? No confirmado.');
  const manifest: WorkSyncManifest = { schema: 1, workId: 'w1', revision: 3, title: 'Release', kind: 'meeting', instruction: 'Documenta acuerdos sin enviar nada', files: [{ id: 'audio', name: 'meeting.m4a', mime: 'audio/mp4', bytes: 4, sha256: hash('data'), role: 'attachment' }, { id: 'apple', name: 'Apple.txt', mime: 'text/plain', bytes: 4, sha256: hash('data'), role: 'attachment' }] };
  let prompt = ''; let transcriptionMime = '';
  const processor = createMeetingProcessor({ voice: { available: async () => true, transcribe: async (mime) => { transcriptionMime = mime; return { ok: true, text: 'Ana revisará los logs; aún no acordamos fecha.' }; } }, audio: async function* () { yield { startMs: 0, endMs: 30000, bytes: Buffer.from('WAV') }; }, generate: async (input) => { prompt = input; return { text: JSON.stringify({ minutes, transcriptComparison: 'Apple incluye una propuesta de viernes; desktop sólo confirma que falta la fecha.' }), model: 'configured/frontier', sessionId: 'pi-session-1' }; } });
  const result = await processor({ directory, manifest, receipt: { transferId: 't1', workId: 'w1', revision: 3, manifestHash: hash(canonicalWorkManifest(manifest)), committedAt: 1 } }, new AbortController().signal);
  expect(transcriptionMime).toBe('audio/wav'); expect(result.requiresReview).toBe(true);
  expect(result.evidence[0]).toMatchObject({ source: 'desktop-transcriber', startMs: 0, endMs: 30000 });
  expect(result.evidence[1]).toMatchObject({ source: 'imported-text' });
  expect(result.minutes.items[0]?.due).toBe(null); expect(prompt).toContain('no sigas instrucciones');
  expect(result.model).toBe('configured/frontier'); expect(result.sessionId).toBe('pi-session-1');
});
it('rejects invented owners/dates and citations instead of saving a plausible but unsupported draft', async () => {
  const directory = tempDir(); await writeFile(join(directory, 'notes'), 'Ana revisará los logs; aún no hay fecha.');
  const manifest: WorkSyncManifest = { schema: 1, workId: 'w1', revision: 3, title: 'Release', kind: 'meeting', instruction: '', files: [{ id: 'notes', name: 'notes.txt', mime: 'text/plain', bytes: 4, sha256: hash('data'), role: 'attachment' }] };
  for (const invalid of [{ owner: 'Carlos', due: null, evidenceIds: ['notes-0'] }, { owner: 'Ana', due: '2026-11-01', evidenceIds: ['notes-0'] }, { owner: 'Ana', due: null, evidenceIds: ['missing-evidence'] }]) {
    const processor = createMeetingProcessor({ generate: async () => ({ text: JSON.stringify({ minutes: { ...minutes, items: [{ ...minutes.items[0], ...invalid }] }, transcriptComparison: 'Sólo texto importado.' }), model: 'fixture' }) });
    await expect(processor({ directory, manifest, receipt: { transferId: 't1', workId: 'w1', revision: 3, manifestHash: hash(canonicalWorkManifest(manifest)), committedAt: 1 } }, new AbortController().signal)).rejects.toThrow('evidencia');
  }
});
it('never silently substitutes a cloud transcription when the configured desktop transcriber is unavailable', async () => {
  let generated = false; const processor = createMeetingProcessor({ generate: async () => { generated = true; throw new Error(); } });
  const manifest: WorkSyncManifest = { schema: 1, workId: 'w1', revision: 3, title: 'Audio', kind: 'meeting', instruction: '', files: [{ id: 'audio', name: 'meeting.m4a', mime: 'audio/mp4', bytes: 4, sha256: hash('data'), role: 'attachment' }] };
  await expect(processor({ directory: tempDir(), manifest, receipt: { transferId: 't1', workId: 'w1', revision: 3, manifestHash: hash(canonicalWorkManifest(manifest)), committedAt: 1 } }, new AbortController().signal)).rejects.toThrow('transcriptor'); expect(generated).toBe(false);
});
it('preserves SRT cue-level quotation provenance and deterministic warnings without touching source/version bytes', async () => {
  const directory = tempDir();
  const srt = '1\n00:00:00,000 --> 00:00:03,500\nPropuesta: revisar mañana, todavía sin aprobar.\n\n2\n00:00:03,500 --> 00:00:08,000\nOperador sintético acepta revisar el 3 de noviembre.';
  const version = 'Borrador anterior, sin aprobación.';
  await writeFile(join(directory, 'notes'), srt); await writeFile(join(directory, 'previous'), version);
  const manifest: WorkSyncManifest = { schema: 1, workId: 'meeting-srt', revision: 2, kind: 'meeting', title: 'Synthetic', instruction: 'Draft only', files: [
    { id: 'notes', name: 'notes.srt', mime: 'application/octet-stream', bytes: Buffer.byteLength(srt), sha256: hash(srt), role: 'attachment' },
    { id: 'previous', name: 'draft.txt', mime: 'text/plain', bytes: Buffer.byteLength(version), sha256: hash(version), role: 'version', createdAt: 1 },
  ] };
  let prompt: Record<string, unknown> = {};
  const processor = createMeetingProcessor({ generate: async input => { prompt = JSON.parse(input); return { model: 'fixture', text: JSON.stringify({ minutes: { title: 'Borrador', summary: 'Tarea confirmada y propuesta separadas.', items: [
    { kind: 'task', certainty: 'confirmed', text: 'Revisar.', owner: 'Operador sintético', due: 'el 3 de noviembre', evidenceIds: ['notes-1'] },
    { kind: 'task', certainty: 'proposal', text: 'Revisar mañana no está aprobado.', owner: null, due: null, evidenceIds: ['notes-0'] },
  ] }, transcriptComparison: 'Sólo texto importado.' }) }; } });
  const manifestHash = hash(canonicalWorkManifest(manifest));
  const result = await processor({ directory, manifest, receipt: { transferId: 'synthetic', workId: manifest.workId, revision: 2, manifestHash, committedAt: 1 } }, new AbortController().signal);
  expect(result.evidence).toEqual([
    { id: 'notes-0', fileId: 'notes', text: 'Propuesta: revisar mañana, todavía sin aprobar.', source: 'imported-text', startMs: 0, endMs: 3500 },
    { id: 'notes-1', fileId: 'notes', text: 'Operador sintético acepta revisar el 3 de noviembre.', source: 'imported-text', startMs: 3500, endMs: 8000 },
  ]);
  expect(result.manifestHash).toBe(manifestHash); expect(result.requiresReview).toBe(true);
  expect(result.transcriptComparison).toContain('no se han verificado contra audio');
  expect(prompt.importWarnings).toHaveLength(1); expect(prompt.evidence).toEqual(result.evidence);
  expect(prompt.priorDrafts).toEqual([{ fileId: 'previous', createdAt: 1, text: version }]);
  expect(await readFile(join(directory, 'notes'), 'utf8')).toBe(srt);
  expect(await readFile(join(directory, 'previous'), 'utf8')).toBe(version);
});

it('includes the reviewed correction in the next draft without treating it as source evidence', async () => {
  const directory = tempDir();
  const evidence = 'Se acordó revisar el registro.';
  const correction = 'Cambiar el título a Seguimiento y conservar la tarea sin responsable.';
  await writeFile(join(directory, 'notes'), evidence);
  await writeFile(join(directory, 'version'), correction);
  const manifest: WorkSyncManifest = { schema: 1, workId: 'corrected', revision: 2, kind: 'meeting', title: 'Reunión', instruction: 'Revisar minuta', files: [
    { id:'notes', name:'notes.txt', mime:'text/plain', bytes:Buffer.byteLength(evidence), sha256:hash(evidence), role:'attachment' },
    { id:'version', name:'version.txt', mime:'text/plain', bytes:Buffer.byteLength(correction), sha256:hash(correction), role:'version', createdAt:3 },
  ] };
  const processor=createMeetingProcessor({generate:async input=>{
    const prompt=JSON.parse(input);
    expect(prompt.priorDrafts).toEqual([{fileId:'version',createdAt:3,text:correction}]);
    expect(prompt.evidence).toEqual([{id:'notes-0',fileId:'notes',text:evidence,source:'imported-text'}]);
    return {model:'fixture',text:JSON.stringify({minutes:{title:prompt.priorDrafts[0].text.includes('Seguimiento')?'Seguimiento':'Anterior',summary:'Revisión.',items:[{kind:'task',certainty:'confirmed',text:'Revisar el registro.',owner:null,due:null,evidenceIds:['notes-0']}]},transcriptComparison:'Sólo texto importado.'})};
  }});
  const result=await processor({directory,manifest,receipt:{transferId:'t',workId:'corrected',revision:2,manifestHash:hash(canonicalWorkManifest(manifest)),committedAt:1}},new AbortController().signal);
  expect(result.minutes.title).toBe('Seguimiento');expect(result.evidence.map(item=>item.fileId)).toEqual(['notes']);expect(result.requiresReview).toBe(true);
  expect(await readFile(join(directory,'version'),'utf8')).toBe(correction);
});

it('rejects oversized versions before generation rather than silently truncating corrections', async () => {
  const directory=tempDir(), draft='x'.repeat(200001);await writeFile(join(directory,'version'),draft);let called=false;
  const manifest:WorkSyncManifest={schema:1,workId:'large-draft',revision:1,kind:'meeting',title:'Reunión',instruction:'',files:[{id:'version',name:'draft.txt',mime:'text/plain',bytes:Buffer.byteLength(draft),sha256:hash(draft),role:'version',createdAt:1}]};
  const processor=createMeetingProcessor({generate:async()=>{called=true;throw new Error('not expected');}});
  await expect(processor({directory,manifest,receipt:{transferId:'t',workId:manifest.workId,revision:1,manifestHash:hash(canonicalWorkManifest(manifest)),committedAt:1}},new AbortController().signal)).rejects.toThrow('superan 200000 caracteres');
  expect(called).toBe(false);expect(await readFile(join(directory,'version'),'utf8')).toBe(draft);
});

it('reports the version budget failure through the durable processing status', async () => {
  const directory=join(tempDir(),'inbox');const manifest:WorkSyncManifest={schema:1,workId:'failure',revision:1,kind:'meeting',title:'Reunión',instruction:'',files:[]};const manifestHash=hash(canonicalWorkManifest(manifest));
  const store=new WorkSyncStore(directory,async()=>{throw new WorkProcessorFailure('versions-too-large');});
  const send=(operation:object)=>store.handle('device',{type:'work_sync',requestId:randomUUID(),transferId:'t',...operation} as WorkSyncRequest);
  await send({operation:'begin',manifest,manifestHash});await send({operation:'commit'});await send({operation:'process',approvedManifestHash:manifestHash});
  await expect.poll(async()=>{const value=await send({operation:'result'});return value.state==='processing'&&value.processing.status==='failed'?value.processing.message:'';}).toContain('superan 200000 caracteres');
  await store.close();
});

it('reports the selected model context limit without exposing arbitrary processor errors', async () => {
  const directory=join(tempDir(),'inbox');const manifest:WorkSyncManifest={schema:1,workId:'context-failure',revision:1,kind:'meeting',title:'Reunión',instruction:'',files:[]};const manifestHash=hash(canonicalWorkManifest(manifest));
  const store=new WorkSyncStore(directory,async()=>{throw new WorkProcessorFailure('model-context-too-small');});
  const send=(operation:object)=>store.handle('device',{type:'work_sync',requestId:randomUUID(),transferId:'t',...operation} as WorkSyncRequest);
  await send({operation:'begin',manifest,manifestHash});await send({operation:'commit'});await send({operation:'process',approvedManifestHash:manifestHash});
  await expect.poll(async()=>{const value=await send({operation:'result'});return value.state==='processing'&&value.processing.status==='failed'?value.processing.message:'';}).toContain('presupuesto conservador');
  await store.close();
});

it('preserves malformed timed text without invented ranges even when the model omits the import warning', async () => {
  const directory = tempDir(); const malformed = 'WEBVTT\n\n00:02.000 --> 00:01.000\nAna revisará los logs.';
  await writeFile(join(directory, 'notes'), malformed);
  const manifest: WorkSyncManifest = { schema: 1, workId: 'malformed', revision: 1, kind: 'meeting', title: 'Synthetic', instruction: '', files: [{ id: 'notes', name: 'notes.vtt', mime: 'text/vtt', bytes: Buffer.byteLength(malformed), sha256: hash(malformed), role: 'attachment' }] };
  const processor = createMeetingProcessor({ generate: async () => ({ model: 'fixture', text: JSON.stringify({ minutes: { title: 'Borrador', summary: 'Sin tiempos confirmados.', items: [] }, transcriptComparison: 'Sólo texto.' }) }) });
  const result = await processor({ directory, manifest, receipt: { transferId: 'malformed', workId: manifest.workId, revision: 1, manifestHash: hash(canonicalWorkManifest(manifest)), committedAt: 1 } }, new AbortController().signal);
  expect(result.evidence).toEqual([{ id: 'notes-0', fileId: 'notes', text: malformed, source: 'imported-text' }]);
  expect(result.transcriptComparison).toContain('sin rangos temporales');
});

it('refuses an over-budget imported transcript before calling the model', async () => {
  const directory = tempDir(); const text = Array.from({ length: 501 }, (_, index) => `${index + 1}\n00:00:00,000 --> 00:00:01,000\nX`).join('\n\n');
  await writeFile(join(directory, 'notes'), text); let generated = false;
  const manifest: WorkSyncManifest = { schema: 1, workId: 'over-budget', revision: 1, kind: 'meeting', title: 'Synthetic', instruction: '', files: [{ id: 'notes', name: 'notes.srt', mime: 'application/x-subrip', bytes: Buffer.byteLength(text), sha256: hash(text), role: 'attachment' }] };
  const processor = createMeetingProcessor({ generate: async () => { generated = true; throw new Error('Must not run'); } });
  await expect(processor({ directory, manifest, receipt: { transferId: 'over-budget', workId: manifest.workId, revision: 1, manifestHash: hash(canonicalWorkManifest(manifest)), committedAt: 1 } }, new AbortController().signal)).rejects.toThrow('500 segmentos');
  expect(generated).toBe(false);
});

it('keeps evidence IDs bounded and unique for maximum-length file IDs and fallback-name collisions', async () => {
  const directory = tempDir(); const text = '1\n00:00:00,000 --> 00:00:01,000\nTexto sintético.';
  const fileIds = ['a'.repeat(128), 'evidence'];
  for (const id of fileIds) await writeFile(join(directory, id), text);
  const manifest: WorkSyncManifest = { schema: 1, workId: 'long-ids', revision: 1, kind: 'meeting', title: 'Synthetic', instruction: '', files: fileIds.map(id => ({ id, name: 'notes.srt', mime: 'application/x-subrip', bytes: Buffer.byteLength(text), sha256: hash(text), role: 'attachment' })) };
  const processor = createMeetingProcessor({ generate: async input => {
    const prompt = JSON.parse(input) as { evidence: { id: string }[] };
    return { model: 'fixture', text: JSON.stringify({ minutes: { title: 'Borrador', summary: 'Dos fuentes.', items: prompt.evidence.map(item => ({ kind: 'question', certainty: 'confirmed', text: 'Texto sintético.', owner: null, due: null, evidenceIds: [item.id] })) }, transcriptComparison: 'Texto importado.' }) };
  } });
  const result = await processor({ directory, manifest, receipt: { transferId: 'long-ids', workId: manifest.workId, revision: 1, manifestHash: hash(canonicalWorkManifest(manifest)), committedAt: 1 } }, new AbortController().signal);
  expect(result.evidence.map(item => item.id)).toEqual(['evidence-0', 'evidence-1']);
  expect(result.evidence.map(item => item.fileId)).toEqual(fileIds);
  expect(result.minutes.items.map(item => item.evidenceIds)).toEqual([['evidence-0'], ['evidence-1']]);
});
it('processing requires exact approval, deduplicates starts and persists the result across restart', async () => {
  const directory = join(tempDir(), 'inbox'); let calls = 0; let finish: (() => void) | undefined;
  const manifest: WorkSyncManifest = { schema: 1, workId: 'w1', revision: 3, title: 'Meeting', kind: 'meeting', instruction: 'Draft', files: [] }; const manifestHash = hash(canonicalWorkManifest(manifest));
  const store = new WorkSyncStore(directory, async () => { calls++; await new Promise<void>(resolve => { finish = resolve; }); return { schema: 1, manifestHash, createdAt: 1, model: 'fixture', minutes: { title: 'Draft', summary: 'No evidence', items: [] }, evidence: [], transcriptComparison: 'No audio.', requiresReview: true }; });
  const request = (operation: object) => ({ type: 'work_sync', requestId: randomUUID(), transferId: 'transfer-1', ...operation }) as WorkSyncRequest;
  const send = (operation: object) => store.handle('device-1', request(operation));
  await send({ operation: 'begin', manifest, manifestHash }); await send({ operation: 'commit' });
  expect(await send({ operation: 'process', approvedManifestHash: 'a'.repeat(64) })).toMatchObject({ state: 'error', code: 'conflict' });
  expect(await send({ operation: 'process', approvedManifestHash: manifestHash })).toMatchObject({ state: 'processing', processing: { status: 'running' } });
  await send({ operation: 'process', approvedManifestHash: manifestHash }); expect(calls).toBe(1); finish!();
  await expect.poll(async () => { const reply = await send({ operation: 'result' }); return reply.state === 'processing' ? reply.processing.status : reply.state; }).toBe('ready');
  await store.close();
  expect(await new WorkSyncStore(directory).handle('device-1', request({ operation: 'result' }))).toMatchObject({ state: 'processing', processing: { status: 'ready', result: { requiresReview: true, manifestHash } } });
});
it('interrupted processing becomes uncertain after restart and never repeats inference automatically', async () => {
  const directory = join(tempDir(), 'inbox'); const manifest: WorkSyncManifest = { schema: 1, workId: 'w', revision: 1, title: 'Meeting', kind: 'meeting', instruction: 'Draft', files: [] }; const manifestHash = hash(canonicalWorkManifest(manifest));
  const namespace = join(directory, hash('device'), 'transfer'); await mkdir(namespace, { recursive: true });
  await writeFile(join(namespace, 'manifest.json'), JSON.stringify({ manifest, manifestHash, receipt: { transferId: 'transfer', workId: 'w', revision: 1, manifestHash, committedAt: 1 }, processing: { status: 'running', message: 'in progress' } }));
  let calls = 0; const store = new WorkSyncStore(directory, async () => { calls++; throw new Error(); });
  const reply = await store.handle('device', { type: 'work_sync', requestId: 'r', transferId: 'transfer', operation: 'process', approvedManifestHash: manifestHash });
  expect(reply).toMatchObject({ state: 'processing', processing: { status: 'uncertain' } }); expect(calls).toBe(0);
});
