import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readBuildStamp } from '../scripts/build-stamp.mjs';
import { parseBuildInfo, buildLabel } from '../src/build-info.ts';

test('installed build label identifies source and personal art without treating unknown data as verified', () => {
  const info = parseBuildInfo({ schemaVersion: 1, sourceCommit: 'a'.repeat(40), artworkSHA256: 'b'.repeat(64), dirty: false, token: 'ignored' });
  assert.equal(buildLabel(info), 'Capri aaaaaaaa · personal');
  assert.equal('token' in info, false); assert.equal(Object.isFrozen(info), true);
  assert.equal(buildLabel({ ...info, dirty: true }), 'Capri aaaaaaaa · personal · cambios locales');
  for (const input of [null, {}, { ...info, sourceCommit: 'abc' }, { ...info, artworkSHA256: 'invalid' }]) assert.equal(buildLabel(parseBuildInfo(input)), 'Capri · compilación sin identificar');
});

test('build stamp reads actual source checkout, detects changes, and rejects a companion-repository SHA', () => {
  const directory = mkdtempSync(join(tmpdir(), 'capri-build-stamp-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '--initial-branch=main'); writeFileSync(join(directory, 'source.txt'), 'fixture'); git('add', 'source.txt');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    const sha = git('rev-parse', 'HEAD');
    assert.deepEqual(readBuildStamp(directory, join(directory, 'absent'), sha), { schemaVersion: 1, sourceCommit: sha, dirty: false, artworkSHA256: null });
    assert.throws(() => readBuildStamp(directory, join(directory, 'absent'), '0'.repeat(40)), /requested personal build/);
    writeFileSync(join(directory, 'source.txt'), 'changed'); assert.equal(readBuildStamp(directory, join(directory, 'absent')).dirty, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
