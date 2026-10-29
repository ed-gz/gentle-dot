import { expect, test } from '@playwright/test';

test('two windows keep the losing writer’s events and draft after its page closes', async ({page,context}) => {
  await page.goto('/'); const other=await context.newPage(); await other.goto('/');
  const suffix=Date.now().toString(), name=`write-race-${suffix}`, archiveName=`write-archive-${suffix}`;
  const setup=(target:typeof page,letter:string) => target.evaluate(async ({name,archiveName,letter})=>{
    const {createConversationArchive}=await import('/src/conversation-archive.ts');
    const {createConversationJournal}=await import('/src/conversation-journal.ts');
    const {createJournalConversationPersistence}=await import('/src/journal-conversation-persistence.ts');
    const {createConversationWriteRescue}=await import('/src/conversation-write-rescue.ts');
    const archive=createConversationArchive({databaseName:archiveName}),journal=createConversationJournal({databaseName:name,archive}),rescue=createConversationWriteRescue({databaseName:name,archive});
    const readBase=()=>new Promise<any>((resolve,reject)=>{const open=indexedDB.open(name,1);open.onupgradeneeded=()=>open.result.createObjectStore('conversation');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('conversation','readonly'),read=tx.objectStore('conversation').get('current');read.onsuccess=()=>resolve(read.result);tx.oncomplete=()=>db.close();tx.onabort=()=>reject(tx.error);};});
    const writer=createJournalConversationPersistence({journal,readBase,writeRescue:rescue,writeRescueOwner:crypto.randomUUID()}); writer.bindBase(undefined);
    const entry={id:crypto.randomUUID(),engine:'iphone',role:'user',state:'complete',text:`Evento ${letter}`,at:1000};
    (window as any).testWriter={writer,entry,name,archiveName};
  },{name,archiveName,letter});
  await Promise.all([setup(page,'A'),setup(other,'B')]);
  const persist=(target:typeof page) => target.evaluate(async()=>{const {writer,entry}=(window as any).testWriter;await writer.persist({entries:[entry],draft:`Borrador ${entry.text}`});return {blocked:writer.status().blocked,entry};});
  const [a,b]=await Promise.all([persist(page),persist(other)]);
  expect([a.blocked,b.blocked].sort()).toEqual([false,true]);
  const loser=a.blocked?page:other, survivor=a.blocked?other:page, expected=a.blocked?a.entry:b.entry;
  const later=await loser.evaluate(async()=>{const {writer,entry}=(window as any).testWriter;const extra={...entry,id:crypto.randomUUID(),text:'Evento posterior'};await writer.persist({entries:[entry,extra],draft:'Borrador posterior'});return extra;});
  await loser.close();
  const recovered=await survivor.evaluate(async ({name,archiveName})=>{
    const {createConversationArchive}=await import('/src/conversation-archive.ts');const {createConversationWriteRescue}=await import('/src/conversation-write-rescue.ts');
    const archive=createConversationArchive({databaseName:archiveName}),store=createConversationWriteRescue({databaseName:name,archive});return store.list();
  },{name,archiveName});
  const copy=recovered.find((record:any)=>record.entries.some((entry:any)=>entry.id===expected.id));
  expect(copy.draft).toBe('Borrador posterior');
  expect(copy.entries.map((entry:any)=>entry.id)).toEqual(expect.arrayContaining([expected.id,later.id]));
});

test('a late retirement cannot delete a newer rescue copy', async ({page}) => {
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {createConversationWriteRescue}=await import('/src/conversation-write-rescue.ts');
    const name=`write-cas-${crypto.randomUUID()}`,owner=crypto.randomUUID();
    const archive={verifyExactBatch:async()=>true},store=createConversationWriteRescue({databaseName:name,archive});
    const first={schema:'capri-conversation-write-rescue/v1',owner,sequence:1,baseRevision:0,draft:'Primero',entries:[]};
    await store.save(first);await store.save({...first,sequence:2,draft:'Más reciente'});
    const retired=await store.retireIfCommitted(first,{entries:[],draft:'Primero',revision:1});
    return {retired,copies:await store.list()};
  });
  expect(result.retired).toBe(false);expect(result.copies[0]).toMatchObject({sequence:2,draft:'Más reciente'});
});

test('a rescue quota failure blocks reservation and keeps events in memory', async ({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {createJournalConversationPersistence}=await import('/src/journal-conversation-persistence.ts');
    let begins=0;
    const journal={pending:async()=>undefined,begin:async()=>{begins++;throw new Error('unexpected');},resume:async()=>{throw new Error('unexpected');}};
    const writeRescue={save:async()=>{throw new DOMException('Cuota','QuotaExceededError');},retireIfCommitted:async()=>false};
    const writer=createJournalConversationPersistence({journal,writeRescue});writer.bindBase(undefined);
    const entry={id:crypto.randomUUID(),engine:'iphone',role:'user',state:'complete',text:'Mensaje sin copia',at:1};
    await writer.persist({entries:[entry],draft:'Borrador'});return {status:writer.status(),pending:writer.pending(),begins};
  });
  expect(result.status.blocked).toBe(true);expect(result.status.conversationError).toContain('Cuota');
  expect(result.pending[0].text).toBe('Mensaje sin copia');expect(result.begins).toBe(0);
});

