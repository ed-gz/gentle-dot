import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInvitation } from '../src/device-pairing.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const has = binary => spawnSync('which', [binary], { encoding: 'utf8' }).status === 0;

test('desktop QR command produces an iPhone-compatible invitation without starting Android', { skip: !has('qrencode') || !has('zbarimg') }, () => {
  const cache = join(root, '.cache'); mkdirSync(cache, { recursive: true });
  const tmp = mkdtempSync(join(cache, 'pairing-contract-'));
  try {
    const data = join(tmp, 'data'), output = join(tmp, 'out'); mkdirSync(data);
    writeFileSync(join(data, 'token'), 'fixture-only-device-token');
    const setup = join(tmp, 'network-fixture.mjs');
    writeFileSync(setup, `import child from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';\nconst spawn = child.spawnSync; child.spawnSync = (name, ...args) => { if (name !== 'qrencode') throw new Error('Unexpected subprocess'); return spawn(name, ...args); }; child.execFileSync = () => { throw new Error('Unexpected subprocess'); }; syncBuiltinESMExports();\nglobalThis.fetch = async (url) => {\n if (String(url).endsWith('/api/mobile/devices')) return Response.json({devices:[]});\n if (String(url).endsWith('/api/mobile/code')) return Response.json({code:'A'.repeat(32),expiresAt:'2030-01-01T00:00:00Z'});\n throw new Error('Unexpected URL');\n};\n`);
    const command = spawnSync(process.execPath, ['--import', setup, join(root, 'scripts/mobile/connect.mjs'), '--url', 'https://workstation.fixture.ts.net', '--output', output], {
      cwd: root, env: { ...process.env, GENTLE_DOT_DATA_DIR: data }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(command.status, 0, command.stderr);
    const decoded = spawnSync('zbarimg', ['--quiet', '--raw', join(output, 'gentle-dot-pair.png')], { encoding: 'utf8', timeout: 10000 });
    assert.equal(decoded.status, 0, decoded.stderr);
    const invitation = parseInvitation(decoded.stdout.trim());
    assert.equal(invitation.origin, 'https://workstation.fixture.ts.net'); assert.equal(invitation.code, 'A'.repeat(32));
    assert.equal(invitation.name, 'Gentle Dot');
    assert.ok(!command.stdout.includes('fixture-only-device-token'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
