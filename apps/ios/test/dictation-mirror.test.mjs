import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginDictationMirror, nextDictationMirror, releaseDictationMirror } from '../src/dictation-mirror.ts';

test('a preview is appended after the existing draft with the same separator the final insert uses', () => {
  const mirror = beginDictationMirror('Borrado previo');
  const step = nextDictationMirror(mirror, 'Borrado previo', 'primeras palabras', 2400);
  assert.equal(step.kind, 'mirror');
  assert.equal(step.text, 'Borrado previo\nprimeras palabras');
  const again = nextDictationMirror(step.mirror, step.text, 'primeras palabras y más', 2400);
  assert.equal(again.kind, 'mirror');
  assert.equal(again.text, 'Borrado previo\nprimeras palabras y más');
});

test('an empty draft keeps the preview unseparated', () => {
  const step = nextDictationMirror(beginDictationMirror(''), '', 'hola', 2400);
  assert.equal(step.kind, 'mirror');
  assert.equal(step.text, 'hola');
  // Whitespace-only draft: no visible content, so no separator. This is the
  // exact rule `insertNativeDictation` uses, which is what keeps the final text
  // from jumping to a different place than the preview occupied.
  const blank = nextDictationMirror(beginDictationMirror('   '), '   ', 'hola', 2400);
  assert.equal(blank.kind, 'mirror');
  assert.equal(blank.text, '   hola');
});

test('a foreign edit stops the mirror instead of overwriting what the person typed', () => {
  const mirror = beginDictationMirror('');
  const first = nextDictationMirror(mirror, '', 'parcial', 2400);
  assert.equal(first.kind, 'mirror');
  const edited = nextDictationMirror(first.mirror, 'parcial editado por mí', 'parcial nuevo', 2400);
  assert.equal(edited.kind, 'user-edited');
  assert.equal(releaseDictationMirror(first.mirror, 'parcial editado por mí'), 'parcial editado por mí');
});

test('a preview that would not fit never truncates the draft', () => {
  const step = nextDictationMirror(beginDictationMirror('base'), 'base', 'x'.repeat(40), 44);
  assert.equal(step.kind, 'too-long');
  assert.equal(releaseDictationMirror(beginDictationMirror('base'), 'base'), 'base');
});

test('releasing restores the original draft only while the mirror still owns the field', () => {
  const mirror = beginDictationMirror('Borrado previo');
  const step = nextDictationMirror(mirror, 'Borrado previo', 'parcial', 2400);
  assert.equal(step.kind, 'mirror');
  assert.equal(releaseDictationMirror(step.mirror, step.text), 'Borrado previo');
});
