import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('packaged background task configuration binds the allowed pattern to the actual app ID', () => {
  const verifier = fileURLToPath(new URL('../scripts/verify-ipa.py', import.meta.url));
  const python = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('verifier', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
valid = {'CFBundleIdentifier': 'dev.gentledot.capri', 'UIBackgroundModes': ['processing'],
         'BGTaskSchedulerPermittedIdentifiers': ['dev.gentledot.capri.capri-inference.*']}
module.verify_continued_inference(valid)
for change in ({'UIBackgroundModes': []}, {'BGTaskSchedulerPermittedIdentifiers': []},
               {'CFBundleIdentifier': 'rewritten.by.sideload'}, {'UIBackgroundModes': 'processing'},
               {'BGTaskSchedulerPermittedIdentifiers': 'dev.gentledot.capri.capri-inference.*'}):
    try: module.verify_continued_inference({**valid, **change})
    except ValueError: continue
    raise AssertionError('invalid configuration was accepted')
`;
  const result = spawnSync('python3', ['-B', '-c', python, verifier], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
