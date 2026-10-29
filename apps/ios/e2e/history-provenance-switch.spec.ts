import { expect, test } from './fixtures.ts';
test('a scope switch retains a warning copy while a conflicting older entry blocks autosave',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
  const {createJournalConversationPersistence}=await import('/src/journal-conversation-persistence.ts');
  const {createConversationJournal}=await import('/src/conversation-journal.ts');
  const {createConversationArchive}=await import('/src/conversation-archive.ts');
  const {createConversationWriteRescue}=await import('/src/conversation-write-rescue.ts');
  const suffix=crypto.randomUUID(),name=`page-flag-switch-${suffix}`,archive=createConversationArchive({databaseName:`page-flag-switch-archive-${suffix}`});
  let quota=true;const stored={verifyExactBatch:archive.verifyExactBatch,async upsert(...args:Parameters<typeof archive.upsert>){if(quota)throw new Error('Cuota');return archive.upsert(...args);}};
  const real=createConversationJournal({databaseName:name,archive:stored});
  let started!:()=>void,release!:()=>void;const waiting=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const journal={...real,async appendOwnedPage(...args:Parameters<typeof real.appendOwnedPage>){started();await gate;return real.appendOwnedPage(...args);}};
  const readBase=()=>new Promise<any>((resolve,reject)=>{const open=indexedDB.open(name,1);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('conversation','readonly'),get=tx.objectStore('conversation').get('current');get.onsuccess=()=>resolve(get.result);tx.oncomplete=()=>db.close();tx.onabort=()=>reject(tx.error);};});
  const rescue=createConversationWriteRescue({databaseName:name,archive}),writer=createJournalConversationPersistence({journal,readBase,writeRescue:rescue});writer.bindBase(undefined);
  const original={id:'host:wss://old.test/ws|chat|page',engine:'gentle' as const,role:'assistant' as const,state:'complete' as const,text:'Original',at:1};
  await writer.persist({entries:[original],draft:'Antes'});const flagged={...original,branchUnverified:true as const};writer.enqueue([flagged],true);quota=false;let current=true;
  const pageSave=writer.persist({entries:[original],draft:'Antes'},undefined,{entries:[flagged],addedEntries:[],originPrefix:'host:wss://old.test/ws|chat|',stillCurrent:()=>current});
  await waiting;current=false;const laterSave=writer.persist({entries:[],draft:'Nuevo'});release();await Promise.all([pageSave,laterSave]);
  return {archived:(await archive.page()).entries,copies:await rescue.list(),status:writer.status()};
 });
 expect(result.copies.some(copy=>copy.entries.some(entry=>entry.branchUnverified))).toBe(true);
 expect(result.archived).toHaveLength(1);
 expect(result.archived[0]).toMatchObject({id:'host:wss://old.test/ws|chat|page',role:'assistant',text:'Original'});
 expect(result.archived.some(entry=>entry.text==='Original'&&entry.branchUnverified)).toBe(false);
 expect(result.status.blocked).toBe(true);expect(result.status.conversationError).toContain('difiere de su base');
});
