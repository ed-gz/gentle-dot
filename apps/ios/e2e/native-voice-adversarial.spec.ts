import { test, expect } from '@playwright/test';
test('older queued snapshot must not overwrite a later delivered dictation', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts' as string);
    let committed: any; let reserved: any; const writes: any[] = [];
    const journal = {
      pending: async () => reserved,
      begin: async (op: any) => { reserved = structuredClone(op); writes.push({ draft: op.snapshot.draft, voice: !!op.voiceDelivery }); return reserved; },
      resume: async (id: string) => { if (reserved?.id !== id) throw Error('unexpected'); committed = reserved.snapshot; reserved = undefined; return { id, revision: committed.revision, alreadyCommitted: false }; },
    };
    const writer = createJournalConversationPersistence({ journal, readBase: async () => committed, identifier: () => crypto.randomUUID() });
    writer.bindBase(undefined);
    const earlier = writer.persist({ entries: [], draft: 'Texto anterior' });
    const voice = writer.persist({ entries: [], draft: 'Texto anterior\nDictado nuevo' }, { sessionId: crypto.randomUUID(), receiptSHA256: 'a'.repeat(64), priorDraft: 'Texto anterior', transcript: 'Dictado nuevo' });
    await Promise.all([earlier, voice]);
    return { writes, committed, status: writer.status() };
  });
  expect(result.committed.draft).toBe('Texto anterior\nDictado nuevo');
});
test('forged delivery intent is not evidence of the original receipt text', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createConversationJournal } = await import('/src/conversation-journal.ts' as string);
    const { createConversationArchive } = await import('/src/conversation-archive.ts' as string);
    const { prepareNativeVoiceDelivery, createNativeVoiceDelivery } = await import('/src/native-voice-delivery.ts' as string);
    const name = `audit-${crypto.randomUUID()}`, archiveName = `audit-archive-${crypto.randomUUID()}`;
    const id = crypto.randomUUID();
    const receipt = { schema:'capri-native-voice-receipt/v1', audio:{id,owner:crypto.randomUUID(),destination:'chat',locale:'es-MX',kind:'speech',createdAt:1,state:'ready',byteCount:3,sha256:'a'.repeat(64)}, transcript:{sessionId:id,text:'Texto real',segments:[{text:'Texto real',startSeconds:0,endSeconds:1}],durationSeconds:1,locale:'es-MX',source:'apple-speech-analyzer'} } as any;
    const intent = await prepareNativeVoiceDelivery(receipt, ''); intent.transcript = 'Texto alterado';
    const journal = createConversationJournal({databaseName:name,archive:createConversationArchive({databaseName:archiveName})}); const op=crypto.randomUUID();
    const begun = await Promise.allSettled([journal.begin({id:op,baseRevision:0,snapshot:{entries:[],draft:'Texto alterado',revision:1},pending:[],voiceDelivery:intent})]);
    return { begun:begun[0].status, delivered:await createNativeVoiceDelivery({databaseName:name}).delivered(receipt) };
  });
  expect(result.begun).toBe('rejected'); expect(result.delivered).toBe(false);
});
test('corrupting pending journal cannot authorize cleanup of the original receipt', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createConversationJournal } = await import('/src/conversation-journal.ts' as string);
    const { createConversationArchive } = await import('/src/conversation-archive.ts' as string);
    const { prepareNativeVoiceDelivery, createNativeVoiceDelivery } = await import('/src/native-voice-delivery.ts' as string);
    const name = `audit-corrupt-${crypto.randomUUID()}`, archiveName = `audit-archive-${crypto.randomUUID()}`;
    const id = crypto.randomUUID();
    const receipt = { schema:'capri-native-voice-receipt/v1', audio:{id,owner:crypto.randomUUID(),destination:'chat',locale:'es-MX',kind:'speech',createdAt:1,state:'ready',byteCount:3,sha256:'a'.repeat(64)}, transcript:{sessionId:id,text:'Texto real',segments:[{text:'Texto real',startSeconds:0,endSeconds:1}],durationSeconds:1,locale:'es-MX',source:'apple-speech-analyzer'} } as any;
    const intent = await prepareNativeVoiceDelivery(receipt, '');
    const journal = createConversationJournal({databaseName:name,archive:createConversationArchive({databaseName:archiveName})}); const op=crypto.randomUUID();
    await journal.begin({id:op,baseRevision:0,snapshot:{entries:[],draft:'Texto real',revision:1},pending:[],voiceDelivery:intent});
    await new Promise<void>((resolve,reject) => {const opening=indexedDB.open(name);opening.onerror=()=>reject(opening.error);opening.onsuccess=()=>{const db=opening.result,tx=db.transaction('conversation','readwrite'),s=tx.objectStore('conversation'),get=s.get('conversation-journal:v1');get.onsuccess=()=>{const x=get.result;x.snapshot.draft='Texto alterado';x.voiceDelivery.transcript='Texto alterado';x.voiceDelivery.receipt.transcript.text='Texto alterado';x.voiceDelivery.receipt.transcript.segments[0].text='Texto alterado';s.put(x,'conversation-journal:v1');};tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};});
    const outcome = await Promise.allSettled([journal.resume(op)]);
    return { outcome:outcome[0].status, delivered:await createNativeVoiceDelivery({databaseName:name}).delivered(receipt), pending:!!await journal.pending() };
  });
  expect(result).toEqual({outcome:'rejected',delivered:false,pending:true});
});
test('queued old draft, dictation, restart and later edit preserve exact durable delivery', async ({ page }) => {
  await page.goto('/');
  const setup = await page.evaluate(async () => {
    const { createConversationJournal } = await import('/src/conversation-journal.ts' as string);
    const { createConversationArchive } = await import('/src/conversation-archive.ts' as string);
    const { createJournalConversationPersistence } = await import('/src/journal-conversation-persistence.ts' as string);
    const { prepareNativeVoiceDelivery, createNativeVoiceDelivery } = await import('/src/native-voice-delivery.ts' as string);
    const name=`audit-integral-${crypto.randomUUID()}`, archiveName=`audit-integral-archive-${crypto.randomUUID()}`,id=crypto.randomUUID();
    const receipt={schema:'capri-native-voice-receipt/v1',audio:{id,owner:crypto.randomUUID(),destination:'chat',locale:'es-MX',kind:'speech',createdAt:1,state:'ready',byteCount:3,sha256:'a'.repeat(64)},transcript:{sessionId:id,text:'Dictado real',segments:[{text:'Dictado real',startSeconds:0,endSeconds:1}],durationSeconds:1,locale:'es-MX',source:'apple-speech-analyzer'}} as any;
    const intent=await prepareNativeVoiceDelivery(receipt,'Anterior');
    const archive=createConversationArchive({databaseName:archiveName}), real=createConversationJournal({databaseName:name,archive});
    const readBase=()=>new Promise<any>((resolve,reject)=>{const o=indexedDB.open(name,1);o.onupgradeneeded=()=>o.result.createObjectStore('conversation');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const db=o.result,tx=db.transaction('conversation','readonly'),r=tx.objectStore('conversation').get('current');r.onsuccess=()=>resolve(r.result);tx.oncomplete=()=>db.close();tx.onabort=()=>reject(tx.error);};});
    let release!:()=>void, started!:()=>void; const gate=new Promise<void>(r=>release=r), entered=new Promise<void>(r=>started=r);let first=true;
    const wrapped={pending:real.pending,resume:real.resume,begin:async (input:any)=>{if(first){first=false;started();await gate;}return real.begin(input);}};
    const writer=createJournalConversationPersistence({journal:wrapped,readBase});writer.bindBase(undefined);
    const old=writer.persist({entries:[],draft:'Anterior'});await entered;
    const voice=writer.persist({entries:[],draft:'Anterior\nDictado real'},intent);
    const edited=writer.persist({entries:[],draft:'Anterior\nDictado real\nEdición en cola'});
    release();await Promise.all([old,voice,edited]);
    return {name,archiveName,receipt,current:await readBase(),delivered:await createNativeVoiceDelivery({databaseName:name}).delivered(receipt),status:writer.status()};
  });
  expect(setup.status.blocked).toBe(false); expect(setup.delivered).toBe(true);
  expect(setup.current.draft).toBe('Anterior\nDictado real\nEdición en cola');
  await page.reload();
  const recovered=await page.evaluate(async setup=>{
    const {createConversationJournal}=await import('/src/conversation-journal.ts' as string);
    const {createConversationArchive}=await import('/src/conversation-archive.ts' as string);
    const {createJournalConversationPersistence,recoverConversationReservation}=await import('/src/journal-conversation-persistence.ts' as string);
    const {createNativeVoiceDelivery}=await import('/src/native-voice-delivery.ts' as string);
    const readBase=()=>new Promise<any>((resolve,reject)=>{const o=indexedDB.open(setup.name);o.onerror=()=>reject(o.error);o.onsuccess=()=>{const db=o.result,tx=db.transaction('conversation','readonly'),r=tx.objectStore('conversation').get('current');r.onsuccess=()=>resolve(r.result);tx.oncomplete=()=>db.close();tx.onabort=()=>reject(tx.error);};});
    const journal=createConversationJournal({databaseName:setup.name,archive:createConversationArchive({databaseName:setup.archiveName})});
    const recovered=await recoverConversationReservation(journal),base=await readBase();
    const writer=createJournalConversationPersistence({journal,readBase});writer.bindBase(base);
    await writer.persist({...base,draft:base.draft+'\nEdición después del reinicio'});
    return {recovered,base,current:await readBase(),status:writer.status(),delivered:await createNativeVoiceDelivery({databaseName:setup.name}).delivered(setup.receipt as any)};
  },setup);
  expect(recovered.recovered.state).toBe('none');expect(recovered.status.blocked).toBe(false);expect(recovered.delivered).toBe(true);
  expect(recovered.base.draft).toBe('Anterior\nDictado real\nEdición en cola');
  expect(recovered.current.draft).toBe('Anterior\nDictado real\nEdición en cola\nEdición después del reinicio');
  await page.reload();
  const final=await page.evaluate(async setup=>{const {createNativeVoiceDelivery}=await import('/src/native-voice-delivery.ts' as string);return createNativeVoiceDelivery({databaseName:setup.name}).delivered(setup.receipt as any);},setup);
  expect(final).toBe(true);
});
test('cleanup requires exact delivery and native identity across mismatch and lost callbacks', async ({page})=>{
  await page.goto('/');
  const setup=await page.evaluate(async()=>{
    const {createConversationJournal}=await import('/src/conversation-journal.ts' as string);
    const {createConversationArchive}=await import('/src/conversation-archive.ts' as string);
    const {prepareNativeVoiceDelivery}=await import('/src/native-voice-delivery.ts' as string);
    const name=`audit-clean-${crypto.randomUUID()}`,archiveName=`audit-clean-archive-${crypto.randomUUID()}`,id=crypto.randomUUID();
    const receipt={schema:'capri-native-voice-receipt/v1',audio:{id,owner:crypto.randomUUID(),destination:'chat',locale:'es-MX',kind:'speech',createdAt:1,state:'ready',byteCount:3,sha256:'a'.repeat(64)},transcript:{sessionId:id,text:'Dictado real',segments:[{text:'Dictado real',startSeconds:0,endSeconds:1}],durationSeconds:1,locale:'es-MX',source:'apple-speech-analyzer'}} as any;
    const intent=await prepareNativeVoiceDelivery(receipt,''),journal=createConversationJournal({databaseName:name,archive:createConversationArchive({databaseName:archiveName})}),op=crypto.randomUUID();
    await journal.begin({id:op,baseRevision:0,snapshot:{entries:[],draft:'Dictado real',revision:1},pending:[],voiceDelivery:intent});await journal.resume(op);
    return {name,receipt};
  });
  const data=await page.evaluate(async setup=>{
    const {createNativeVoiceDelivery,NATIVE_VOICE_DELIVERY_PREFIX}=await import('/src/native-voice-delivery.ts' as string);
    const {createProtectedVoice,cleanupDeliveredVoiceReceipt}=await import('/src/protected-voice.ts' as string);
    const delivery=createNativeVoiceDelivery({databaseName:setup.name}),id=setup.receipt.audio.id.toLowerCase(),key=NATIVE_VOICE_DELIVERY_PREFIX+id;
    const marker=await new Promise<any>((resolve,reject)=>{const o=indexedDB.open(setup.name);o.onsuccess=()=>{const db=o.result,tx=db.transaction('conversation','readonly'),r=tx.objectStore('conversation').get(key);r.onsuccess=()=>resolve(r.result);tx.oncomplete=()=>db.close();tx.onabort=()=>reject(tx.error);};o.onerror=()=>reject(o.error);});
    const write=(value:any)=>new Promise<void>((resolve,reject)=>{const o=indexedDB.open(setup.name);o.onsuccess=()=>{const db=o.result,tx=db.transaction('conversation','readwrite');tx.objectStore('conversation').put(value,key);tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};o.onerror=()=>reject(o.error);});
    let state='retained',mismatch=false,lost=false,releaseCalls=0,discardCalls=0;
    const native:any={get:async()=>({receipt:mismatch?{...setup.receipt,audio:{...setup.receipt.audio,sha256:'b'.repeat(64)}}:setup.receipt,releaseState:state}),release:async()=>{releaseCalls++;state='released';if(lost){lost=false;throw Error('respuesta perdida');}},discard:async()=>{discardCalls++;}};
    const protectedVoice=createProtectedVoice({receipts:native,bridge:{} as any,cancel:async()=>{},isDelivered:delivery.delivered});
    const deps={delivered:delivery.delivered,release:protectedVoice.release,get:native.get,discard:native.discard};
    await write({...marker,receiptSHA256:'f'.repeat(64)});
    const corrupt=(await Promise.allSettled([cleanupDeliveredVoiceReceipt(setup.receipt as any,deps)]))[0].status;
    const afterCorrupt={releaseCalls,discardCalls};await write(marker);
    mismatch=true;const changed=(await Promise.allSettled([cleanupDeliveredVoiceReceipt(setup.receipt as any,deps)]))[0].status;const afterMismatch={releaseCalls,discardCalls};mismatch=false;
    lost=true;const uncertain=(await Promise.allSettled([cleanupDeliveredVoiceReceipt(setup.receipt as any,deps)]))[0].status;const afterLost={state,releaseCalls,discardCalls};
    await cleanupDeliveredVoiceReceipt(setup.receipt as any,deps);const afterRetry={state,releaseCalls,discardCalls};
    state='releasing';await cleanupDeliveredVoiceReceipt(setup.receipt as any,deps);const afterReleasing={state,releaseCalls,discardCalls};
    return {corrupt,afterCorrupt,changed,afterMismatch,uncertain,afterLost,afterRetry,afterReleasing};
  },setup);
  expect(data.corrupt).toBe('rejected');expect(data.afterCorrupt).toEqual({releaseCalls:0,discardCalls:0});
  expect(data.changed).toBe('rejected');expect(data.afterMismatch).toEqual({releaseCalls:0,discardCalls:0});
  expect(data.uncertain).toBe('rejected');expect(data.afterLost).toEqual({state:'released',releaseCalls:1,discardCalls:0});
  expect(data.afterRetry).toEqual({state:'released',releaseCalls:2,discardCalls:1});
  expect(data.afterReleasing).toEqual({state:'released',releaseCalls:3,discardCalls:2});
  await page.reload();
  const delivered=await page.evaluate(async setup=>{const {createNativeVoiceDelivery}=await import('/src/native-voice-delivery.ts' as string);return createNativeVoiceDelivery({databaseName:setup.name}).delivered(setup.receipt as any);},setup);
  expect(delivered).toBe(true);
});
