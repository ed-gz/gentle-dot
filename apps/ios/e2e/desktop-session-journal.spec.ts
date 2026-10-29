import { expect, test } from '@playwright/test';
const journalUrl = `/@fs${process.cwd()}/apps/ios/src/desktop-session-journal.ts`;

test('concurrent clients reserve once, survive restart, and keep different instructions independent', async ({page,context}) => {
  await page.goto('/');
  const other = await context.newPage(); await other.goto('/');
  const attempt = (id:string,text:string) => ({id,owner:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',host:'https://example.test/orchestration',paneId:'pane',sessionId:'session',instanceId:'instance',text,deliverAs:'followUp',state:'prepared',createdAt:1});
  const reserve = (target:typeof page, data:ReturnType<typeof attempt>) => target.evaluate(async ({url,data}) => {
    const module = await import(/* @vite-ignore */ url), store = module.createSessionJournal();
    try { await store.begin({...data,key:module.sessionOperationKey(data.host,data.paneId,data.sessionId,data.text)}); return 'reserved'; }
    catch { return 'blocked'; }
  }, {url:journalUrl,data});
  const first=attempt('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Revisar pruebas');
  const second=attempt('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Revisar pruebas');
  expect((await Promise.all([reserve(page,first),reserve(other,second)])).sort()).toEqual(['blocked','reserved']);
  await page.reload();
  const recovered=await page.evaluate(async ({url,first}) => { const module=await import(/* @vite-ignore */ url); const store=module.createSessionJournal(); return store.find(module.sessionOperationKey(first.host,first.paneId,first.sessionId,first.text)); },{url:journalUrl,first});
  expect(recovered?.state).toBe('prepared'); expect([first.id,second.id]).toContain(recovered?.id);
  expect(await reserve(other,attempt('cccccccc-cccc-4ccc-8ccc-cccccccccccc','Revisar diseño'))).toBe('reserved');
});

test('review requires the exact saved revision and does not imply delivery', async ({page}) => {
  await page.goto('/');
  const result=await page.evaluate(async url => {
    const module=await import(/* @vite-ignore */ url), store=module.createSessionJournal();
    const item={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',host:'https://example.test/orchestration',paneId:'p',sessionId:'s',instanceId:'i',text:'Antes',deliverAs:'steer',state:'prepared',createdAt:1};
    const key=module.sessionOperationKey(item.host,item.paneId,item.sessionId,item.text); await store.begin({...item,key});
    let foreignCancelBlocked=false;
    try { await store.cancelBeforeDispatch({...item,key,owner:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}); } catch { foreignCancelBlocked=true; }
    await store.dispatching(item.id);
    let activeReviewBlocked=false; try { await store.reviewed((await store.find(key))!); } catch { activeReviewBlocked=true; }
    await store.unconfirmed(item.id);
    const old=await store.find(key); let changedBlocked=false;
    try { await store.reviewed({...old,text:'Distinto'}); } catch { changedBlocked=true; }
    const kept=await store.find(key); await store.reviewed(kept);
    return {foreignCancelBlocked,activeReviewBlocked,changedBlocked,kept:kept?.state,after:await store.find(key)};
  },journalUrl);
  expect(result).toEqual({foreignCancelBlocked:true,activeReviewBlocked:true,changedBlocked:true,kept:'unconfirmed',after:null});
});

test('lost commit callback never starts transport and leaves durable reservation', async ({page}) => {
  await page.goto('/');
  const result=await page.evaluate(async url => {
    const module=await import(/* @vite-ignore */ url), store=module.createSessionJournal();
    const item={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',host:'https://example.test/orchestration',paneId:'p',sessionId:'s',instanceId:'i',text:'Antes',deliverAs:'steer',state:'prepared',createdAt:1};
    const key=module.sessionOperationKey(item.host,item.paneId,item.sessionId,item.text);
    const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete')!, originalTimeout=window.setTimeout; let suppress=true;
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(value) { if(suppress && this.db.name==='capri-ios-session-send-journal'){suppress=false;return;} descriptor.set!.call(this,value); }});
    window.setTimeout=((fn:TimerHandler,delay?:number,...args:unknown[]) => originalTimeout(fn,delay===8000?200:delay,...args)) as typeof setTimeout;
    let rejected=false; try { await store.begin({...item,key}); } catch { rejected=true; }
    finally { window.setTimeout=originalTimeout; Object.defineProperty(IDBTransaction.prototype,'oncomplete',descriptor); }
    return {rejected,state:(await store.find(key))?.state};
  },journalUrl);
  expect(result).toEqual({rejected:true,state:'prepared'});
});

test('the agent cannot resend an uncertain instruction after reload without human review', async ({page}) => {
  await page.goto('/');
  const desktopUrl=`/@fs${process.cwd()}/apps/ios/src/desktop-tools.ts`;
  const send = (text:string) => page.evaluate(async ({desktopUrl,text}) => {
    const {createDesktopSessionClient}=await import(/* @vite-ignore */ desktopUrl);
    const connection={url:'wss://example.test/ws',token:'synthetic-token',deviceId:'test-device'};
    let receipt:unknown;
    const client=createDesktopSessionClient({getConnection:()=>connection,receiptState:async()=> 'terminal',request:async (request:{body?:string}) => {
      const payload=request.body?JSON.parse(request.body):undefined;
      const session={paneId:'p',sessionId:'s',label:'Prueba',state:'idle',connected:true,capabilities:{inspect:true,prompt:true,abort:true,deliveryReceipts:true}};
      if (!payload) return {status:200,headers:{},body:JSON.stringify({available:true,sessions:[session]})};
      if (payload.action==='prompt') {
        sessionStorage.setItem('fixture-sends',String(Number(sessionStorage.getItem('fixture-sends')??0)+1));
        if (payload.text==='Una instrucción') throw new Error('disconnect');
        receipt={id:payload.clientMessageId,status:'queued',acceptedAt:'2026-10-27T20:00:00Z',preview:payload.text,deliverAs:payload.deliverAs};
        return {status:200,headers:{},body:JSON.stringify({accepted:true,sessionId:'s',instanceId:'i'})};
      }
      return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',messages:[],deliveries:receipt?[receipt]:[]})};
    }});
    let approvals=0;
    const result=await client.send({paneId:'p',sessionId:'s',text},{signal:new AbortController().signal,askApproval:async()=>{approvals++;return true;}});
    return {status:result.status,id:result.clientMessageId,approvals,sends:Number(sessionStorage.getItem('fixture-sends')??0)};
  },{desktopUrl,text});
  const first=await send('Una instrucción'); expect(first).toMatchObject({status:'uncertain',approvals:1,sends:1});
  await page.reload();
  const duplicate=await send('Una instrucción'); expect(duplicate).toEqual({status:'unconfirmed',id:first.id,approvals:0,sends:1});
  expect(await send('Otra instrucción')).toMatchObject({status:'queued',approvals:1,sends:2});
});

test('historical attempts do not block or require scanning when reserving new work', async ({page}) => {
  await page.goto('/');
  const result=await page.evaluate(async url => {
    const module=await import(/* @vite-ignore */ url), store=module.createSessionJournal('journal-volume');
    const host='https://example.test/orchestration', owner='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const open=indexedDB.open('journal-volume',1);
    open.onupgradeneeded=()=>{open.result.createObjectStore('attempts',{keyPath:'id'});open.result.createObjectStore('pending');};
    const db:IDBDatabase=await new Promise((resolve,reject)=>{open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction(['attempts','pending'],'readwrite'), attempts=tx.objectStore('attempts');
      for(let i=0;i<2000;i++) attempts.put({id:`past-${i}`,state:'delivered',text:`Registro ${i}`});
      tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
    });
    db.close();
    const getAll=IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll=function(){throw new Error('No debe leer el archivo histórico');};
    const item={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner,host,paneId:'p',sessionId:'s',instanceId:'i',text:'Nuevo',deliverAs:'steer',state:'prepared',createdAt:1};
    try { await store.begin({...item,key:module.sessionOperationKey(host,'p','s',item.text)}); }
    finally { IDBObjectStore.prototype.getAll=getAll; }
    const openAgain=indexedDB.open('journal-volume');
    const verify:IDBDatabase=await new Promise((resolve,reject)=>{openAgain.onsuccess=()=>resolve(openAgain.result);openAgain.onerror=()=>reject(openAgain.error);});
    const count:number=await new Promise((resolve,reject)=>{const tx=verify.transaction('attempts','readonly'), request=tx.objectStore('attempts').count();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    verify.close(); return {count,state:(await store.find(module.sessionOperationKey(host,'p','s',item.text)))?.state};
  },journalUrl);
  expect(result).toEqual({count:2001,state:'prepared'});
});

test('the pending limit blocks new sends without deleting an unresolved attempt', async ({page}) => {
  await page.goto('/');
  const result=await page.evaluate(async url => {
    const module=await import(/* @vite-ignore */ url), store=module.createSessionJournal('journal-pending-volume');
    const host='https://example.test/orchestration', owner='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const open=indexedDB.open('journal-pending-volume',1);
    open.onupgradeneeded=()=>{open.result.createObjectStore('attempts',{keyPath:'id'});open.result.createObjectStore('pending');};
    const db:IDBDatabase=await new Promise((resolve,reject)=>{open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction(['attempts','pending'],'readwrite'), attempts=tx.objectStore('attempts'), pending=tx.objectStore('pending');
      for(let i=0;i<2000;i++) {
        const id=`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`, text=`pendiente-${i}`, key=module.sessionOperationKey(host,'p','s',text);
        attempts.put({id,owner,key,host,paneId:'p',sessionId:'s',instanceId:'i',text,deliverAs:'steer',state:'unconfirmed',createdAt:i}); pending.put(id,key);
      }
      tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
    });
    db.close();
    const text='nuevo', key=module.sessionOperationKey(host,'p','s',text); let blocked=false;
    try { await store.begin({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner,key,host,paneId:'p',sessionId:'s',instanceId:'i',text,deliverAs:'steer',state:'prepared',createdAt:1}); } catch { blocked=true; }
    return {blocked,first:(await store.find(module.sessionOperationKey(host,'p','s','pendiente-0')))?.text};
  },journalUrl);
  expect(result).toEqual({blocked:true,first:'pendiente-0'});
});

test('a second window cannot close a dispatching send even if its original window disappears', async ({page,context})=>{
  await page.goto('/');const other=await context.newPage();await other.goto('/');
  const attempt=await page.evaluate(async url=>{
    const {createDesktopSessionClient}=await import(/* @vite-ignore */ url),conn={url:'wss://example.test/ws',token:'synthetic'};
    let ready!:()=>void;const started=new Promise<void>(resolve=>ready=resolve);
    const session={paneId:'p',sessionId:'s',label:'Fixture',state:'idle',connected:true,capabilities:{inspect:true,prompt:true,abort:true,deliveryReceipts:true}};
    const client=createDesktopSessionClient({getConnection:()=>conn,request:async request=>{
      const payload=request.body?JSON.parse(request.body):null;
      if(payload?.action==='prompt'){ready();return new Promise(()=>{});}
      return {status:200,headers:{},body:JSON.stringify(payload?{sessionId:'s',instanceId:'i',messages:[],deliveries:[]}:{available:true,sessions:[session]})};
    }});
    (globalThis as any).send=client.send({paneId:'p',sessionId:'s',text:'Exacto'},{signal:new AbortController().signal,askApproval:async()=>true});
    await started;return (await client.listDeliveries()).items[0];
  },`/@fs${process.cwd()}/apps/ios/src/desktop-tools.ts`);
  const check=async()=>other.evaluate(async ({desktopUrl,id})=>{
    const {createDesktopSessionClient}=await import(/* @vite-ignore */ desktopUrl);let approvals=0;
    const client=createDesktopSessionClient({getConnection:()=>({url:'wss://example.test/ws',token:'synthetic'}),request:async()=>{throw new Error('unexpected');}});
    let blocked=false;try{await client.resolveDelivery({clientMessageId:id},{signal:new AbortController().signal,askApproval:async()=>{approvals++;return true;}});}catch{blocked=true;}
    return {blocked,approvals,state:(await client.listDeliveries()).items[0]?.state};
  },{desktopUrl:`/@fs${process.cwd()}/apps/ios/src/desktop-tools.ts`,id:attempt.id});
  expect(await check()).toEqual({blocked:true,approvals:0,state:'dispatching'});await page.close();
  expect(await check()).toEqual({blocked:true,approvals:0,state:'dispatching'});await other.close();
});

test('session recovery requires the exact terminal native receipt and never trusts missing or legacy entries',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async({journalUrl,controlUrl})=>{
  const j=await import(/* @vite-ignore */ journalUrl),c=await import(/* @vite-ignore */ controlUrl),store=j.createSessionJournal('receipt-recovery-fixture');
  const host='https://example.test/orchestration',make=(text:string,tracked:boolean)=>({id:crypto.randomUUID(),owner:crypto.randomUUID(),key:j.sessionOperationKey(host,'p','s',text),host,paneId:'p',sessionId:'s',instanceId:'i',text,deliverAs:'followUp',state:'prepared',createdAt:1,...(tracked?{nativeReceipt:1}:{})});
  const a=make('nuevo',true);await store.begin(a);await store.dispatching(a.id);const current=await store.find(a.key);let active=false,missing=false;
  try{await c.recoverSessionControl(store,current,async()=> 'active');}catch{active=true;}try{await c.recoverSessionControl(store,current,async()=> 'missing');}catch{missing=true;}
  const recovered=await c.recoverSessionControl(store,current,async()=> 'terminal');await store.reviewed(recovered);let late=false;try{await store.delivered(a.id,'i');}catch{late=true;}
  const legacy=make('legado',false);await store.begin(legacy);await store.dispatching(legacy.id);let legacyBlocked=false;try{await c.recoverSessionControl(store,await store.find(legacy.key),async()=> 'terminal');}catch{legacyBlocked=true;}
  const stale=make('carrera',true);await store.begin(stale);await store.dispatching(stale.id);const before=await store.find(stale.key);let raceBlocked=false;
  try{await c.recoverSessionControl(store,before,async()=>{await store.unconfirmed(stale.id);return 'terminal';});}catch{raceBlocked=true;}
  return {active,missing,recovered:recovered.state,late,legacyBlocked,legacyState:(await store.find(legacy.key))?.state,raceBlocked};
 },{journalUrl,controlUrl:`/@fs${process.cwd()}/apps/ios/src/desktop-control-journal.ts`});
 expect(result).toEqual({active:true,missing:true,recovered:'unconfirmed',late:true,legacyBlocked:true,legacyState:'dispatching',raceBlocked:true});
});
