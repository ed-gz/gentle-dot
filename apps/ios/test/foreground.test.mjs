import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForForeground } from '../src/foreground.ts';
import { createAgentRunner } from '../src/agent-runner.ts';

class Page extends EventTarget { hidden = true; }
const answer = { ok: true, decision: { kind: 'answer', text: 'Terminó', toolName: '', argumentsJSON: '{}' } };
test('a hidden turn waits for visibility, cleans listeners and can still be explicitly stopped', async () => {
  const page = new Page(), controller = new AbortController(); let finished = false;
  const waiting = waitForForeground(controller.signal, page).then(() => { finished = true; });
  page.dispatchEvent(new Event('visibilitychange'));
  await Promise.resolve(); assert.equal(finished, false);
  page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));
  await waiting; assert.equal(finished, true);
  page.hidden = true;
  const stopped = waitForForeground(controller.signal, page);
  controller.abort(); await assert.rejects(stopped, { name: 'AbortError' });
  await assert.rejects(waitForForeground(controller.signal, page), { name: 'AbortError' });
});
test('an in-flight answer is kept; the next tool waits until Capri is visible', async () => {
  const page = new Page(); page.hidden = false;
  let calls = 0, executions = 0, release;
  const runner = createAgentRunner({ tools: [{ definition: { name: 'read', description: 'Leer', parameters: { type: 'object' } }, validate: value => value,
    execute: async () => { executions++; return { text: 'Leído' }; } }],
    waitUntilActive: signal => waitForForeground(signal, page), onTrace: () => {},
    step: async () => {
      calls++;
      if (calls === 1) return { ok: true, decision: { kind: 'tool', toolName: 'tool_describe', argumentsJSON: '{"name":"read"}', text: '' } };
      if (calls === 2) return new Promise(resolve => { release = () => resolve({ ok: true, decision: { kind: 'tool', toolName: 'read', argumentsJSON: '{}', text: '' } }); });
      return answer;
    } });
  const pending = runner.run({ instruction: 'Lee', context: '', signal: new AbortController().signal });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  page.hidden = true; release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(executions, 0); assert.equal(calls, 2);
  page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(await pending, 'Terminó'); assert.equal(executions, 1); assert.equal(calls, 3);
});
