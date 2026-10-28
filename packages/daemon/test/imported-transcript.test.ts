import { expect, it } from 'vitest';
import { IMPORTED_TRANSCRIPT_LIMITS, isImportedTranscript, parseImportedTranscript } from '../src/imported-transcript.ts';

it('maps SRT cues to exact millisecond ranges and preserves multiline quotations in source order', () => {
  const text = '\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\nOperador sintético: «Acepto».\r\nSin fecha confirmada.\r\n\r\n2\r\n00:01:02,003 --> 00:01:04,999\r\n¿Quién valida?\r\n';
  const parsed = parseImportedTranscript(text, { name: 'notes.srt', mime: 'application/octet-stream' });
  expect(parsed.segments).toEqual([
    { startMs: 1250, endMs: 3500, text: 'Operador sintético: «Acepto».\nSin fecha confirmada.' },
    { startMs: 62003, endMs: 64999, text: '¿Quién valida?' },
  ]);
  expect(parsed.warnings.join(' ')).toContain('no se han verificado contra audio');
  expect(isImportedTranscript({ name: 'notes.srt', mime: 'application/octet-stream' })).toBe(true);
});

it('reads WebVTT identifiers/settings and legitimate overlapping cues without merging speakers', () => {
  const parsed = parseImportedTranscript('WEBVTT diagnóstico\nLanguage: es\n\nNOTE Metadatos no pronunciados\nComentario\n\nSTYLE\n::cue { color: white; }\n\nvoz-a\n00:01.000 --> 00:05.000 align:start position:10%\n<v A>«Uno»</v>\n\nvoz-b\n00:03.250 --> 00:06.000\n<v B>«Dos»</v>\n\nvoz-c\n00:06.000 --> 01:02:03.004\nFin.', { name: 'notes.vtt', mime: 'text/vtt' });
  expect(parsed.segments).toEqual([
    { startMs: 1000, endMs: 5000, text: '<v A>«Uno»</v>' },
    { startMs: 3250, endMs: 6000, text: '<v B>«Dos»</v>' },
    { startMs: 6000, endMs: 3723004, text: 'Fin.' },
  ]);
  expect(parsed.warnings.join(' ')).toContain('solapados');
  expect(parsed.segments.map(segment => segment.text).join(' ')).not.toContain('Metadatos');
});

it('falls back to the complete original text for malformed, reversed, unordered, or partly valid timestamps', () => {
  const cases = [
    '1\n00:00:00,000 --> 00:00:02,000\nVálido.\n\n2\n00:61:03,000 --> 00:62:04,000\nInválido.',
    '1\n00:00:02,000 --> 00:00:02,000\nDuración cero.',
    '1\n00:00:03,000 --> 00:00:02,000\nReverso.',
    '1\n00:00:03,000 --> 00:00:05,000\nPrimero.\n\n2\n00:00:01,000 --> 00:00:02,000\nRetrocede.',
    '1\n00:00:00.000 --> 00:00:02.000\nSeparador incorrecto.',
    'Texto sin estructura ni tiempos.',
    '1\n00:00:00,000 --> 00:00:02,000\nTexto\n2\n00:00:02,000 --> 00:00:04,000\nFalta separador.',
  ];
  for (const text of cases) {
    const parsed = parseImportedTranscript(text, { name: 'malformed.srt', mime: 'application/x-subrip' });
    expect(parsed.segments.map(segment => segment.text).join('')).toBe(text);
    expect(parsed.segments.every(segment => segment.startMs === undefined && segment.endMs === undefined)).toBe(true);
    expect(parsed.warnings.join(' ')).toContain('sin rangos temporales');
  }
});

it('does not silently apply a WebVTT stream timestamp map or accept missing headers', () => {
  for (const text of ['WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000\n\n00:00.000 --> 00:02.000\nTexto.', '00:00.000 --> 00:02.000\nTexto.']) {
    const parsed = parseImportedTranscript(text, { name: 'stream.vtt', mime: 'text/vtt' });
    expect(parsed.segments).toEqual([{ text }]);
    expect(parsed.warnings).toHaveLength(1);
  }
});

it('retains a malformed NOTE block containing a cue arrow instead of silently discarding its text', () => {
  const text = 'WEBVTT\n\nNOTE\n00:00.000 --> 00:01.000\nTexto perdido\n\n00:01.000 --> 00:02.000\nTexto conservado';
  const parsed = parseImportedTranscript(text, { name: 'notes.vtt', mime: 'text/vtt' });
  expect(parsed.segments).toEqual([{ text }]);
  expect(parsed.warnings.join(' ')).toContain('sin rangos temporales');
});

it('keeps overlapping SRT cues distinct and accepts adjacent cues without inventing overlap', () => {
  const cue = (index: number, start: number, end: number) => `${index}\n00:00:0${start},000 --> 00:00:0${end},000\nVoz ${index}.`;
  const overlapping = parseImportedTranscript([cue(1, 0, 3), cue(2, 1, 4), cue(3, 4, 5)].join('\n\n'), { name: 'overlap.srt', mime: 'text/plain' });
  expect(overlapping.segments.map(segment => [segment.startMs, segment.endMs])).toEqual([[0, 3000], [1000, 4000], [4000, 5000]]);
  expect(overlapping.warnings.some(warning => warning.includes('solapados'))).toBe(true);
  const adjacent = parseImportedTranscript([cue(1, 0, 3), cue(2, 3, 4)].join('\n\n'), { name: 'adjacent.srt', mime: 'text/plain' });
  expect(adjacent.warnings.some(warning => warning.includes('solapados'))).toBe(false);
});

it('fails explicitly at byte/cue/evidence budgets instead of returning a partial transcript', () => {
  const hint = { name: 'long.srt', mime: 'text/plain' };
  expect(() => parseImportedTranscript('é'.repeat(IMPORTED_TRANSCRIPT_LIMITS.bytes / 2 + 1), hint)).toThrow('400000 bytes');
  const many = Array.from({ length: 501 }, (_, index) => `${index + 1}\n00:00:00,000 --> 00:00:01,000\nX`).join('\n\n');
  expect(() => parseImportedTranscript(many, hint)).toThrow('500 segmentos');
  expect(() => parseImportedTranscript(`1\n00:00:00,000 --> 00:00:01,000\n${'a'.repeat(20001)}`, hint)).toThrow('20000');
  expect(() => parseImportedTranscript('a'.repeat(100001), { name: 'notes.txt', mime: 'text/plain' })).toThrow('100000');
});

it('retains plain text and does not split Unicode pairs at a page boundary', () => {
  const text = 'a'.repeat(14999) + '🪄' + 'fin';
  const parsed = parseImportedTranscript(text, { name: 'notes.txt', mime: 'text/plain' });
  expect(parsed.format).toBe('plain'); expect(parsed.warnings).toEqual([]);
  expect(parsed.segments.map(segment => segment.text).join('')).toBe(text);
  expect(parsed.segments[1]?.text.startsWith('🪄')).toBe(true);
  expect(isImportedTranscript({ name: 'image.png', mime: 'image/png' })).toBe(false);
});
