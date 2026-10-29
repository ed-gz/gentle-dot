import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { updateEntry, reconcileHostHistory, localPrompt, linkedPrompt, loadConversation, loadConversationBase, saveConversation } from '../src/conversation.ts';

const entry = (id, changes = {}) => ({ id, role: 'user', text: `Message ${id}`, engine: 'iphone', state: 'complete', at: 1, ...changes });
const previousIndexedDB = globalThis.indexedDB;
afterEach(() => { globalThis.indexedDB = previousIndexedDB; });

function storage(saved, pendingJournal) {
  let stored = saved;
  globalThis.indexedDB = {
    open() {
      const opening = {};
      queueMicrotask(() => {
        opening.result = {
          close() {},
          transaction() {
            let pending = 0, aborted = false;
            const transaction = {
              abort() { aborted = true; queueMicrotask(() => transaction.onabort?.()); },
              objectStore: () => ({
                get: key => request(() => key === 'current' ? stored : key === 'conversation-journal:v1' ? pendingJournal : undefined),
                put: value => request(() => { stored = structuredClone(value); return 'current'; }),
              }),
            };
            function request(read) {
              const result = {}; pending++;
              queueMicrotask(() => {
                if (aborted) return;
                result.result = read(); result.onsuccess?.(); pending--;
                if (!pending && !aborted) queueMicrotask(() => { if (!aborted && !pending) transaction.oncomplete?.(); });
              });
              return result;
            }
            return transaction;
          },
        };
        opening.onsuccess();
      });
      return opening;
    },
  };
  return () => stored;
}

test('finishing a streamed entry preserves its place and never mutates the prior snapshot', () => {
  const activity = { id: 't', title: 'Consulta', kind: 'read', status: 'done' };
  const original = [entry('1'), entry('2', { role: 'assistant', text: 'Partial', state: 'pending', at: 100, activities: [activity] }), entry('3')];
  const changed = updateEntry(original, entry('2', { role: 'assistant', text: 'Final', at: 200, activities: [activity] }));
  assert.deepEqual(changed.map(item => item.id), ['1', '2', '3']);
  assert.equal(changed[1].text, 'Final');
  assert.equal(changed[1].state, 'complete');
  assert.equal(changed[1].at, 100);
  assert.deepEqual(changed[1].activities, [activity]);
  assert.equal(original[1].text, 'Partial');
  assert.equal(original[1].state, 'pending');
});

test('only a new local assistant turn can retain a valid explicit request link', () => {
  const userId = '02bce422-1da0-4ebc-b2fb-9df32a25434e';
  const turnId = 'd3dba896-4b5c-4c1c-98c9-4e60238fe6b9';
  const linked = entry(turnId, { role: 'assistant', replyTo: userId });
  assert.equal(updateEntry([], linked)[0].replyTo, userId);
  for (const invalid of [
    { ...linked, replyTo: turnId }, { ...linked, replyTo: '../escape' },
    { ...linked, role: 'user' }, { ...linked, role: 'notice' }, { ...linked, engine: 'gentle' },
  ]) {
    const saved = updateEntry([], invalid)[0];
    assert.equal(saved.text, linked.text);
    assert.equal(Object.hasOwn(saved, 'replyTo'), false);
  }
  assert.equal(Object.hasOwn(updateEntry([], entry('historical'))[0], 'replyTo'), false);
  const timeline = updateEntry([], linked);
  const completed = updateEntry(timeline, { ...linked, replyTo: undefined, text: 'Terminada' });
  assert.equal(completed[0].replyTo, userId);
  const changed = updateEntry(completed, { ...linked, replyTo: 'a3dba896-4b5c-4c1c-98c9-4e60238fe6b9' });
  assert.equal(changed[0].replyTo, userId);
  assert.equal(changed[0].text, 'Terminada');
});

