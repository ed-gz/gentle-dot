import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectionHealth, healthActionLabel } from '../src/connection-health.ts';
import { availabilityMessage, checkLocalIntelligence, parseAvailability } from '../src/local-intelligence.ts';

const available = { available: true, status: 'available', supportsSpanish: true };
const unavailable = status => ({ available: false, status, supportsSpanish: false });
const base = { local: available, linkedStatus: 'offline', hostConfigured: false };

test('standalone iPhone conversation never requires pairing or a saved credential', () => {
  for (const credentialState of ['missing', 'restoring', 'unavailable']) {
    const health = connectionHealth({ ...base, credentialState });
    assert.equal(health.canConverse, true); assert.equal(health.selectedEngine, 'iphone');
    assert.equal(health.primaryAction, undefined); assert.equal(health.work.state, 'offline');
  }
});
test('Apple setup is actionable and a bridge failure inside the app is not called a web preview', async () => {
  const browser = await checkLocalIntelligence({ native: false, call: () => { throw Error('must not invoke'); } });
  const native = await checkLocalIntelligence({ native: true, call: async () => { throw Error('native invocation denied'); } });
  assert.equal(browser.status, 'browser_preview'); assert.match(availabilityMessage(browser), /esta vista no ejecuta/);
  assert.equal(native.status, 'bridge_unavailable'); assert.doesNotMatch(availabilityMessage(native), /esta vista|navegador/);
  const health = connectionHealth({ ...base, local: unavailable('apple_intelligence_disabled') });
  assert.equal(health.canConverse, false); assert.equal(health.primaryAction, 'show-apple-setup');
  assert.equal(healthActionLabel(health.primaryAction), 'Preparar la IA del iPhone');
});
test('unanswered availability returns a recoverable timeout and ignores a late success', async () => {
  let finish;
  const result = await checkLocalIntelligence({ native: true, timeoutMs: 5, call: () => new Promise(resolve => { finish = resolve; }) });
  assert.equal(result.status, 'bridge_timeout'); finish(available);
  await Promise.resolve(); assert.equal(result.available, false);
  assert.equal((await checkLocalIntelligence({ native: true, call: async () => available })).available, true);
});
test('availability validation rejects malformed truthy flags and error responses claiming success', async () => {
  for (const value of [null, [], {}, { ...available, available: 'yes' }, { ...available, supportsSpanish: 1 },
    { ...available, status: 'sdk_unavailable' }, { ...available, status: '<script>' }, { ...available, supportsSpanish: false }]) {
    assert.equal(parseAvailability(value), undefined);
    assert.equal((await checkLocalIntelligence({ native: true, call: async () => value })).status, 'invalid_response');
  }
  assert.deepEqual(parseAvailability({ ...available, ignored: 'never retained' }), available);
});
test('automatic fallback uses ready Pi, while a manual engine choice remains explicit', () => {
  const input = { ...base, local: unavailable('model_not_ready'), linkedStatus: 'ready', agentState: 'idle' };
  const automatic = connectionHealth(input); assert.equal(automatic.canConverse, true); assert.equal(automatic.selectedEngine, 'gentle');
  const manual = connectionHealth({ ...input, preference: 'iphone' });
  assert.equal(manual.canConverse, false); assert.equal(manual.primaryAction, 'use-gentle');
  const phone = connectionHealth({ ...base, preference: 'gentle' }); assert.equal(phone.primaryAction, 'use-iphone');
});
test('old host capabilities do not disable ordinary chat, and stale flags do not survive offline', () => {
  const input = { ...base, local: unavailable('device_not_eligible'), linkedStatus: 'ready', agentState: 'idle' };
  const old = connectionHealth(input); assert.equal(old.canConverse, true); assert.match(old.work.detail, /Actualiza Gentle Dot/);
  const store = connectionHealth({ ...input, capabilities: { workSync: true, meetingDrafts: false } });
  assert.equal(store.canConverse, true); assert.match(store.work.detail, /todavía no ofrece minutas/);
  assert.equal(connectionHealth({ ...input, capabilities: { workSync: true, meetingDrafts: true } }).work.state, 'ready');
  assert.equal(connectionHealth({ ...input, linkedStatus: 'offline', capabilities: { workSync: true, meetingDrafts: true } }).work.state, 'offline');
});
test('socket authentication does not claim a starting or failed Pi is ready to converse', () => {
  for (const agentState of ['starting', 'restarting', 'error']) {
    const health = connectionHealth({ ...base, local: unavailable('model_not_ready'), linkedStatus: 'ready', agentState });
    assert.equal(health.canConverse, false); assert.notEqual(health.host.state, 'ready');
  }
  for (const agentState of ['thinking', 'working', 'needs_you'])
    assert.equal(connectionHealth({ ...base, linkedStatus: 'ready', agentState, preference: 'gentle' }).canConverse, true);
});
test('restoring, inaccessible Keychain, network failure and rejected access have distinct recovery', () => {
  const input = { ...base, hostConfigured: true };
  assert.equal(connectionHealth({ ...input, credentialState: 'restoring' }).host.state, 'checking');
  assert.match(connectionHealth({ ...input, credentialState: 'unavailable' }).host.detail, /Desbloquea/);
  assert.match(connectionHealth({ ...input, credentialState: 'missing' }).host.detail, /Vincula/);
  assert.match(connectionHealth({ ...input, credentialState: 'saved' }).host.detail, /sin conexión/);
  assert.equal(connectionHealth({ ...input, linkedStatus: 'rejected', credentialState: 'saved' }).host.action, 'show-pairing');
});
