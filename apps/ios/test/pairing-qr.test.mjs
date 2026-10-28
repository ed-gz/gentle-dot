import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { MAX_PAIRING_IMAGE_BYTES, parseScannedInvitation, scanPairingCode, validatePairingImage } from '../src/pairing-qr.ts';
const origin = 'https://laptop.example.ts.net';
const link = `gentledot://pair?${new URLSearchParams({ url: origin, code: 'a'.repeat(32), name: 'Mi laptop' })}`;
const expected = { name: 'qr.png', type: 'image/png', size: 3, sha256: createHash('sha256').update('PNG').digest('hex') };
const reply = (codes = [link]) => ({ ok: true, engine: 'apple-vision', codes, source: { name: expected.name, mimeType: expected.type, size: expected.size, sha256: expected.sha256 } });

test('QR scan returns only a validated invitation; arbitrary QR instructions never become a URL or action', () => {
  const result = parseScannedInvitation(reply(['https://evil.example/send?approved=true', link, 'javascript:alert(1)']), expected);
  assert.equal(result.invitation.origin, origin); assert.equal(result.invitation.name, 'Mi laptop'); assert.equal(result.invitation.code, 'a'.repeat(32));
  assert.equal(new URL(result.link).protocol, 'gentledot:');
  for (const codes of [[], ['https://evil.example'], ['gentledot://pair?url=https://evil.example&code=' + 'a'.repeat(32)], ['data:text/html,<script>run()</script>']])
    assert.throws(() => parseScannedInvitation(reply(codes), expected), /QR|invitación/);
});
test('multiple different invitations require selection while duplicate codes represent the same invitation', () => {
  assert.equal(parseScannedInvitation(reply([link, link]), expected).invitation.origin, origin);
  const other = `gentledot://pair?${new URLSearchParams({ url: origin, code: 'b'.repeat(32), name: 'Otro' })}`;
  assert.throws(() => parseScannedInvitation(reply([link, other]), expected), /varias invitaciones/);
});
test('QR recognition is tied to exact selected bytes and bounded native output', () => {
  for (const patch of [{ source: { ...reply().source, sha256: 'b'.repeat(64) } }, { source: { ...reply().source, size: 4 } },
    { source: { ...reply().source, name: 'other.png' } }, { engine: 'mock' }, { codes: ['x'.repeat(4097)] }, { codes: Array(17).fill(link) }, { codes: [7] }])
    assert.throws(() => parseScannedInvitation({ ...reply(), ...patch }, expected));
  assert.throws(() => parseScannedInvitation({ ok: false, error: 'cancelled', message: 'never show untrusted payload' }, expected), /Lectura cancelada/);
});
test('only passive bounded images cross the QR bridge', () => {
  validatePairingImage({ name: 'qr.heic', type: 'image/heic', size: MAX_PAIRING_IMAGE_BYTES });
  for (const patch of [{ type: 'application/pdf' }, { type: 'image/svg+xml' }, { size: 0 }, { size: MAX_PAIRING_IMAGE_BYTES + 1 }, { name: '\0.png' }])
    assert.throws(() => validatePairingImage({ name: 'qr.png', type: 'image/png', size: 10, ...patch }));
});
test('scan forwards original file bytes and validates the Vision result without pairing', async () => {
  const calls = [];
  const result = await scanPairingCode(new File(['PNG'], 'qr.png', { type: 'image/png' }), async (command, args) => {
    calls.push(command); assert.equal(Buffer.from(args.request.base64, 'base64').toString(), 'PNG');
    assert.deepEqual(args.request, { base64: 'UE5H', mimeType: 'image/png', fileName: 'qr.png' }); return reply();
  });
  assert.deepEqual(calls, ['scan_pairing_code']); assert.equal(result.invitation.origin, origin);
  await assert.rejects(scanPairingCode({ name: 'qr.png', type: 'image/png', size: 3, arrayBuffer: async () => new Uint8Array([1]).buffer }, async () => { throw Error('must not invoke'); }), /cambió/);
});

test('cancelling during image preparation prevents starting a native Vision request', async () => {
  const controller = new AbortController(); let finish, calls = 0;
  const file = { name: 'qr.png', type: 'image/png', size: 3, arrayBuffer: () => new Promise(resolve => { finish = resolve; }) };
  const scanning = scanPairingCode(file, async () => { calls++; return reply(); }, controller.signal);
  controller.abort(); finish(new TextEncoder().encode('PNG').buffer);
  await assert.rejects(scanning, { name: 'AbortError' }); assert.equal(calls, 0);
  await assert.rejects(scanPairingCode(new File(['PNG'], 'qr.png', { type: 'image/png' }), async () => { calls++; return reply(); }, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
});