test('a confirmed winner can retire only its exact copy after archive and window agree', async ({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {createConversationWriteRescue}=await import('/src/conversation-write-rescue.ts');
    const name=`write-retire-${crypto.randomUUID()}`,owner=crypto.randomUUID(); let confirmed=false;
    const store=createConversationWriteRescue({databaseName:name,archive:{verifyExactBatch:async()=>confirmed}});
    const entry={id:crypto.randomUUID(),engine:'iphone',role:'user',state:'complete',text:'Guardado',at:1};
    const record={schema:'capri-conversation-write-rescue/v1',owner,sequence:1,baseRevision:0,draft:'Borrador',entries:[entry]};
    const snapshot={entries:[entry],draft:'Borrador',revision:1};await store.save(record);
    await new Promise<void>((resolve,reject)=>{const open=indexedDB.open(name,1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('conversation','readwrite');tx.objectStore('conversation').put(snapshot,'current');tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};});
    const withoutArchive=await store.retireIfCommitted(record,snapshot);confirmed=true;
    const retired=await store.retireIfCommitted(record,snapshot);
    return {withoutArchive,retired,remaining:await store.list()};
  });
  expect(result).toEqual({withoutArchive:false,retired:true,remaining:[]});
});

test('recovery export omits private transport and stale discard preserves the newer copy', async ({page})=>{
  await page.goto('/');
  await page.evaluate(async()=>{
    const {createConversationWriteRescue}=await import('/src/conversation-write-rescue.ts');
    const {mountConversationWriteRecovery}=await import('/src/conversation-write-recovery-view.ts');
    const owner=crypto.randomUUID(),store=createConversationWriteRescue({databaseName:`write-view-${crypto.randomUUID()}`});
    const record={schema:'capri-conversation-write-rescue/v1',owner,sequence:1,baseRevision:0,draft:'<b>Texto seguro</b>',entries:[{id:'host:wss://example.test/ws|main|m',engine:'gentle',role:'user',state:'complete',text:'Instrucción visible',transportText:'WRAPPER PRIVADO',at:1}]};
    await store.save(record);const root=document.createElement('section');root.id='test-write-recovery';document.body.append(root);
    const view=mountConversationWriteRecovery(root,{store,deliver:async(blob:Blob)=>{(window as any).testExport=await blob.text();return 'exported';}});
    (window as any).writeRecoveryFixture={store,record};await view.refresh();
  });
  const root=page.locator('#test-write-recovery');await root.locator('summary').first().click();
  await root.getByText('Ver contenido').click();await expect(root.locator('pre')).toContainText('<b>Texto seguro</b>');
  expect(await root.locator('b').count()).toBe(0);
  await root.getByRole('button',{name:'Exportar copia'}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).testExport)).toContain('Instrucción visible');
  expect(await page.evaluate(()=>(window as any).testExport)).not.toContain('WRAPPER PRIVADO');
  await page.evaluate(async()=>{const {store,record}=(window as any).writeRecoveryFixture;await store.save({...record,sequence:2,draft:'Copia posterior'});});
  await root.getByRole('button',{name:'Descartar copia'}).click();await root.getByRole('button',{name:'Sí, descartar esta copia'}).click();
  await expect(root.getByRole('status')).toContainText('La copia cambió');
  expect(await page.evaluate(async()=>{const {store}=(window as any).writeRecoveryFixture;return (await store.list())[0].draft;})).toBe('Copia posterior');
});

test('a saved losing copy becomes visible on app restart without merging it', async ({page})=>{
  await page.goto('/');
  await page.evaluate(async()=>{
    const {createConversationWriteRescue}=await import('/src/conversation-write-rescue.ts');
    await createConversationWriteRescue().save({schema:'capri-conversation-write-rescue/v1',owner:crypto.randomUUID(),sequence:1,baseRevision:0,draft:'Borrador de otra vista',entries:[{id:crypto.randomUUID(),engine:'iphone',role:'user',state:'complete',text:'Evento de otra vista',at:1}]});
  });
  await page.reload();
  const rescue=page.locator('.conversation-write-recovery');
  await expect(rescue.getByText('Copias de conversación por revisar')).toBeVisible();
  await rescue.getByText('Copias de conversación por revisar').click();await rescue.getByText('Ver contenido').click();
  await expect(rescue.locator('pre')).toContainText('Evento de otra vista');
  await expect(rescue.locator('pre')).toContainText('Borrador de otra vista');
  await expect(page.locator('#prompt')).not.toHaveValue('Borrador de otra vista');
});