test('a newer visible snapshot cannot erase or replace an existing request link', async () => {
  const userId = '02bce422-1da0-4ebc-b2fb-9df32a25434e';
  const turnId = 'd3dba896-4b5c-4c1c-98c9-4e60238fe6b9';
  const turn = entry(turnId, { role: 'assistant', replyTo: userId });
  storage({ entries: [turn], draft: '', revision: 4 });
  for (const replacement of [{ ...turn, replyTo: undefined }, { ...turn, replyTo: 'a3dba896-4b5c-4c1c-98c9-4e60238fe6b9' }, { ...turn, role: 'notice' }]) {
    await assert.rejects(saveConversation({ entries: [replacement], draft: '', revision: 5 }), /vínculo/);
  }
  assert.equal((await loadConversation()).entries[0].replyTo, userId);
  await saveConversation({ entries: [], draft: '', revision: 5 }); // Normal window pruning.
});

test('the visible timeline remains bounded and rejects unknown metadata', () => {
  const original = Array.from({ length: 120 }, (_, index) => entry(String(index)));
  const next = updateEntry(original, entry('120', { text: 'a'.repeat(40000), token: 'never-store' }));
  assert.equal(next.length, 120);
  assert.equal(next[0].id, '1');
  assert.equal(next.at(-1).text.length, 32000);
  assert.equal(Object.hasOwn(next.at(-1), 'token'), false);
  assert.equal(original.length, 120);
});

test('local context includes only completed dialogue and excludes notices, interrupted text and private metadata', () => {
  const prompt = localPrompt([
    entry('1', { text: 'Original context' }),
    entry('2', { role: 'notice', text: 'AUTHORIZATION_NOTICE' }),
    entry('3', { role: 'assistant', state: 'pending', text: 'INCOMPLETE_OUTPUT' }),
    entry('4', { state: 'interrupted', text: 'UNCONFIRMED_INPUT' }),
    entry('5', { role: 'assistant', engine: 'gentle', text: 'Completed remote reply', token: 'PRIVATE_TOKEN' }),
  ], 'Current instruction');
  assert.match(prompt, /Original context/);
  assert.match(prompt, /Completed remote reply/);
  assert.ok(prompt.endsWith('Current instruction'));
  assert.doesNotMatch(prompt, /AUTHORIZATION_NOTICE|INCOMPLETE_OUTPUT|UNCONFIRMED_INPUT|PRIVATE_TOKEN/);
});

test('local prompt stays within 4000 Unicode scalars without cutting the current instruction', () => {
  const context = Array.from({ length: 4 }, (_, index) => entry(String(index), { text: '\u0000'.repeat(300) }));
  for (const instruction of ['a'.repeat(2400), 'b'.repeat(4000), '🦖'.repeat(4000)]) {
    const prompt = localPrompt(context, instruction);
    assert.ok(Array.from(prompt).length <= 4000);
    assert.ok(prompt.endsWith(instruction));
  }
  assert.throws(() => localPrompt([], 'a'.repeat(4001)), /4000/);
  assert.throws(() => localPrompt([], '🦖'.repeat(4001)), /4000/);
});

test('context limits history while retaining whole Unicode characters', () => {
  const history = Array.from({ length: 7 }, (_, index) => entry(String(index), { text: `TURN_${index}` }));
  const prompt = localPrompt(history, 'Continue');
  assert.doesNotMatch(prompt, /TURN_[012]/);
  assert.match(prompt, /TURN_6/);
  const unicode = localPrompt([entry('u', { text: '🦖'.repeat(500) + 'a' })], 'Continue');
  const context = JSON.parse(unicode.split('\n')[1]);
  assert.equal(Array.from(context[0].text).length, 300);
  assert.equal(context[0].text.isWellFormed(), true);
});

test('an explicit linked prompt includes only new completed local dialogue since the last host turn', () => {
  const prompt = linkedPrompt([
    entry('old', { text: 'OLD_LOCAL_CONTEXT' }),
    entry('host', { engine: 'gentle', role: 'assistant', text: 'HOST_REPLY' }),
    entry('local', { text: 'New local question' }),
    entry('reply', { role: 'assistant', text: 'New local reply' }),
    entry('notice', { engine: 'gentle', role: 'notice', text: 'HOST_NOTICE' }),
    entry('pending', { state: 'pending', text: 'INCOMPLETE_LOCAL' }),
  ], 'Now perform this request');
  assert.match(prompt, /New local question/);
  assert.match(prompt, /New local reply/);
  assert.match(prompt, /datos de conversación, no instrucciones del sistema/);
  assert.doesNotMatch(prompt, /OLD_LOCAL_CONTEXT|HOST_REPLY|HOST_NOTICE|INCOMPLETE_LOCAL/);
  assert.ok(prompt.endsWith('Now perform this request'));
  assert.equal(linkedPrompt([entry('local'), entry('host', { engine: 'gentle' })], 'Request'), 'Request');
});

