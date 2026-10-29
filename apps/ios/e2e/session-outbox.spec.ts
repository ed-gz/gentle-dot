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
