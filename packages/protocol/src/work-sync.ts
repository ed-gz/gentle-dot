/** Durable inbox transport. A committed receipt acknowledges storage, never execution. */
export const WORK_SYNC_LIMITS = Object.freeze({ files: 110, fileBytes: 25 * 1024 * 1024, audioBytes: 128 * 1024 * 1024, attachmentBytes: 256 * 1024 * 1024, totalBytes: 336 * 1024 * 1024, chunkBytes: 64 * 1024, transfers: 100 });
export type WorkSyncFile = { id: string; name: string; mime: string; bytes: number; sha256: string; role: 'attachment' | 'version'; createdAt?: number };
export type WorkSyncManifest = { schema: 1; workId: string; revision: number; title: string; kind: 'task' | 'meeting'; instruction: string; files: WorkSyncFile[] };
export type WorkSyncReceipt = { transferId: string; workId: string; revision: number; manifestHash: string; committedAt: number };
export type WorkEvidence = { id: string; fileId: string; text: string; source: 'desktop-transcriber' | 'imported-text'; startMs?: number; endMs?: number };
export type WorkMinutes = { title: string; summary: string; items: { kind: 'agreement' | 'task' | 'risk' | 'question'; certainty: 'confirmed' | 'proposal' | 'inference'; text: string; owner: string | null; due: string | null; evidenceIds: string[] }[] };
export type WorkResult = { schema: 1; manifestHash: string; createdAt: number; model: string; sessionId?: string; minutes: WorkMinutes; evidence: WorkEvidence[]; transcriptComparison: string; requiresReview: true };
export type WorkProcessing = { status: 'running' | 'uncertain' | 'failed'; message: string } | { status: 'ready'; result: WorkResult };
export type WorkSyncRequest = { type: 'work_sync'; requestId: string; transferId: string } & (
  | { operation: 'begin'; manifest: WorkSyncManifest; manifestHash: string }
  | { operation: 'status' | 'commit' }
  | { operation: 'process'; approvedManifestHash: string }
  | { operation: 'result' }
  | { operation: 'chunk'; fileId: string; offset: number; data: string }
);
export type WorkSyncReply = { type: 'work_sync_reply'; requestId: string; transferId: string } & (
  | { state: 'missing' }
  | { state: 'uploading'; manifestHash: string; offsets: Record<string, number> }
  | { state: 'committed'; receipt: WorkSyncReceipt }
  | { state: 'processing'; processing: WorkProcessing }
  | { state: 'error'; code: 'invalid' | 'conflict' | 'quota' | 'missing' | 'storage'; message: string }
);
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** Explicit allowlist also supplies canonical field order for hashing on both platforms. */
export function parseWorkSyncManifest(v: unknown): WorkSyncManifest | undefined {
  if (!object(v) || v.schema !== 1 || !id(v.workId) || !natural(v.revision) || v.revision < 1 || !text(v.title, 120) || !v.title.trim() || !text(v.instruction, 8000) || (v.kind !== 'task' && v.kind !== 'meeting') || !Array.isArray(v.files) || v.files.length > WORK_SYNC_LIMITS.files) return;
  const files: WorkSyncFile[] = []; let total = 0; let attachmentBytes = 0; let attachments = 0; let versions = 0;
  for (const f of v.files) {
    if (!object(f) || !id(f.id) || files.some(x => x.id === f.id) || !text(f.name, 255) || !f.name.trim() || /[\u0000-\u001f\u007f]/.test(f.name) || !text(f.mime, 100) || !/^[a-z0-9.+_-]+\/[a-z0-9.+_-]+$/.test(f.mime) || !natural(f.bytes) || f.bytes < 1 || f.bytes > (f.role === 'attachment' && f.mime.startsWith('audio/') ? WORK_SYNC_LIMITS.audioBytes : WORK_SYNC_LIMITS.fileBytes) || !hash(f.sha256) || (f.role !== 'attachment' && f.role !== 'version') || (f.createdAt !== undefined && !natural(f.createdAt))) return;
    if (f.role === 'attachment') { attachmentBytes += f.bytes; if (++attachments > 10 || attachmentBytes > WORK_SYNC_LIMITS.attachmentBytes) return; } else { if (++versions > 100 || f.mime !== 'text/plain' || f.bytes > 800_000) return; }
    total += f.bytes; if (total > WORK_SYNC_LIMITS.totalBytes) return;
    files.push({ id: f.id, name: f.name, mime: f.mime, bytes: f.bytes, sha256: f.sha256, role: f.role, ...(f.createdAt !== undefined ? { createdAt: f.createdAt } : {}) });
  }
  return { schema: 1, workId: v.workId, revision: v.revision, title: v.title, kind: v.kind, instruction: v.instruction, files };
}
export function canonicalWorkManifest(manifest: WorkSyncManifest): string {
  const safe = parseWorkSyncManifest(manifest); if (!safe) throw new Error('Invalid work manifest'); return JSON.stringify(safe);
}
export function parseWorkSyncRequest(v: unknown): WorkSyncRequest | undefined {
  if (!object(v) || v.type !== 'work_sync' || !id(v.requestId) || !id(v.transferId)) return;
  const base = { type: 'work_sync' as const, requestId: v.requestId, transferId: v.transferId };
  if (v.operation === 'status' || v.operation === 'commit' || v.operation === 'result') return { ...base, operation: v.operation };
  if (v.operation === 'process' && hash(v.approvedManifestHash)) return { ...base, operation: 'process', approvedManifestHash: v.approvedManifestHash };
  if (v.operation === 'begin') { const manifest = parseWorkSyncManifest(v.manifest); if (manifest && hash(v.manifestHash)) return { ...base, operation: 'begin', manifest, manifestHash: v.manifestHash }; return; }
  if (v.operation === 'chunk' && id(v.fileId) && natural(v.offset) && text(v.data, Math.ceil(WORK_SYNC_LIMITS.chunkBytes / 3) * 4) && v.data.length > 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.data)) return { ...base, operation: 'chunk', fileId: v.fileId, offset: v.offset, data: v.data };
}
export function parseWorkSyncReply(v: unknown): WorkSyncReply | undefined {
  if (!object(v) || v.type !== 'work_sync_reply' || !id(v.requestId) || !id(v.transferId)) return;
  const base = { type: 'work_sync_reply' as const, requestId: v.requestId, transferId: v.transferId };
  if (v.state === 'missing') return { ...base, state: 'missing' };
  if (v.state === 'processing' && object(v.processing)) {
    if (['running', 'uncertain', 'failed'].includes(v.processing.status as string) && text(v.processing.message, 500)) return { ...base, state: 'processing', processing: { status: v.processing.status as 'running', message: v.processing.message } };
    if (v.processing.status === 'ready') { const result = parseWorkResult(v.processing.result); if (result) return { ...base, state: 'processing', processing: { status: 'ready', result } }; }
  }
  if (v.state === 'error' && ['invalid', 'conflict', 'quota', 'missing', 'storage'].includes(v.code as string) && text(v.message, 500)) return { ...base, state: 'error', code: v.code as 'invalid', message: v.message };
  if (v.state === 'uploading' && hash(v.manifestHash) && object(v.offsets) && Object.keys(v.offsets).length <= WORK_SYNC_LIMITS.files && Object.entries(v.offsets).every(([key, offset]) => id(key) && natural(offset) && offset <= WORK_SYNC_LIMITS.audioBytes)) return { ...base, state: 'uploading', manifestHash: v.manifestHash, offsets: { ...v.offsets } as Record<string, number> };
  if (v.state === 'committed' && object(v.receipt)) { const r = v.receipt; if (r.transferId === v.transferId && id(r.workId) && natural(r.revision) && r.revision > 0 && hash(r.manifestHash) && natural(r.committedAt)) return { ...base, state: 'committed', receipt: { transferId: v.transferId, workId: r.workId, revision: r.revision, manifestHash: r.manifestHash, committedAt: r.committedAt } }; }
}

