import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanPairingCamera } from '../src/pairing-camera.ts';
const origin = 'https://laptop.example.ts.net';
const link = `gentledot://pair?${new URLSearchParams({ url: origin, code: 'a'.repeat(32), name: 'Mi laptop' })}`;

test('live camera returns a validated canonical candidate without issuing pairing or navigation', async () => {
  const commands = [];
  const candidate = await scanPairingCamera(async (command, args) => {
    commands.push(command); assert.match(args.id, /^[a-f0-9-]{36}$/); return { ok: true, cancelled: false, value: link };
  });
  assert.deepEqual(commands, ['pairing_scan']);
  assert.equal(candidate.invitation.origin, origin); assert.equal(candidate.link, link);
  for (const value of ['https://evil.example', link + '&code=duplicate', link.replace(encodeURIComponent(origin), encodeURIComponent('https://evil.example')), 'x'.repeat(4097)]) {
    await assert.rejects(scanPairingCamera(async () => ({ ok: true, cancelled: false, value })));
  }
});

test('native cancellation is distinct from malformed success and unavailable camera', async () => {
  assert.equal(await scanPairingCamera(async () => ({ ok: true, cancelled: true })), null);
  for (const reply of [{ ok: true }, { ok: true, cancelled: true, value: link }, { ok: true, cancelled: false, value: 4 }])
    await assert.rejects(scanPairingCamera(async () => reply));
  await assert.rejects(scanPairingCamera(async () => ({ ok: false, message: 'Cámara no disponible.' })), /Cámara no disponible/);
});

test('abort blocks camera launch and discards any late native candidate', async () => {
  const cancelled = new AbortController(); cancelled.abort(); let calls = 0;
  await assert.rejects(scanPairingCamera(async () => { calls++; return {}; }, cancelled.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
  const controller = new AbortController(); let finish;
  const scan = scanPairingCamera(() => new Promise(resolve => { finish = resolve; }), controller.signal);
  controller.abort(); finish({ ok: true, cancelled: false, value: link });
  await assert.rejects(scan, { name: 'AbortError' });
});
