import { expect, test } from './fixtures.ts';

test('session voice insertion and identity commit atomically, with idempotent retry and destination isolation', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createSessionVoiceDrafts } = await import('/src/session-voice-drafts.ts');
    const store = createSessionVoiceDrafts({ databaseName: `session-draft-${crypto.randomUUID()}` });
    const a = `session:${'a'.repeat(64)}`, b = `session:${'b'.repeat(64)}`;
    const id = 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345', text = 'Dictado recuperado';
    const receipt = { schema:'capri-native-voice-receipt/v1', audio:{id, owner:'abcdef02-abcd-4bcd-8bcd-abcdef012345', destination:a, locale:'es-MX', kind:'speech', createdAt:1, state:'ready', byteCount:10, sha256:'a'.repeat(64)}, transcript:{sessionId:id,text,segments:[{text,startSeconds:0,endSeconds:1}],durationSeconds:1,locale:'es-MX',source:'apple-speech-analyzer'} } as const;
    const base = await store.read(a); const first = await store.save(a, base, 'Texto anterior');
    const inserted = await store.deliver(a, receipt, first);
    const edited = await store.save(a, inserted.draft, 'Edición posterior');
    const retry = await store.deliver(a, receipt, first);
    const cross = await Promise.allSettled([store.deliver(b, receipt, { revision:0, text:'' })]);
    const changed = structuredClone(receipt); (changed as any).transcript.text = 'Otro texto'; (changed as any).transcript.segments[0].text = 'Otro texto';
    const collision = await Promise.allSettled([store.deliver(a, changed, edited)]);
    return { inserted, retry, edited, other:await store.read(b), cross:cross[0].status, collision:collision[0].status };
  });
  expect(result).toMatchObject({ inserted:{ draft:{revision:2,text:'Texto anterior\nDictado recuperado'},alreadyDelivered:false }, retry:{ draft:{revision:3,text:'Edición posterior'},alreadyDelivered:true }, other:{revision:0,text:''}, cross:'rejected', collision:'rejected' });
});

test('concurrent edits and length limits preserve all committed data', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createSessionVoiceDrafts } = await import('/src/session-voice-drafts.ts');
    const name = `session-cas-${crypto.randomUUID()}`, a = `session:${'a'.repeat(64)}`, b = `session:${'b'.repeat(64)}`;
    const first = createSessionVoiceDrafts({databaseName:name}), second = createSessionVoiceDrafts({databaseName:name});
    const base = await first.read(a); const done = await first.save(a,base,'Edición de otra ventana');
    const id = 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345', text = 'Nueva voz';
    const receipt = { schema:'capri-native-voice-receipt/v1', audio:{id, owner:'abcdef02-abcd-4bcd-8bcd-abcdef012345', destination:a, locale:'es-MX', kind:'speech', createdAt:1, state:'ready', byteCount:10, sha256:'a'.repeat(64)}, transcript:{sessionId:id,text,segments:[{text,startSeconds:0,endSeconds:1}],durationSeconds:1,locale:'es-MX',source:'apple-speech-analyzer'} } as const;
    const stale = await Promise.allSettled([second.deliver(a,receipt,base)]);
    const tooLong = await Promise.allSettled([first.save(a,done,'X'.repeat(8001))]);
    const changedHost = await second.save(b,await second.read(b),'Otra laptop');
    return { stale:stale[0].status, tooLong:tooLong[0].status, saved:await first.read(a), changedHost };
  });
  expect(result).toEqual({ stale:'rejected', tooLong:'rejected', saved:{revision:1,text:'Edición de otra ventana'}, changedHost:{revision:1,text:'Otra laptop'} });
});

test('a failed marker write aborts the draft insertion and a retry succeeds after reload', async ({ page }) => {
  await page.goto('/'); const name = `session-abort-${crypto.randomUUID()}`, dest = `session:${'c'.repeat(64)}`;
  const id = 'ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345', text = 'Dictado';
  const receipt = { schema:'capri-native-voice-receipt/v1', audio:{id, owner:'abcdef02-abcd-4bcd-8bcd-abcdef012345', destination:dest, locale:'es-MX', kind:'speech', createdAt:1, state:'ready', byteCount:10, sha256:'a'.repeat(64)}, transcript:{sessionId:id,text,segments:[{text,startSeconds:0,endSeconds:1}],durationSeconds:1,locale:'es-MX',source:'apple-speech-analyzer'} } as const;
  const before = await page.evaluate(async ({ name, dest, receipt }) => {
    const { createSessionVoiceDrafts } = await import('/src/session-voice-drafts.ts'); const store = createSessionVoiceDrafts({databaseName:name});
    const base = await store.save(dest, await store.read(dest), 'Base');
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: any, key?: IDBValidKey) { if (typeof key === 'string' && key.startsWith('delivery:')) throw new DOMException('Cuota simulada', 'QuotaExceededError'); return Reflect.apply(original, this, key === undefined ? [value] : [value,key]); };
    const failed = await Promise.allSettled([store.deliver(dest,receipt,base)]);
    IDBObjectStore.prototype.put = original;
    return { result:failed[0].status, draft:await store.read(dest) };
  }, {name,dest,receipt});
  expect(before).toEqual({result:'rejected',draft:{revision:1,text:'Base'}});
  await page.reload();
  const after = await page.evaluate(async ({name,dest,receipt}) => { const {createSessionVoiceDrafts}=await import('/src/session-voice-drafts.ts'); const store=createSessionVoiceDrafts({databaseName:name}); return store.deliver(dest,receipt,await store.read(dest)); }, {name,dest,receipt});
  expect(after).toEqual({draft:{revision:2,text:'Base\nDictado'},alreadyDelivered:false});
});

