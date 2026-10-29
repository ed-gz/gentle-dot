import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';
import { pageBranchHistory, lastIndexedPiEntry } from '../src/branch-history.ts';
import { pageHistory } from '../src/conversations.ts';
import { tempDir } from './helpers.ts';

it('projects the actual live leaf of a real Pi tree and paginates stable source IDs', () => {
  const dir = tempDir(), manager = SessionManager.create(dir, dir);
  const root = manager.appendMessage({ role: 'user', content: 'Root', timestamp: 1 });
  const abandoned = manager.appendMessage({ role: 'user', content: 'Abandoned', timestamp: 2 });
  manager.branch(root);
  const current = manager.appendMessage({ role: 'user', content: 'Current', timestamp: 3 });
  const file = manager.getSessionFile()!;
  expect(lastIndexedPiEntry(file)).toEqual({ id: current, sessionId: manager.getSessionId(), exists: true, legacy: false, hasFork: true });
  const page = pageBranchHistory([file], 1, current);
  expect(page.messages.map(m => m.text)).toEqual(['Current']); expect(page.hasEarlier).toBe(true);
  const previous = pageBranchHistory([file], 1, current, page.messages[0]!.id);
  expect(previous.messages.map(m => m.text)).toEqual(['Root']); expect(previous.hasEarlier).toBe(false);
  const other = pageBranchHistory([file], 20, abandoned);
  expect(other.messages.map(m => m.text)).toEqual(['Root', 'Abandoned']);
  expect(other.messages[0]!.id).toBe(previous.messages[0]!.id);
  expect(other.messages[1]!.id).not.toBe(page.messages[0]!.id);
  expect(pageBranchHistory([file], 20, root).messages.map(m => m.text)).toEqual(['Root']);
  expect(() => pageBranchHistory([file], 20, abandoned, page.messages[0]!.id)).toThrow(/cursor/);
});

it('labels an unverified legacy parent separately from a newer active branch', () => {
  const dir = tempDir(), legacy = join(dir, 'legacy.jsonl');
  writeFileSync(legacy, [JSON.stringify({ type: 'session', version: 3 }), JSON.stringify({ type: 'message', message: { role: 'user', content: 'Old' } })].join('\n') + '\n');
  const manager = SessionManager.create(dir, dir), root = manager.appendMessage({ role: 'user', content: 'Root', timestamp: 1 });
  manager.appendMessage({ role: 'user', content: 'Abandoned', timestamp: 2 }); manager.branch(root);
  const current = manager.appendMessage({ role: 'user', content: 'Current', timestamp: 3 });
  const page = pageBranchHistory([legacy, manager.getSessionFile()!], 10, current);
  expect(page.messages.map(message => message.text)).toEqual(['Old', 'Root', 'Current']);
  expect(page.messages[0]).toMatchObject({ id: 's0-1', earlier: true, branchUnverified: true });
  expect(page.messages[1]!.branchUnverified).toBeUndefined();
});

it('does not infer the selected leaf of an archived branched session from its last record', () => {
  const dir = tempDir(), old = SessionManager.create(dir, dir);
  const root = old.appendMessage({ role: 'user', content: 'Root', timestamp: 1 });
  old.appendMessage({ role: 'user', content: 'A', timestamp: 2 }); old.branch(root);
  old.appendMessage({ role: 'user', content: 'B', timestamp: 3 });
  const next = SessionManager.create(dir, dir), leaf = next.appendMessage({ role: 'user', content: 'New', timestamp: 4 });
  const page = pageBranchHistory([old.getSessionFile()!, next.getSessionFile()!], 10, leaf);
  expect(page.messages.map(message => message.text)).toEqual(['Root', 'A', 'B', 'New']);
  expect(page.messages.slice(0, 3).every(message => message.earlier && message.branchUnverified)).toBe(true);
  expect(page.messages.at(-1)!.branchUnverified).toBeUndefined();
});

it('does not infer a linear parent leaf after an in-memory branch without an append', () => {
  const dir = tempDir(), old = SessionManager.create(dir, dir);
  const root = old.appendMessage({ role: 'user', content: 'Root', timestamp: 1 });
  old.appendMessage({ role: 'user', content: 'Not on live leaf', timestamp: 2 }); old.branch(root);
  const next = SessionManager.create(dir, dir), leaf = next.appendMessage({ role: 'user', content: 'New', timestamp: 4 });
  const page = pageBranchHistory([old.getSessionFile()!, next.getSessionFile()!], 10, leaf);
  expect(page.messages.map(message => message.text)).toEqual(['Root', 'Not on live leaf', 'New']);
  expect(page.messages.slice(0, 2).every(message => message.earlier && message.branchUnverified)).toBe(true);
  const legacyCompatible = pageHistory([old.getSessionFile()!, next.getSessionFile()!], 10);
  expect(legacyCompatible.messages.slice(0, 2).every(message => message.earlier && message.branchUnverified)).toBe(true);
  expect(legacyCompatible.messages.at(-1)!.branchUnverified).toBeUndefined();
});

