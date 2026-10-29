import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createForegroundPage } from '../src/foreground-page.ts';

test('pagehide followed by visible before pageshow resumes the whole foreground once', () => {
  const page = createForegroundPage(); let calls = 0;
  page.pagehide();
  if (page.visibility(false)) calls++;
  assert.equal(calls, 0);
  if (page.pageshow(true, false)) calls++;
  if (page.visibility(false)) calls++;
  assert.equal(calls, 1); assert.equal(page.isSuspended(), false);
});
test('pageshow while hidden waits for visibility and resumes once', () => {
  const page = createForegroundPage(); let calls = 0;
  page.pagehide(); page.visibility(true);
  if (page.pageshow(true, true)) calls++;
  assert.equal(calls, 0);
  if (page.visibility(false)) calls++;
  assert.equal(calls, 1); assert.equal(page.isSuspended(), false);
});
test('normal foreground and independent explicit refresh still work', () => {
  const page = createForegroundPage();
  assert.equal(page.visibility(false), true);
  assert.equal(page.visibility(true), false);
  assert.equal(page.visibility(false), true);
  assert.equal(page.visibility(true), false);
  assert.equal(page.visibility(false), true);
});