test('voice insertion preserves all existing whitespace and retries do not append twice', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const {createSessionVoiceDrafts}=await import('/src/session-voice-drafts.ts'); const store=createSessionVoiceDrafts({databaseName:`spaces-${crypto.randomUUID()}`});
    const dest=`session:${'d'.repeat(64)}`, id='ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345', text='Dictado';
    const receipt={schema:'capri-native-voice-receipt/v1',audio:{id,owner:'abcdef02-abcd-4bcd-8bcd-abcdef012345',destination:dest,locale:'es-MX',kind:'speech',createdAt:1,state:'ready',byteCount:10,sha256:'a'.repeat(64)},transcript:{sessionId:id,text,segments:[{text,startSeconds:0,endSeconds:1}],durationSeconds:1,locale:'es-MX',source:'apple-speech-analyzer'}} as const;
    const prior=await store.save(dest,await store.read(dest),'  Notas  \n  '); const delivered=await store.deliver(dest,receipt,prior); const retry=await store.deliver(dest,receipt,prior);
    return {delivered,retry};
  });
  expect(result.delivered.draft.text).toBe('  Notas  \n  \nDictado');
  expect(result.retry).toEqual({draft:result.delivered.draft,alreadyDelivered:true});
});

test('a missing, corrupted or older draft cannot authorize receipt cleanup', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const {createSessionVoiceDrafts}=await import('/src/session-voice-drafts.ts'); const name=`session-corrupt-${crypto.randomUUID()}`, store=createSessionVoiceDrafts({databaseName:name});
    const dest=`session:${'e'.repeat(64)}`, id='ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345', text='Dictado';
    const receipt={schema:'capri-native-voice-receipt/v1',audio:{id,owner:'abcdef02-abcd-4bcd-8bcd-abcdef012345',destination:dest,locale:'es-MX',kind:'speech',createdAt:1,state:'ready',byteCount:10,sha256:'a'.repeat(64)},transcript:{sessionId:id,text,segments:[{text,startSeconds:0,endSeconds:1}],durationSeconds:1,locale:'es-MX',source:'apple-speech-analyzer'}} as const;
    const base=await store.save(dest,await store.read(dest),'Base'); await store.deliver(dest,receipt,base);
    const mutate=(value: unknown) => new Promise<void>((resolve,reject)=>{const open=indexedDB.open(name,1); open.onerror=()=>reject(open.error); open.onsuccess=()=>{const db=open.result, tx=db.transaction('drafts','readwrite'); if(value===undefined) tx.objectStore('drafts').delete(`draft:${dest}`); else tx.objectStore('drafts').put(value,`draft:${dest}`); tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};});
    const cases=[];
    for(const value of [undefined,{revision:1,text:'Versión anterior'},{revision:2,text:'Valido',unknown:true},{revision:2,text:'Texto alterado'}]) { await mutate(value); const delivered=await Promise.allSettled([store.delivered(dest,receipt),store.deliver(dest,receipt,base)]); cases.push(delivered.map(item=>item.status)); }
    return cases;
  });
  expect(result).toEqual([['rejected','rejected'],['rejected','rejected'],['rejected','rejected'],['rejected','rejected']]);
});

test('draft changes during asynchronous integrity hashing cannot authorize cleanup', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const {createSessionVoiceDrafts}=await import('/src/session-voice-drafts.ts'); const name=`hash-race-${crypto.randomUUID()}`,store=createSessionVoiceDrafts({databaseName:name}),dest=`session:${'f'.repeat(64)}`;
    const id='ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345',text='Dictado',receipt={schema:'capri-native-voice-receipt/v1',audio:{id,owner:'abcdef02-abcd-4bcd-8bcd-abcdef012345',destination:dest,locale:'es-MX',kind:'speech',createdAt:1,state:'ready',byteCount:10,sha256:'a'.repeat(64)},transcript:{sessionId:id,text,segments:[{text,startSeconds:0,endSeconds:1}],durationSeconds:1,locale:'es-MX',source:'apple-speech-analyzer'}} as const;
    const base=await store.save(dest,await store.read(dest),'Base'); await store.deliver(dest,receipt,base);
    let release!:()=>void, reached!:()=>void; const entered=new Promise<void>(resolve=>{reached=resolve;}); const original=crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest=async(algorithm:AlgorithmIdentifier,data:BufferSource)=>{const bytes=data instanceof ArrayBuffer?new Uint8Array(data):new Uint8Array(data.buffer,data.byteOffset,data.byteLength);if(new TextDecoder().decode(bytes)==='Base\nDictado'){reached();await new Promise<void>(resolve=>{release=resolve;});}return original(algorithm,data);};
    const pending=store.delivered(dest,receipt); await entered;
    await new Promise<void>((resolve,reject)=>{const open=indexedDB.open(name,1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put({revision:2,text:'Cambio concurrente'},`draft:${dest}`);tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};});
    release(); const settled=await Promise.allSettled([pending]);crypto.subtle.digest=original;return settled[0].status;
  });
  expect(result).toBe('rejected');
});