/** Bounded result with citations. No action instructions are executable in this contract. */
export function parseWorkResult(v: unknown): WorkResult | undefined {
  if (!object(v) || v.schema !== 1 || !hash(v.manifestHash) || !natural(v.createdAt) || !text(v.model, 200) || (v.sessionId !== undefined && !text(v.sessionId, 200)) || v.requiresReview !== true || !text(v.transcriptComparison, 12000) || !Array.isArray(v.evidence) || v.evidence.length > 500 || !object(v.minutes) || !text(v.minutes.title, 120) || !text(v.minutes.summary, 12000) || !Array.isArray(v.minutes.items) || v.minutes.items.length > 100) return;
  const evidence: WorkEvidence[] = []; let total = 0;
  for (const e of v.evidence) {
    if (!object(e) || !id(e.id) || !id(e.fileId) || evidence.some(prior => prior.id === e.id) || !text(e.text, 20000) || !['desktop-transcriber', 'imported-text'].includes(e.source as string) || (e.startMs !== undefined && !natural(e.startMs)) || (e.endMs !== undefined && !natural(e.endMs))) return;
    // Never normalize away one half of an imported time range. Untimed text
    // remains valid; timed text and desktop segments must have an ordered pair.
    if ((e.startMs === undefined) !== (e.endMs === undefined)
      || (e.source === 'desktop-transcriber' && e.startMs === undefined)
      || (natural(e.startMs) && natural(e.endMs) && e.endMs <= e.startMs)) return;
    total += e.text.length; if (total > 100000) return;
    evidence.push({ id: e.id, fileId: e.fileId, text: e.text, source: e.source as WorkEvidence['source'], ...(e.startMs !== undefined ? { startMs: e.startMs as number, endMs: e.endMs as number } : {}) });
  }
  const items: WorkMinutes['items'] = [];
  for (const item of v.minutes.items) {
    if (!object(item) || !['agreement','task','risk','question'].includes(item.kind as string) || !['confirmed','proposal','inference'].includes(item.certainty as string) || !text(item.text, 2000) || (item.owner !== null && !text(item.owner, 200)) || (item.due !== null && !text(item.due, 200)) || !Array.isArray(item.evidenceIds) || item.evidenceIds.length === 0 || item.evidenceIds.length > 20 || item.evidenceIds.some(key => !evidence.some(e => e.id === key))) return;
    total += item.text.length; if (total > 170000) return;
    const citations = item.evidenceIds as string[];
    const cited = evidence.filter(e => citations.includes(e.id)).map(e => e.text).join('\n').toLocaleLowerCase('es');
    if ((typeof item.owner === 'string' && !cited.includes(item.owner.toLocaleLowerCase('es'))) || (typeof item.due === 'string' && !cited.includes(item.due.toLocaleLowerCase('es')))) return;
    items.push({ kind: item.kind as WorkMinutes['items'][number]['kind'], certainty: item.certainty as WorkMinutes['items'][number]['certainty'], text: item.text, owner: item.owner as string | null, due: item.due as string | null, evidenceIds: item.evidenceIds as string[] });
  }
  return { schema: 1, manifestHash: v.manifestHash, createdAt: v.createdAt, model: v.model, ...(v.sessionId !== undefined ? { sessionId: v.sessionId as string } : {}), minutes: { title: v.minutes.title, summary: v.minutes.summary, items }, evidence, transcriptComparison: v.transcriptComparison, requiresReview: true };
}
