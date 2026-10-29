import { execFile } from 'node:child_process';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { openIdentityBindingStore } from '../src/identity-binding-store.ts';
import { tempDir } from './helpers.ts';

const exec = promisify(execFile);
const modulePath = fileURLToPath(new URL('../src/identity-binding-store.ts',import.meta.url));
const binding = { scope:'host/session',liveId:'m-run:1',sessionId:'pi-session',entryId:'entry-a' };

it('persists only exact identities, allows idempotent retries and rejects both collision directions', () => {
  const path=join(tempDir(),'bindings.sqlite'); const store=openIdentityBindingStore(path);
  expect(store.bind(binding)).toBe('created'); expect(store.bind(binding)).toBe('existing');
  expect(()=>store.bind({...binding,entryId:'other'})).toThrow(/vinculada/);
  expect(()=>store.bind({...binding,liveId:'other'})).toThrow(/vinculada/);
  expect(()=>store.bind({...binding,entryId:''})).toThrow(/inválida/);
  expect(store.findLive(binding.scope,binding.liveId)).toEqual(binding); store.close();
  const reopened=openIdentityBindingStore(path); expect(reopened.findSource(binding.scope,binding.sessionId,binding.entryId)).toEqual(binding);
  expect(reopened.bind({...binding,scope:'another-session'})).toBe('created'); reopened.close();
  const raw=readFileSync(path).toString('utf8'); expect(raw).not.toContain('Repetir');
});

it('serializes conflicting processes so only one identity wins without deleting either source', async () => {
  const path=join(tempDir(),'bindings.sqlite'); const initial=openIdentityBindingStore(path); initial.close();
  const script=`const {openIdentityBindingStore}=await import(process.argv[1]);
    const s=openIdentityBindingStore(process.argv[2]);
    try { console.log(s.bind({scope:'same',liveId:'same-live',sessionId:'pi',entryId:process.argv[3]})); }
    catch { console.log('conflict'); } finally { s.close(); }`;
  const results=await Promise.all(['a','b'].map(id=>exec(process.execPath,['--input-type=module','-e',script,modulePath,path,id])));
  expect(results.map(result=>result.stdout.trim()).sort()).toEqual(['conflict','created']);
  const store=openIdentityBindingStore(path); const found=store.findLive('same','same-live');
  expect(['a','b']).toContain(found?.entryId); store.close();
});

it('two processes retrying an identical verified binding do not create a duplicate', async () => {
  const path=join(tempDir(),'bindings.sqlite');const initial=openIdentityBindingStore(path);initial.close();
  const script=`const {openIdentityBindingStore}=await import(process.argv[1]);
    const s=openIdentityBindingStore(process.argv[2]);console.log(s.bind({scope:'s',liveId:'live',sessionId:'pi',entryId:'entry'}));s.close();`;
  const results=await Promise.all([0,1].map(()=>exec(process.execPath,['--input-type=module','-e',script,modulePath,path])));
  expect(results.map(result=>result.stdout.trim()).sort()).toEqual(['created','existing']);
  const store=openIdentityBindingStore(path);expect(store.findSource('s','pi','entry')?.liveId).toBe('live');store.close();
});

it('rolls back a process that terminates with an uncommitted write', async () => {
  const path=join(tempDir(),'bindings.sqlite'); const initial=openIdentityBindingStore(path); initial.bind(binding); initial.close();
  const script=`import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO bindings(scope,live_id,session_id,entry_id) VALUES (?,?,?,?)').run('s','lost','pi','entry');process.exit(0);`;
  await exec(process.execPath,['--input-type=module','-e',script,path]);
  const store=openIdentityBindingStore(path); expect(store.findLive('s','lost')).toBeUndefined(); expect(store.findLive(binding.scope,binding.liveId)).toEqual(binding); store.close();
});

it('does not adopt a preexisting unrelated or linked file', () => {
  const root=tempDir(), existing=join(root,'unrelated'); writeFileSync(existing,'', {mode:0o600});
  expect(()=>openIdentityBindingStore(existing)).toThrow(/preexistente/); expect(readFileSync(existing).byteLength).toBe(0);
  const link=join(root,'link');symlinkSync(existing,link);
  expect(()=>openIdentityBindingStore(link)).toThrow(/regular/); expect(readFileSync(existing).byteLength).toBe(0);
});
