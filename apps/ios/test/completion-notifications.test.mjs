import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mountCompletionNotifications, parseCompletionNotificationStatus } from '../src/completion-notifications.ts';

test('default preference remains visible without permission and never prompts at startup', async () => {
  const handlers = {}; const input = { addEventListener: (name, handler) => { handlers[name] = handler; } }; const message = {};
  const root = { querySelector: selector => selector === 'input' ? input : message };
  const calls = [];
  const settings = mountCompletionNotifications(root, { native: true,
    status: async () => ({ ok: true, enabled: false, preferred: true, authorization: 'not_determined' }),
    configure: async enabled => { calls.push(enabled); return { ok: true, enabled: false, preferred: enabled, authorization: 'not_determined' }; },
  });
  await settings.refresh();
  assert.equal(input.checked, true);
  assert.match(message.textContent, /activados.*iPhone.*aún no/i);
  assert.deepEqual(calls, []);
  input.checked = false; await handlers.change();
  assert.deepEqual(calls, [false]);
  assert.equal(input.checked, false);
});

test('native notification state requires consent and strips unrelated fields', () => {
  assert.deepEqual(parseCompletionNotificationStatus({ ok: true, enabled: true, authorization: 'authorized', token: 'discard' }), { enabled: true, authorization: 'authorized' });
  assert.deepEqual(parseCompletionNotificationStatus({ ok: true, enabled: false, authorization: 'denied' }), { enabled: false, authorization: 'denied' });
  for (const value of [null, [], {}, { ok: true, enabled: true, authorization: 'denied' }, { ok: true, enabled: true, authorization: 'unknown' }, { ok: false, enabled: true, authorization: 'authorized' }]) {
    assert.throws(() => parseCompletionNotificationStatus(value));
  }
});