it('rejects missing, repeated, cyclic and unrecognised identities instead of choosing a branch', () => {
  const dir = tempDir(), file = join(dir, 'bad.jsonl');
  const save = (entries: unknown[]) => writeFileSync(file, [JSON.stringify({ type: 'session', id: 'synthetic-session', version: 3 }), ...entries.map(e => JSON.stringify(e))].join('\n') + '\n');
  const entry = (id: string, parentId: string | null) => ({ type: 'message', id, parentId, message: { role: 'user', content: id } });
  save([entry('one', null), entry('one', null)]); expect(() => pageBranchHistory([file], 10, 'one')).toThrow(/ambigua/);
  save([entry('one', 'missing')]); expect(() => pageBranchHistory([file], 10, 'one')).toThrow(/incompleta/);
  save([{ type: 'message', id: 'one', message: { role: 'user', content: 'one' } }]); expect(() => pageBranchHistory([file], 10, 'one')).toThrow(/padre inválidos/);
  save([entry('one', 'two'), entry('two', 'one')]); expect(() => pageBranchHistory([file], 10, 'one')).toThrow(/ambigua/);
  save([entry('one', null)]); expect(() => pageBranchHistory([file], 10, 'unknown')).toThrow(/incompleta/);
  writeFileSync(file, `${JSON.stringify({ type: 'session', id: 'synthetic-session', version: 3 })}\n${JSON.stringify(entry('one', null))}\nmalformed\n`);
  expect(() => pageBranchHistory([file], 10, 'one')).toThrow(/dañados/);
});

it('does not reuse a branch message ID when the same entry identity has changed bytes', () => {
  const dir = tempDir(), file = join(dir, 'changing.jsonl');
  const write = (text: string) => writeFileSync(file, `${JSON.stringify({ type: 'session', id: 'synthetic-session', version: 3 })}\n${JSON.stringify({ type: 'message', id: 'same-id', parentId: null, message: { role: 'user', content: text } })}\n`);
  write('First'); const first = pageBranchHistory([file], 10, 'same-id').messages[0]!;
  write('Changed'); const changed = pageBranchHistory([file], 10, 'same-id').messages[0]!;
  expect(changed.id).not.toBe(first.id); expect(changed.text).toBe('Changed');
  expect(() => pageBranchHistory([file], 10, 'same-id', first.id)).toThrow(/cursor/);
});

it('detects rewritten ancestor metadata even when a later append keeps the old tail intact', () => {
  const dir = tempDir(), file = join(dir, 'rewrite.jsonl');
  const header = { type: 'session', id: 'synthetic-session', version: 3 };
  const root = { type: 'message', id: 'root1', parentId: null, message: { role: 'user', content: 'Root' } };
  const meta = { type: 'model_change', id: 'meta1', parentId: 'root1' };
  const leaf = { type: 'message', id: 'leaf1', parentId: 'meta1', message: { role: 'user', content: 'Leaf' } };
  const append = { type: 'custom', id: 'last1', parentId: 'leaf1' };
  const write = (entries: object[]) => writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  write([header, root, meta, leaf]); pageBranchHistory([file], 10, 'leaf1');
  write([header, root, { ...meta, parentId: 'other' }, leaf, append]);
  expect(() => pageBranchHistory([file], 10, 'leaf1')).toThrow(/cambió/);
});

it('keeps tool-result chains in the selected assistant turn and gives changed branches distinct identities', () => {
  const dir = tempDir(), file = join(dir, 'tools.jsonl');
  const record = (id: string, parentId: string | null, message: object) => ({ type: 'message', id, parentId, message });
  const entries = [
    { type: 'session', id: 'synthetic-session', version: 3 },
    record('root', null, { role: 'user', content: 'Question' }),
    record('call', 'root', { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'Checking' }, { type: 'toolCall', id: 'tool-id', name: 'read', arguments: { path: 'synthetic' } }] }),
    record('result', 'call', { role: 'toolResult', toolCallId: 'tool-id', toolName: 'read', content: [{ type: 'text', text: 'result' }] }),
    record('answer-a', 'result', { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Answer A' }] }),
    record('answer-b', 'result', { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Answer B' }] }),
  ];
  writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const a = pageBranchHistory([file], 10, 'answer-a'), b = pageBranchHistory([file], 10, 'answer-b');
  expect(a.messages.map(message => message.text)).toEqual(['Question', 'Checking\n\nAnswer A']);
  expect(b.messages.map(message => message.text)).toEqual(['Question', 'Checking\n\nAnswer B']);
  expect(a.messages[1]!.id).not.toBe(b.messages[1]!.id);
  expect(a.messages[1]!.activities).toHaveLength(1); expect(b.messages[1]!.activities).toHaveLength(1);
});
