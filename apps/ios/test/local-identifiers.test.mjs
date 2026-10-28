import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localIdentifier } from '../src/local-identifiers.ts';
test('custom-origin UUID fallback uses cryptographic bytes with RFC version/variant bits', () => {
  assert.equal(localIdentifier({ getRandomValues(bytes) { bytes.fill(0xab); return bytes; } }), 'abababab-abab-4bab-abab-abababababab');
  assert.throws(() => localIdentifier({}), /seguro/);
  assert.match(localIdentifier(), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