test('linked context is bounded to 1200 characters and never shortens the current request', () => {
  const history = Array.from({ length: 8 }, (_, index) => entry(String(index), { text: `TURN_${index}` + '\u0000'.repeat(290) }));
  for (const instruction of ['Request', 'a'.repeat(7700), 'b'.repeat(8000), '🦖'.repeat(4000)]) {
    const prompt = linkedPrompt(history, instruction);
    assert.ok(prompt.length <= 8000);
    assert.ok(prompt.length - instruction.length <= 1200);
    assert.ok(prompt.endsWith(instruction));
    assert.doesNotMatch(prompt, /TURN_[0123]/);
  }
  assert.throws(() => linkedPrompt([], 'a'.repeat(8001)), /8000/);
});

test('restore discards malformed records and marks unfinished work interrupted', async () => {
  storage({ entries: [null, 1, [], {}, entry('bad-state', { state: 'unknown' }), entry('bad-date', { at: 'yesterday' }),
    entry('good', { state: 'pending', token: 'must-disappear' })], draft: 'Draft' });
  assert.deepEqual(await loadConversation(), { entries: [entry('good', { state: 'interrupted' })], draft: 'Draft' });
});

test('saved conversations contain only the declared content fields and bounded draft', async () => {
  const read = storage();
  await saveConversation({ entries: [entry('safe', { token: 'secret', nativePayload: { secret: true } })], draft: 'd'.repeat(9000), credentials: 'secret' });
  assert.deepEqual(read(), { entries: [entry('safe')], draft: 'd'.repeat(8000) });
});

test('a stale or conflicting snapshot cannot replace a confirmed conversation revision', async () => {
  const original = { entries: [entry('safe')], draft: 'Confirmado', revision: 12 };
  const read = storage(original);
  await assert.rejects(saveConversation({ ...original, draft: 'Antiguo', revision: 11 }), /revisión anterior/);
  await assert.rejects(saveConversation({ ...original, draft: 'Conflicto' }), /otros cambios/);
  await assert.rejects(saveConversation({ entries: [], draft: '' }), /revisión anterior/);
  assert.deepEqual(read(), original);
  await saveConversation(original);
  await saveConversation({ ...original, draft: 'Nuevo', revision: 13 });
  assert.equal(read().draft, 'Nuevo');
  assert.equal(read().revision, 13);
});

test('an unrecognized pending journal blocks window writes and preserves the original', async () => {
  const original = { entries: [entry('original')], draft: 'No reemplazar', revision: 4 };
  const read = storage(original, { malformed: true });
  await assert.rejects(saveConversation({ entries: [], draft: 'Otro', revision: 5 }), /reserva de conversación pendiente/);
  assert.deepEqual(read(), original);
});

test('the journal reads an exact unprojected base and rejects fields it cannot preserve', async () => {
  const original = { entries: [entry('pending', { role: 'assistant', state: 'pending' })], draft: 'Escrito', revision: 3 };
  storage(original);
  assert.deepEqual(await loadConversationBase(), original);
  assert.equal((await loadConversation()).entries[0].state, 'interrupted');
  const read = storage({ ...original, customField: 'no descartar' });
  await assert.rejects(loadConversationBase(), /no se pueden conservar/);
  assert.equal(read().customField, 'no descartar');
});

test('transport text survives storage for history reconciliation but stays bounded and out of context', async () => {
  const read = storage();
  await saveConversation({ entries: [entry('wire', { engine: 'gentle', transportText: 'w'.repeat(40000) })], draft: '' });
  assert.equal(read().entries[0].transportText.length, 32000);
  const saved = await loadConversation();
  assert.equal(saved.entries[0].transportText, 'w'.repeat(32000));
  assert.doesNotMatch(localPrompt(saved.entries, 'Continue'), /wwww/);
  const updated = updateEntry([], entry('safe', { transportText: { token: 'invalid' } }));
  assert.equal(Object.hasOwn(updated[0], 'transportText'), false);
});

