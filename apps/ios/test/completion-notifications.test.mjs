import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCompletionNotificationStatus } from '../src/completion-notifications.ts';

test('native notification state requires consent and strips unrelated fields', () => {
  assert.deepEqual(parseCompletionNotificationStatus({ ok: true, enabled: true, authorization: 'authorized', token: 'discard' }), { enabled: true, authorization: 'authorized' });
  assert.deepEqual(parseCompletionNotificationStatus({ ok: true, enabled: false, authorization: 'denied' }), { enabled: false, authorization: 'denied' });
  for (const value of [null, [], {}, { ok: true, enabled: true, authorization: 'denied' }, { ok: true, enabled: true, authorization: 'unknown' }, { ok: false, enabled: true, authorization: 'authorized' }]) {
    assert.throws(() => parseCompletionNotificationStatus(value));
  }
});
