import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('apps/ios/scripts/check-synthetic-speech-install.sh');
async function harness(t, probe) {
  const root = await mkdtemp(join(tmpdir(), 'capri-probe-watchdog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); await mkdir(bin);
  const put = async (name, body) => writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await put('uname', 'if [ "$1" = "-m" ]; then echo arm64; else echo Darwin; fi');
  await put('sw_vers', 'echo 26.0');
  await put('xcrun', `if [ "$3" = "--show-sdk-path" ]; then echo /tmp/sdk; exit 0; fi
while [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then shift; cp "$FAKE_PROBE" "$1"; chmod +x "$1"; exit 0; fi; shift; done
exit 1`);
  const fake = join(root, 'fake'); await writeFile(fake, `#!/bin/sh\nif [ "$1" = "--diagnostics-self-test" ]; then echo SELF_TEST_ONLY; exit 0; fi\n${probe}\n`, {mode:0o755});
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_PROBE: fake, TMPDIR: root };
  delete env.CAPRI_EPHEMERAL_SPEECH_INSTALL; delete env.CAPRI_SPEECH_INSTALL_COMPILE_ONLY; delete env.CAPRI_SPEECH_INSTALL_TIMEOUT_SECONDS;
  return env;
}

test('compile-only mode never invokes the installer probe', async t => {
  const env = await harness(t, 'echo SHOULD_NOT_RUN; exit 1'); env.CAPRI_SPEECH_INSTALL_COMPILE_ONLY = '1';
  const result = spawnSync('bash', [script], {env, encoding:'utf8', timeout:10_000});
  assert.equal(result.status, 0); assert.match(result.stdout, /compiled; no assets requested/); assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
});

test('watchdog reports an unconfirmed release and terminates a stalled probe', async t => {
  const env = await harness(t, 'sleep 30'); env.CAPRI_SPEECH_INSTALL_TIMEOUT_SECONDS = '1'; env.CAPRI_EPHEMERAL_SPEECH_INSTALL = '1';
  const result = spawnSync('bash', [script], {env, encoding:'utf8', timeout:10_000});
  assert.equal(result.status, 124); assert.match(result.stderr, /TIMEOUT:.*release was not confirmed/);
});

test('bad timeout fails before the installer can run', async t => {
  const env = await harness(t, 'echo SHOULD_NOT_RUN'); env.CAPRI_SPEECH_INSTALL_TIMEOUT_SECONDS = 'invalid'; env.CAPRI_EPHEMERAL_SPEECH_INSTALL = '1';
  const result = spawnSync('bash', [script], {env, encoding:'utf8', timeout:10_000});
  assert.equal(result.status, 2); assert.match(result.stderr, /no assets requested/); assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
});


test('download requires explicit ephemeral-runner opt-in', async t => {
  const env = await harness(t, 'echo SHOULD_NOT_RUN');
  const result = spawnSync('bash', [script], {env, encoding:'utf8', timeout:10_000});
  assert.equal(result.status, 0); assert.match(result.stdout, /opt-in was not set; no assets requested/); assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
});
