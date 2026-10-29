import { expect, test } from '@playwright/test';

const moduleUrl = `/@fs${process.cwd()}/packages/ui/src/session-delivery.ts`;

test('IndexedDB merges separate views and rejects stale writes', async ({ page, context }) => {
  await page.goto('/');
  const other = await context.newPage();
  await other.goto('/');
  const write = (target: typeof page, id: string) => target.evaluate(async ({ moduleUrl, id }) => {
    const store = await import(/* @vite-ignore */ moduleUrl);
    return store.persistDeliveries([{ id, identity: store.sessionDeliveryIdentity('', 'pane', 'session'), text: id, payload: id, createdAt: Date.now(), status: 'unconfirmed', baseline: new Set() }]);
  }, { moduleUrl, id });
  expect(await Promise.all([write(page, 'first'), write(other, 'second')])).toEqual([true, true]);
  const ids = await page.evaluate(async url => (await (await import(/* @vite-ignore */ url)).restoreDeliveries()).map((item: {id:string}) => item.id).sort(), moduleUrl);
  expect(ids).toEqual(['first', 'second']);
  const stale = await page.evaluate(async url => {
    const store = await import(/* @vite-ignore */ url);
    const [record] = (await store.restoreDeliveries()).filter((item: {id:string}) => item.id === 'first');
    const copy = {...record};
    const saved = await store.persistDeliveries([{...record, status:'dismissed'}]);
    const overwritten = await store.persistDeliveries([{...copy, status:'queued'}]);
    const after = (await store.restoreDeliveries()).find((item: {id:string}) => item.id === 'first');
    return {saved, overwritten, status:after.status};
  }, moduleUrl);
  expect(stale).toEqual({saved:true, overwritten:false, status:'dismissed'});
});

test('unreadable legacy data blocks writes and remains intact', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async url => {
    const store = await import(/* @vite-ignore */ url);
    localStorage.setItem('gentle-dot:session-outbox:v1', '{broken');
    let rejected = false;
    try { await store.restoreDeliveries(); } catch { rejected = true; }
    const saved = await store.persistDeliveries([{id:'pending', identity:'owner', text:'x', payload:'x', createdAt:Date.now(), status:'unconfirmed', baseline:new Set()}]);
    return {rejected, saved, raw:localStorage.getItem('gentle-dot:session-outbox:v1')};
  }, moduleUrl);
  expect(result).toEqual({rejected:true, saved:false, raw:'{broken'});
});

test('two views migrate legacy records without deleting or assigning their origin', async ({ page, context }) => {
  await page.goto('/');
  const other = await context.newPage();
  await other.goto('/');
  const raw = JSON.stringify([{id:'legacy-entry',identity:'a:b:c',text:'Revisar',payload:'original',createdAt:Date.now(),status:'unconfirmed',baseline:[]}]);
  await page.evaluate(value => localStorage.setItem('gentle-dot:session-outbox:v1', value), raw);
  const read = (target: typeof page) => target.evaluate(async url => {
    const store = await import(/* @vite-ignore */ url);
    return (await store.restoreDeliveries()).map((item: {id:string,identity:string,payload:string}) => ({id:item.id,identity:item.identity,payload:item.payload}));
  }, moduleUrl);
  const [a,b] = await Promise.all([read(page),read(other)]);
  expect(a).toEqual(b);
  expect(a).toEqual([{id:'legacy-entry',identity:'legacy:"a:b:c"',payload:'original'}]);
  expect(await page.evaluate(() => localStorage.getItem('gentle-dot:session-outbox:v1'))).toBe(raw);
});

test('a lost commit callback leaves the send unconfirmed and recoverable', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async url => {
    const store = await import(/* @vite-ignore */ url);
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
    const originalTimeout = window.setTimeout;
    let suppress = true;
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...descriptor, set(value) {
      if (suppress && this.db.name === 'gentle-dot:session-outbox:v2') { suppress = false; return; }
      descriptor.set!.call(this, value);
    }});
    window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => originalTimeout(fn, delay === 12_000 ? 200 : delay, ...args)) as typeof setTimeout;
    let saved = true;
    try {
      saved = await store.persistDeliveries([{id:'lost-callback',identity:'owner',text:'Guardado',payload:'Guardado',createdAt:Date.now(),status:'sending',baseline:new Set()}]);
    } finally {
      window.setTimeout = originalTimeout;
      Object.defineProperty(IDBTransaction.prototype, 'oncomplete', descriptor);
    }
    const recovered = (await store.restoreDeliveries()).find((item: {id:string}) => item.id === 'lost-callback');
    return {saved, status:recovered?.status, text:recovered?.text};
  }, moduleUrl);
  expect(result).toEqual({saved:false, status:'unconfirmed', text:'Guardado'});
});

test('full outbox blocks additions, keeps pending data and updates without scanning records', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async url => {
    const module = await import(/* @vite-ignore */ url);
    const open = indexedDB.open('gentle-dot:session-outbox:v2', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('deliveries');
    const db: IDBDatabase = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const owner = module.sessionDeliveryIdentity('', 'pane', 'session');
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('deliveries', 'readwrite'), store = tx.objectStore('deliveries');
      for (let i=0; i<module.MAX_OUTBOX_RECORDS; i++) {
        const id = `record-${i}`;
        store.put({id,identity:owner,text:'x',payload:i<2?'original':'',createdAt:1,status:i<2?'unconfirmed':'dismissed',baseline:[],storageVersion:0}, JSON.stringify([owner,id]));
      }
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    db.close();
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function() { throw new Error('A write must not read all payloads'); };
    try {
      const added = await module.persistDeliveries([{id:'new',identity:owner,text:'new',payload:'new',createdAt:1,status:'unconfirmed',baseline:new Set()}]);
      const updated = await module.persistDeliveries([{id:'record-0',identity:owner,text:'x',payload:'original',createdAt:1,status:'dismissed',baseline:new Set(),storageVersion:0}]);
      return {added,updated};
    } finally { IDBObjectStore.prototype.getAll = getAll; }
  }, moduleUrl);
  expect(result).toEqual({added:false,updated:true});
  const retained = await page.evaluate(async url => {
    const records = await (await import(/* @vite-ignore */ url)).restoreDeliveries();
    const pending = records.find((item: {id:string}) => item.id === 'record-1');
    return {count:records.length,status:pending.status,payload:pending.payload};
  }, moduleUrl);
  expect(retained).toEqual({count:10000,status:'unconfirmed',payload:'original'});
});