test('a partial update cannot erase or replace an existing host transport alias', async () => {
  const original = entry('host:wss://example.test/ws|main|message', { engine: 'gentle', role: 'user', text: 'Mensaje', transportText: 'Contexto\nMensaje', at: 10 });
  const { transportText: _alias, ...partial } = original;
  const updated = updateEntry([original], { ...partial, text: 'Mensaje visible', at: 20 });
  assert.equal(updated[0].transportText, original.transportText);
  assert.equal(updated[0].at, 10);
  for (const changed of [{ ...original, transportText: 'Contexto distinto' }, { ...original, role: 'assistant' }, { ...original, engine: 'iphone' }]) {
    assert.equal(updateEntry(updated, changed), updated);
  }
  const read = storage({ entries: [original], draft: '', revision: 1 });
  for (const changed of [{ ...partial }, { ...original, transportText: 'otro' }, { ...original, role: 'assistant' }]) {
    await assert.rejects(saveConversation({ entries: [changed], draft: '', revision: 2 }), /contexto de transporte/);
  }
  assert.equal(read().entries[0].transportText, original.transportText);
  await saveConversation({ entries: updated, draft: '', revision: 2 });
  assert.equal((await loadConversation()).entries[0].transportText, original.transportText);
});

const host = 'host:wss://fixture.example/ws|c1|';
const remote = (id, changes = {}) => entry(host + id, { engine: 'gentle', ...changes });
const snapshot = (id, role, text) => ({ id, role, text });

test('history does not claim an ambiguous pending input but keeps its transport wrapper private', () => {
  const original = [entry('local1'), remote('pending:one', { text: 'Request', transportText: 'Local context\nRequest', state: 'interrupted' }), entry('local2')];
  const result = reconcileHostHistory(original, host, [snapshot('h1', 'user', 'Local context\nRequest')]);
  assert.deepEqual(result.map(item => item.id), ['local1', host + 'pending:one', 'local2', host + 'h1']);
  assert.equal(result[1].state, 'interrupted');
  assert.equal(result[3].text, 'Request'); assert.equal(result[3].transportText, 'Local context\nRequest');
  assert.deepEqual(reconcileHostHistory(result, host, [snapshot('h1','user','Local context\nRequest')]), result);
});

test('history preserves live fragments and local dialogue when source IDs differ', () => {
  const original = [remote('u1', { text: 'Request' }), remote('m2', { role: 'assistant', text: 'First part' }),
    entry('local-between'), remote('m3', { role: 'assistant', text: 'Final part' }), entry('local-after')];
  const history = [snapshot('h1', 'user', 'Request'), snapshot('h2', 'assistant', 'First part\n\nFinal part')];
  const result = reconcileHostHistory(original, host, history);
  assert.deepEqual(result.map(item => item.id), [host+'u1', host+'m2', 'local-between', host+'m3', 'local-after', host+'h1', host+'h2']);
  assert.deepEqual(reconcileHostHistory(result, host, history), result);
});

test('an exact recovered partial assistant keeps its uncertain outcome until a terminal event', () => {
  const original = [remote('h1', { text: 'Request' }), remote('h2', { role: 'assistant', text: 'Partial', state: 'interrupted' })];
  const result = reconcileHostHistory(original, host, [snapshot('h1', 'user', 'Request'), snapshot('h2', 'assistant', 'Partial recovered text')]);
  assert.equal(result.length, 2); assert.equal(result[1].text, 'Partial recovered text');
  assert.equal(result[1].state, 'interrupted'); assert.doesNotMatch(localPrompt(result, 'Continue'), /Partial recovered/);
});

test('history inserts missed older turns before their exact known successor and never mixes another host or session', () => {
  const foreign = entry('host:wss://different.example/ws|c1|h1', { engine: 'gentle', text: 'Earlier' });
  const original = [foreign, entry('local'), remote('h3', { text: 'Known request' }), remote('h4', { role: 'assistant', text: 'Known reply' })];
  const history = [snapshot('h1', 'user', 'Earlier'), snapshot('h2', 'assistant', 'Earlier reply'),
    snapshot('h3', 'user', 'Known request'), snapshot('h4', 'assistant', 'Known reply')];
  const result = reconcileHostHistory(original, host, history);
  assert.deepEqual(result.map(item => item.text), ['Earlier', 'Message local', 'Earlier', 'Earlier reply', 'Known request', 'Known reply']);
  assert.deepEqual(result[0], foreign); assert.deepEqual(result.slice(2).map(item => item.id), ['h1','h2','h3','h4'].map(id => host + id));
});

