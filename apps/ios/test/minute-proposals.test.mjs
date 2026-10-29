import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMinuteProposal } from '../src/minute-proposals.ts';
const base = { workId: 'meeting-1', revision: 3, connectionId: '11111111-1111-4111-8111-111111111111', tool: 'mcp_0123456789abcdef01234567', description: 'Preparar seguimiento', arguments: { z: 1, a: 'texto' } };
test('proposal fields and canonical arguments are bounded and restricted', () => {
  assert.deepEqual(validateMinuteProposal(base), { workId: 'meeting-1', revision: 3, connectionId: base.connectionId, tool: base.tool, description: base.description, argumentsJSON: '{"a":"texto","z":1}' });
  for (const invalid of [ { ...base, token: 'not allowed' }, { ...base, revision: 0 }, { ...base, workId: '../x' }, { ...base, connectionId: 'not-a-connection' }, { ...base, tool: 'server-tool' }, { ...base, description: '' }, { ...base, arguments: { huge: 'x'.repeat(16001) } }, { ...base, arguments: { a: NaN } }, { ...base, arguments: { nested: { access_token: 'secret' } } }, { ...base, arguments: JSON.parse('{"__proto__":1}') } ]) assert.throws(() => validateMinuteProposal(invalid));
});
