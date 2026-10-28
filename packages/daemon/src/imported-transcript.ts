/** Cue times are declarations in an imported file, never verification against its audio.
 * Syntax references: https://www.w3.org/TR/webvtt1/ and
 * https://www.loc.gov/preservation/digital/formats/fdd/fdd000569.shtml
 */
export const IMPORTED_TRANSCRIPT_LIMITS = Object.freeze({ bytes: 400000, cues: 500, cueChars: 20000, totalChars: 100000, plainChunkChars: 15000 });
export type ImportedTranscriptSegment = { text: string; startMs?: number; endMs?: number };
export type ImportedTranscript = { format: 'plain' | 'srt' | 'vtt'; segments: ImportedTranscriptSegment[]; warnings: string[] };
type FileHint = { name: string; mime: string };
function declaredFormat(file: FileHint): 'srt' | 'vtt' | undefined {
  if (file.mime === 'text/vtt' || /\.vtt$/i.test(file.name)) return 'vtt';
  if (['application/x-subrip', 'application/srt'].includes(file.mime) || /\.srt$/i.test(file.name)) return 'srt';
}
export function isImportedTranscript(file: FileHint): boolean { return file.mime.startsWith('text/') || declaredFormat(file) !== undefined; }

function plain(text: string, format: ImportedTranscript['format'], warnings: string[]): ImportedTranscript {
  if (text.length > IMPORTED_TRANSCRIPT_LIMITS.totalChars) throw new Error('La transcripción supera 100000 caracteres de evidencia; divídela sin perder el original.');
  const segments: ImportedTranscriptSegment[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + IMPORTED_TRANSCRIPT_LIMITS.plainChunkChars);
    // Keep a Unicode surrogate pair together when a plain-text page is split.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
    segments.push({ text: text.slice(start, end) }); start = end;
  }
  return { format, segments, warnings };
}
function timestamp(value: string, format: 'srt' | 'vtt'): number | undefined {
  const match = format === 'srt'
    ? /^(\d{2,9}):([0-5]\d):([0-5]\d),(\d{3})$/.exec(value)
    : /^(?:(\d{2,9}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value);
  if (!match) return;
  const milliseconds = ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

/** All-or-nothing timing: malformed input retains every original character, without guessed ranges. */
export function parseImportedTranscript(text: string, file: FileHint): ImportedTranscript {
  if (new TextEncoder().encode(text).byteLength > IMPORTED_TRANSCRIPT_LIMITS.bytes) throw new Error('La transcripción supera 400000 bytes; divídela antes de procesarla.');
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const format = declaredFormat(file) ?? (/^WEBVTT(?:[ \t]|\n|$)/.test(normalized) ? 'vtt' : undefined);
  if (!format) return plain(text, 'plain', []);
  const invalid = () => plain(text, format, [`El archivo declarado ${format.toUpperCase()} contiene una estructura o tiempos no admitidos. Se conserva íntegro como texto sin rangos temporales; no se infieren tiempos.`]);
  const blocks = normalized.trim().split(/\n[ \t]*\n+/);
  if (format === 'vtt') {
    const header = blocks.shift()?.split('\n') ?? [];
    if (!/^WEBVTT(?:[ \t][^\n]*)?$/.test(header[0] ?? '') || header.some(line => line.includes('-->') || /X-TIMESTAMP-MAP/i.test(line))) return invalid();
  }
  const segments: ImportedTranscriptSegment[] = []; let chars = 0; let priorStart = -1; let latestEnd = -1; let overlaps = false; let priorIndex = -1;
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    if (format === 'vtt' && /^NOTE(?:[ \t]|$)/.test(lines[0]!)) {
      if (block.includes('-->')) return invalid();
      continue;
    }
    if (format === 'vtt' && /^(STYLE|REGION)$/.test(lines[0]!)) {
      if (segments.length || block.includes('-->')) return invalid();
      continue;
    }
    let timingLine: string; let payload: string[];
    if (format === 'srt') {
      if (!/^\d{1,9}$/.test(lines[0] ?? '') || Number(lines[0]) <= priorIndex) return invalid();
      priorIndex = Number(lines[0]); timingLine = lines[1] ?? ''; payload = lines.slice(2);
    } else {
      const timingIndex = lines[0]?.includes('-->') ? 0 : 1;
      timingLine = lines[timingIndex] ?? ''; payload = lines.slice(timingIndex + 1);
    }
    const timing = /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t]+(.+))?$/.exec(timingLine);
    if (!timing || (format === 'srt' && timing[3]) || (timing[3] && !timing[3].split(/[ \t]+/).every(setting => /^[a-z][a-z-]*:[^\s]+$/.test(setting)))) return invalid();
    const startMs = timestamp(timing[1]!, format); const endMs = timestamp(timing[2]!, format);
    const cueText = payload.join('\n');
    if (startMs === undefined || endMs === undefined || endMs <= startMs || startMs < priorStart || !cueText.trim() || cueText.includes('-->')) return invalid();
    if (segments.length >= IMPORTED_TRANSCRIPT_LIMITS.cues) throw new Error('La transcripción supera 500 segmentos; divídela antes de procesarla.');
    chars += cueText.length;
    if (cueText.length > IMPORTED_TRANSCRIPT_LIMITS.cueChars || chars > IMPORTED_TRANSCRIPT_LIMITS.totalChars) throw new Error('La evidencia supera 20000 caracteres por segmento o 100000 en total; divide la transcripción.');
    overlaps ||= startMs < latestEnd; priorStart = startMs; latestEnd = Math.max(latestEnd, endMs);
    segments.push({ text: cueText, startMs, endMs });
  }
  if (!segments.length) return invalid();
  const warnings = [`Los tiempos importados ${format.toUpperCase()} proceden del archivo; no se han verificado contra audio ni constituyen alineación por palabra.`];
  if (overlaps) warnings.push('Hay intervalos importados solapados. Se conservaron sus textos y rangos originales, sin fusionarlos ni corregirlos.');
  return { format, segments, warnings };
}
