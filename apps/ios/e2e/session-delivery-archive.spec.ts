import { expect, test } from '@playwright/test';
const moduleUrl = `/@fs${process.cwd()}/packages/ui/src/session-delivery.ts`;

test('verified archival survives reload and blocks a stale tab and late host receipt', async ({ page, context }) => {
  await page.goto('/'); const other = await context.newPage(); await other.goto('/');
  await page.evaluate(async url => {
    const store = await import(/* @vite-ignore */ url);
    await store.persistDeliveries([
      {id:'resolved',identity:'owner',text:'resolved',payload:'',createdAt:1,status:'dismissed',baseline:new Set()},
      {id:'pending',identity:'owner',text:'pending',payload:'unsent',createdAt:2,status:'unconfirmed',baseline:new Set()},
    ]);
  }, moduleUrl);
  await other.evaluate(async url => { const store = await import(/* @vite-ignore */ url); (window as any).staleDelivery = (await store.restoreDeliveries()).find((item: {id:string}) => item.id === 'resolved'); }, moduleUrl);
  const result = await page.evaluate(async url => {
    const store = await import(/* @vite-ignore */ url); const archive = await store.prepareDeliveryArchive();
    const selected = await new Blob([archive.bytes]).arrayBuffer();
    const count = await store.compactDeliveryArchive(archive, new Uint8Array(selected));
    return {count, sha256:archive.sha256};
  }, moduleUrl);
  expect(result.count).toBe(1); expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  const staleWrite = await other.evaluate(async url => { const store = await import(/* @vite-ignore */ url); return store.persistDeliveries([{...(window as any).staleDelivery, status:'unconfirmed'}]); }, moduleUrl);
  expect(staleWrite).toBe(false); await page.reload();
  const resultAfter = await page.evaluate(async url => {
    const store = await import(/* @vite-ignore */ url); const items = await store.restoreDeliveries();
    const combined = store.reconcileDeliveries(items, { messages:[], deliveries:[{id:'resolved',status:'queued',deliverAs:'steer',acceptedAt:new Date(1).toISOString()}] }, 'owner');
    return combined.map((item: {id:string,status:string,payload:string,archived?:boolean}) => ({id:item.id,status:item.status,payload:item.payload,archived:item.archived ?? false}));
  }, moduleUrl);
  expect(resultAfter).toEqual(expect.arrayContaining([{id:'resolved',status:'dismissed',payload:'',archived:true},{id:'pending',status:'unconfirmed',payload:'unsent',archived:false}]));
});

test('archiving a full outbox frees active capacity without touching pending records', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async url => {
    const store = await import(/* @vite-ignore */ url);
    // Open the actual v2 schema via the application before populating the synthetic limit.
    await store.restoreDeliveries();
    const open = indexedDB.open('gentle-dot:session-outbox:v2', 2);
    const db: IDBDatabase = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('deliveries','readwrite'), records = tx.objectStore('deliveries');
      for (let i = 0; i < store.MAX_OUTBOX_RECORDS; i++) {
        const id = `item-${i}`, status = i < 2 ? 'unconfirmed' : 'dismissed';
        records.put({id,identity:'owner',text:id,payload:i < 2 ? 'pending' : '',createdAt:i,status,baseline:[],storageVersion:0}, JSON.stringify(['owner',id]));
      }
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    }); db.close();
    const addedBefore = await store.persistDeliveries([{id:'new',identity:'owner',text:'x',payload:'x',createdAt:1,status:'unconfirmed',baseline:new Set()}]);
    const archive = await store.prepareDeliveryArchive(); const count = await store.compactDeliveryArchive(archive, archive.bytes.slice());
    const addedAfter = await store.persistDeliveries([{id:'new',identity:'owner',text:'x',payload:'x',createdAt:1,status:'unconfirmed',baseline:new Set()}]);
    const restored = await store.restoreDeliveries();
    return {addedBefore, count, addedAfter, markers:restored.filter((item: {archived?:boolean}) => item.archived).length,
      pending:restored.filter((item: {id:string}) => item.id === 'item-0' || item.id === 'item-1').map((item: {payload:string}) => item.payload)};
  }, moduleUrl);
  expect(result).toEqual({addedBefore:false,count:250,addedAfter:true,markers:250,pending:['pending','pending']});
});