test('identical host turns with different IDs are preserved and do not multiply on repeated snapshots', () => {
  const original = [remote('u1', { text: 'Repeat' }), remote('m2', { role: 'assistant', text: 'Same' }),
    remote('u3', { text: 'Repeat' }), remote('m4', { role: 'assistant', text: 'Same' })];
  const history = [snapshot('h1','user','Repeat'), snapshot('h2','assistant','Same'), snapshot('h3','user','Repeat'), snapshot('h4','assistant','Same')];
  const result = reconcileHostHistory(original, host, history);
  assert.deepEqual(result.map(item=>item.id), ['u1','m2','u3','m4','h1','h2','h3','h4'].map(id=>host+id));
  assert.deepEqual(reconcileHostHistory(result, host, history), result);
});

test('history preserves live tool evidence when a snapshot has no activity records', () => {
  const activity = { id: 'tool-1', title: 'Buscar evidencia', kind: 'search', status: 'done', detail: 'Archivo encontrado' };
  const original = [remote('user-live', { text: 'Consulta' }), remote('answer-live', { role: 'assistant', text: 'Resultado', activities: [activity] })];
  const result = reconcileHostHistory(original, host, [snapshot('history-user', 'user', 'Consulta'), { ...snapshot('history-answer', 'assistant', 'Resultado'), activities: [] }]);
  assert.deepEqual(result[1].activities, [activity]);
  assert.deepEqual(reconcileHostHistory(result, host, [{ ...snapshot('history-user', 'user', 'Consulta'), activities: [] }, { ...snapshot('history-answer', 'assistant', 'Resultado'), activities: [] }]), result);
});

test('older repeated text cannot steal the identity of a later known historical message', () => {
  const original = [entry('local-before'), remote('h3', { text: 'Repetir', at: 300 }), remote('h4', { role: 'assistant', text: 'Respuesta actual', at: 400 }), entry('local-after')];
  const history = [snapshot('h1', 'user', 'Repetir'), snapshot('h2', 'assistant', 'Respuesta anterior'), snapshot('h3', 'user', 'Repetir'), snapshot('h4', 'assistant', 'Respuesta actual')];
  const result = reconcileHostHistory(original, host, history, 900);
  assert.deepEqual(result.map(item => item.id), ['local-before', host + 'h1', host + 'h2', host + 'h3', host + 'h4', 'local-after']);
  assert.equal(result.find(item => item.id === host + 'h3').at, 300);
  assert.deepEqual(reconcileHostHistory(result, host, history, 1000), result);
});

test('history merges tool activity by identity without losing detail or regressing a terminal result', () => {
  const original = [remote('h1', { text: 'Consulta' }), remote('h2', { role: 'assistant', text: 'Resultado', activities: [
    { id: 'a', title: 'Leer', kind: 'read', status: 'done', detail: 'Resultado conservado' },
    { id: 'b', title: 'Buscar', kind: 'search', status: 'running' },
  ] })];
  const result = reconcileHostHistory(original, host, [snapshot('h1', 'user', 'Consulta'), { ...snapshot('h2', 'assistant', 'Resultado'), activities: [
    { id: 'a', title: 'Leer', kind: 'read', status: 'running' },
    { id: 'b', title: 'Buscar', kind: 'search', status: 'done', detail: 'Listo' },
    { id: 'c', title: 'Revisar', kind: 'other', status: 'done' },
  ] }]);
  assert.deepEqual(result[1].activities, [
    { id: 'a', title: 'Leer', kind: 'read', status: 'done', detail: 'Resultado conservado' },
    { id: 'b', title: 'Buscar', kind: 'search', status: 'done', detail: 'Listo' },
    { id: 'c', title: 'Revisar', kind: 'other', status: 'done' },
  ]);
});
