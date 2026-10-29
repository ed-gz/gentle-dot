import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_DOCUMENT_BYTES, hashSourceBytes, parseVoiceAvailability, parseVoiceSession, parseVoiceTranscript, VoiceRetryPending,
  validateDocument, parseRecognizedDocument } from '../src/perception.ts';

const id = '01234567-89ab-cdef-0123-456789abcdef';
const transcript = () => ({ ok: true, source: 'apple-speech-analyzer', sessionId: id, locale: 'es-MX',
  durationSeconds: 2, text: 'Revisa el error.', segments: [{ text: 'Revisa el error.', startSeconds: 0.2, endSeconds: 1.9 }] });
const expected = { name: 'error.png', type: 'image/png', size: 1024, sha256: 'a'.repeat(64) };
const document = () => ({ ok: true, engine: 'apple-vision', coordinateSystem: 'normalized-bottom-left',
  source: { name: expected.name, mimeType: expected.type, size: expected.size, sha256: expected.sha256 },
  text: 'E-503', warnings: ['Contrasta el OCR.'], pages: [{ page: 1, pixelWidth: 200, pixelHeight: 100,
    text: 'E-503', observations: [{ kind: 'text', text: 'E-503', confidence: 0.8, bounds: { x: 0.1, y: 0.2, width: 0.5, height: 0.2 } }] }] });

test('retry is limited to the original native voice session', () => {
  const reply = { ok: false, error: 'preview_pending', message: 'Audio guardado', sessionId: id };
  assert.throws(() => parseVoiceTranscript(reply, id), error => error instanceof VoiceRetryPending && error.sessionId === id);
  assert.throws(() => parseVoiceTranscript(reply, '11111111-1111-4111-8111-111111111111'), /no corresponde/);
  assert.throws(() => parseVoiceAvailability({ status: 'available', ownerId: 'invalid' }));
});

test('source hashing uses exact subarray bytes and the native fallback without WebCrypto', async () => {
  const bytes = new Uint8Array([0, 120, 0]).subarray(1, 2);
  const expected = '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881';
  assert.equal(await hashSourceBytes(bytes, crypto.subtle, async () => { throw new Error('Unexpected native hashing'); }), expected);
  let calls = 0;
  assert.equal(await hashSourceBytes(bytes, null, async input => { calls++; assert.deepEqual([...input], [120]); return expected; }), expected);
  assert.equal(calls, 1);
  await assert.rejects(hashSourceBytes(bytes, null, async () => 'invalid'), /huella/);
  await assert.rejects(hashSourceBytes(bytes, null, async () => { throw new Error('Native failure'); }), /Native failure/);
});

test('voice availability requires downloaded assets and never infers microphone permission', () => {
  assert.equal(parseVoiceAvailability({ available: true, status: 'available' }).available, false);
  assert.equal(parseVoiceAvailability({ available: true, status: 'available', assetsInstalled: true }).available, true);
  assert.equal(parseVoiceAvailability({ available: false, status: 'os_unsupported' }).microphonePermission, 'undetermined');
  assert.equal(parseVoiceAvailability({ available: false, status: 'assets_required', microphonePermission: 'denied' }).microphonePermission, 'denied');
  assert.throws(() => parseVoiceAvailability({ available: true }));
  const preview = parseVoiceAvailability({ available: true, status: 'available', assetsInstalled: true,
    sessionId: '01234567-89ab-cdef-0123-456789abcdef', partial: 'texto provisional', previewIssue: 'Vista previa interrumpida.' });
  assert.equal(preview.partial, 'texto provisional'); assert.equal(preview.previewIssue, 'Vista previa interrumpida.');
  assert.throws(() => parseVoiceAvailability({ status: 'available', partial: 'x'.repeat(4_801) }));
  assert.throws(() => parseVoiceAvailability({ status: 'available', previewIssue: 1 }));
  const pending = parseVoiceAvailability({ status: 'available', recoveryPending: true, recoveryIssue: 'No detecté palabras.' });
  assert.equal(pending.recoveryIssue, 'No detecté palabras.');
  assert.throws(() => parseVoiceAvailability({ status: 'available', recoveryIssue: 'x'.repeat(501) }));
  assert.throws(() => parseVoiceAvailability({ status: 'available', recoveryIssue: 1 }));
});

