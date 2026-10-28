import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nearConversationEnd } from '../src/conversation-view.ts';
import { replyBlocks, replyInline } from '../src/safe-reply.ts';

test('follow threshold tolerates fractional positions and overscroll without treating earlier reading as the end', () => {
  assert.equal(nearConversationEnd(0, 100, 300), true);
  assert.equal(nearConversationEnd(635.5, 1000, 300), false);
  assert.equal(nearConversationEnd(636, 1000, 300), true);
  assert.equal(nearConversationEnd(-50, 1000, 300), false);
  assert.equal(nearConversationEnd(900, 1000, 300), true);
});

test('reply blocks retain code literally and give decisions readable list structure', () => {
  assert.deepEqual(replyBlocks('# Acuerdos\n\n- Ana revisa\n- Fecha pendiente\n\n3. Tercer punto\n4. Cuarto punto\n\n> Propuesta\n> sin confirmar\n\n```sh\nrm -i "<archivo>"\n```'), [
    { kind: 'heading', text: 'Acuerdos' }, { kind: 'list', ordered: false, start: 1, items: ['Ana revisa', 'Fecha pendiente'] },
    { kind: 'list', ordered: true, start: 3, items: ['Tercer punto', 'Cuarto punto'] },
    { kind: 'quote', text: 'Propuesta\nsin confirmar' }, { kind: 'code', language: 'sh', text: 'rm -i "<archivo>"' },
  ]);
});

test('reply inline parser never converts model HTML, images or URLs to executable DOM instructions', () => {
  const input = '<img src=x onerror=alert(1)> [abrir](javascript:alert(1)) ![foto](https://remote.test/a.png)';
  assert.deepEqual(replyInline(input), [{ kind: 'text', text: input }]);
  assert.deepEqual(replyInline('**Confirmado** y `x < y` frente a *propuesta*'), [
    { kind: 'strong', text: 'Confirmado' }, { kind: 'text', text: ' y ' }, { kind: 'code', text: 'x < y' },
    { kind: 'text', text: ' frente a ' }, { kind: 'em', text: 'propuesta' },
  ]);
});

test('unfinished fences remain readable and oversized input is never silently lost', () => {
  assert.deepEqual(replyBlocks('```json\n{"pending":true}'), [{ kind: 'code', text: '{"pending":true}', language: 'json' }]);
  const large = 'Información '.repeat(4000);
  assert.deepEqual(replyBlocks(large), [{ kind: 'paragraph', text: large }]);
  assert.deepEqual(replyBlocks('uno\r\ndos'), [{ kind: 'paragraph', text: 'uno\ndos' }]);
});
