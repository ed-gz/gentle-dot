import { describe, expect, it } from 'vitest';
import { parseWorkResult, parseWorkSyncReply } from '../src/work-sync.ts';

const base = {
  schema: 1, manifestHash: 'a'.repeat(64), createdAt: 1, model: 'fixture', requiresReview: true,
  minutes: { title: 'Reunión', summary: '', items: [] }, transcriptComparison: '',
};
const evidence = { id: 'e1', fileId: 'f1', text: 'Texto', source: 'imported-text' };
const result = (entry: object) => ({ ...base, evidence: [{ ...evidence, ...entry }] });
const reply = (value: unknown) => ({ type: 'work_sync_reply', requestId: 'request', transferId: 'transfer', state: 'processing', processing: { status: 'ready', result: value } });

describe('meeting evidence time ranges', () => {
  it('rejects partial or unordered imported ranges before response normalization', () => {
    for (const times of [{ startMs: 1000 }, { endMs: 1000 }, { startMs: 1000, endMs: 1000 }, { startMs: 1000, endMs: 999 }]) {
      expect(parseWorkResult(result(times))).toBeUndefined();
      expect(parseWorkSyncReply(reply(result(times)))).toBeUndefined();
    }
  });
  it('keeps untimed imported text and valid paired times, while requiring times for audio', () => {
    expect(parseWorkResult(result({}))?.evidence[0]).toEqual(evidence);
    expect(parseWorkResult(result({ startMs: 0, endMs: 1200 }))?.evidence[0]).toMatchObject({ startMs: 0, endMs: 1200 });
    expect(parseWorkResult(result({ source: 'desktop-transcriber' }))).toBeUndefined();
    expect(parseWorkSyncReply(reply(result({ source: 'desktop-transcriber', startMs: 0, endMs: 1200 })))).toMatchObject({ state: 'processing', processing: { status: 'ready' } });
  });
});