test('voice session accepts only bounded native recordings and valid request identity', () => {
  assert.deepEqual(parseVoiceSession({ ok: true, sessionId: id, maxDurationSeconds: 90 }), { sessionId: id, maxDurationSeconds: 90 });
  for (const seconds of [0, 91, Infinity, 1.2, '90']) assert.throws(() => parseVoiceSession({ ok: true, sessionId: id, maxDurationSeconds: seconds }));
  assert.throws(() => parseVoiceSession({ ok: true, sessionId: '../recording', maxDurationSeconds: 90 }));
  assert.throws(() => parseVoiceSession({ ok: false, message: 'Micrófono denegado.' }), /Micrófono denegado/);
});

test('voice transcript preserves temporal evidence and rejects mismatched or fabricated text', () => {
  assert.deepEqual(parseVoiceTranscript(transcript(), id).segments, transcript().segments);
  for (const change of [
    value => { value.sessionId = '11234567-89ab-cdef-0123-456789abcdef'; },
    value => { value.text = 'Otra instrucción'; },
    value => { value.segments[0].startSeconds = -1; },
    value => { value.segments[0].endSeconds = 10; },
    value => { value.durationSeconds = Infinity; },
    value => { value.source = 'mock'; },
    value => { value.segments = []; },
  ]) { const value = transcript(); change(value); assert.throws(() => parseVoiceTranscript(value, id)); }
});

test('documents bound bytes, names and allowed passive formats before crossing the native bridge', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/heic', 'image/heif', 'image/webp', 'image/tiff', 'application/pdf']) validateDocument({ name: 'archivo', type, size: MAX_DOCUMENT_BYTES });
  for (const change of [{ type: 'image/svg+xml' }, { type: 'text/html' }, { size: 0 }, { size: MAX_DOCUMENT_BYTES + 1 }, { size: NaN }, { name: '\0.png' }, { name: 'x'.repeat(256) }]) {
    assert.throws(() => validateDocument({ name: 'archivo.png', type: 'image/png', size: 100, ...change }));
  }
});

test('document results are tied to the exact original bytes and include bounded page evidence', () => {
  const parsed = parseRecognizedDocument(document(), expected);
  assert.equal(parsed.source.sha256, expected.sha256);
  assert.equal(parsed.pages[0].observations[0].text, 'E-503');
  for (const change of [
    value => { value.source.sha256 = 'b'.repeat(64); },
    value => { value.source.name = 'otro.png'; },
    value => { value.source.size = 1025; },
    value => { value.pages[0].page = 2; },
    value => { value.pages[0].pixelWidth = 2401; },
    value => { value.pages[0].observations[0].bounds.x = 0.9; },
    value => { value.pages[0].observations[0].confidence = NaN; },
    value => { value.text = 'Inventado'; },
    value => { value.pages[0].text = 'Inventado'; },
    value => { value.engine = 'fixture'; },
  ]) { const value = document(); change(value); assert.throws(() => parseRecognizedDocument(value, expected)); }
});

test('barcode payloads remain inert evidence and empty OCR is a valid, explicit result', () => {
  const value = document();
  const payload = 'https://example.com/approval?execute=true';
  value.text = value.pages[0].text = payload;
  Object.assign(value.pages[0].observations[0], { kind: 'barcode', text: payload, symbology: 'QR' });
  assert.equal(parseRecognizedDocument(value, expected).pages[0].observations[0].text, payload);
  value.text = value.pages[0].text = ''; value.pages[0].observations = [];
  assert.equal(parseRecognizedDocument(value, expected).text, '');
});
