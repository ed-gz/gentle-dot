import { expect, test } from './fixtures.ts';

test('recreated connections and different credentials cannot bypass an uncertain endpoint operation', async ({page})=>{
  await page.addInitScript(()=>{const state=globalThis as any;state.isTauri=true;state.keychain=new Map();state.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
    if(command.endsWith('secret_set')){state.keychain.set(args.request.account,args.request.value);return {ok:true};}
    if(command.endsWith('secret_get'))return {ok:true,value:state.keychain.get(args.request.account)};
    if(command.endsWith('secret_delete')){state.keychain.delete(args.request.account);return {ok:true};}
    if(command.endsWith('results_list')||command.endsWith('share_list')||command.endsWith('documents_list'))return {ok:true,items:[]};return {ok:true};
  }};});
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const store=await import('/src/external-connections.ts'), endpoint='https://fixture.example/mcp';
    const a=await store.saveConnectionCredentials({kind:'mcp',label:'Primera',endpoint},{accessToken:'fixture-one'});
    const b=await store.saveConnectionCredentials({kind:'mcp',label:'Segunda',endpoint},{accessToken:'fixture-two'});
    const make=(connection:any,text:string)=>({requestId:crypto.randomUUID(),fingerprint:'a'.repeat(64),connectionId:connection.id,connectionRevision:connection.revision,endpoint,toolName:'create',schemaJSON:'{"type":"object"}',argumentsJSON:JSON.stringify({text}),state:'executing',createdAt:1,updatedAt:1});
    const initial=make(a,'Igual');await store.beginRemoteExecution(initial);await store.finishRemoteExecution(initial.requestId,'uncertain');
    let differentCredentialBlocked=false;try{await store.beginRemoteExecution(make(b,'Igual'));}catch{differentCredentialBlocked=true;}
    await store.removeConnection(a.id,a.revision);const c=await store.saveConnectionCredentials({kind:'mcp',label:'Recreada',endpoint},{accessToken:'fixture-three'});
    let recreatedBlocked=false;try{await store.beginRemoteExecution(make(c,'Igual'));}catch{recreatedBlocked=true;}
    const distinct=make(c,'Distinto');await store.beginRemoteExecution(distinct);
    const concurrent=await Promise.allSettled([store.beginRemoteExecution(make(b,'Otra')),store.beginRemoteExecution(make(c,'Otra'))]);
    return {differentCredentialBlocked,recreatedBlocked,statuses:concurrent.map(x=>x.status).sort(),records:await store.listRemoteExecutions(),initial};
  });
  expect(result.differentCredentialBlocked).toBe(true);expect(result.recreatedBlocked).toBe(true);
  expect(result.statuses).toEqual(['fulfilled','rejected']);expect(result.records).toHaveLength(3);
  await page.reload();
  expect(await page.evaluate(async entry=>{const store=await import('/src/external-connections.ts');const connection=(await store.listConnections()).find(item=>item.label==='Recreada')!;try{await store.beginRemoteExecution({...entry,requestId:crypto.randomUUID(),connectionId:connection.id,connectionRevision:connection.revision});return false;}catch{return true;}},result.initial)).toBe(true);
});

test('human review closes only the exact record without issuing a remote call', async ({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const store=await import('/src/external-connections.ts'), tools=await import('/src/connection-tools.ts');
    const connection=await store.saveConnection({kind:'mcp',label:'Servicio',endpoint:'https://fixture.example/mcp'},'');
    const attempt={requestId:crypto.randomUUID(),fingerprint:'b'.repeat(64),connectionId:connection.id,connectionRevision:connection.revision,endpoint:connection.endpoint,toolName:'send',schemaJSON:'{"type":"object"}',argumentsJSON:'{"text":"Mensaje exacto"}',state:'executing',createdAt:1,updatedAt:1};
    await store.beginRemoteExecution(attempt);await store.finishRemoteExecution(attempt.requestId,'uncertain');
    const resolve=tools.createConnectionTools().find(tool=>tool.definition.name==='connection_execution_resolve')!;
    let denied=false;try{await resolve.execute({requestId:attempt.requestId},{signal:new AbortController().signal,askApproval:async()=>false});}catch{denied=true;}
    let reviewed:any;
    const answer=await resolve.execute({requestId:attempt.requestId},{signal:new AbortController().signal,askApproval:async request=>{reviewed=JSON.parse(request.details);return true;}});
    const replacement={...attempt,requestId:crypto.randomUUID(),state:'executing'};await store.beginRemoteExecution(replacement);
    return {denied,reviewed,answer,records:await store.listRemoteExecutions()};
  });
  expect(result.denied).toBe(true);expect(result.reviewed.arguments).toEqual({text:'Mensaje exacto'});
  expect(result.reviewed.warning).toContain('no verifica, cancela ni reenvía');
  expect(result.answer).toMatchObject({reviewed:true,resent:false,confirmed:false});
  expect(result.records.map(record=>record.state).sort()).toEqual(['executing','reviewed']);
});

test('a stale approval cannot close a changed remote operation', async ({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const store=await import('/src/external-connections.ts'), tools=await import('/src/connection-tools.ts');
    const connection=await store.saveConnection({kind:'mcp',label:'Servicio',endpoint:'https://fixture.example/mcp'},'');
    const attempt={requestId:crypto.randomUUID(),fingerprint:'b'.repeat(64),connectionId:connection.id,connectionRevision:connection.revision,endpoint:connection.endpoint,toolName:'send',schemaJSON:'{"type":"object"}',argumentsJSON:'{"text":"Exacto"}',state:'executing',createdAt:1,updatedAt:1};
    await store.beginRemoteExecution(attempt);const resolve=tools.createConnectionTools().find(tool=>tool.definition.name==='connection_execution_resolve')!;
    let blocked=false;try{await resolve.execute({requestId:attempt.requestId},{signal:new AbortController().signal,askApproval:async()=>{await store.finishRemoteExecution(attempt.requestId,'uncertain');return true;}});}catch{blocked=true;}
    return {blocked,records:await store.listRemoteExecutions()};
  });
  expect(result.blocked).toBe(true);expect(result.records[0].state).toBe('uncertain');
});

test('pending pagination and new reservations ignore large completed histories', async ({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const store=await import('/src/external-connections.ts'),connection=await store.saveConnection({kind:'mcp',label:'Servicio',endpoint:'https://fixture.example/mcp'},'');
    const id=()=>crypto.randomUUID(), base={fingerprint:'b'.repeat(64),connectionId:connection.id,connectionRevision:connection.revision,endpoint:connection.endpoint,toolName:'send',schemaJSON:'{"type":"object"}',argumentsJSON:'{"text":"x"}',createdAt:1,updatedAt:1};
    const open=indexedDB.open('capri-ios-external-connections',3);const db:IDBDatabase=await new Promise((resolve,reject)=>{open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction('executions','readwrite'),s=tx.objectStore('executions');
      for(let i=0;i<1000;i++)s.put({...base,requestId:id(),state:'succeeded',resultJSON:'x'.repeat(5000)});
      for(const state of ['executing','uncertain'])s.put({...base,requestId:id(),state,argumentsJSON:JSON.stringify({text:state})});
      tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
    });db.close();
    const getAll=IDBObjectStore.prototype.getAll;IDBObjectStore.prototype.getAll=function(){throw new Error('No cargar historial completo');};
    try{
      const first=await store.listPendingRemoteExecutions(0,1),second=await store.listPendingRemoteExecutions(first.nextOffset!,1);
      await store.beginRemoteExecution({...base,requestId:id(),state:'executing',argumentsJSON:'{"text":"distinct"}'});
      return {first,second};
    }finally{IDBObjectStore.prototype.getAll=getAll;}
  });
  expect(result.first.total).toBe(2);expect(result.first.items).toHaveLength(1);expect(result.first.nextOffset).toBe(1);
  expect(result.second.items).toHaveLength(1);expect(result.first.items[0].state).not.toBe(result.second.items[0].state);
  expect(result.first.items[0]).not.toHaveProperty('resultJSON');
});

test('version-two records survive migration and protect newly recreated connections', async ({page})=>{
  await page.route('**/src/main.ts*',route=>route.fulfill({contentType:'application/javascript',body:''}));
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const first=crypto.randomUUID(),second=crypto.randomUUID(),endpoint='https://fixture.example/mcp';
    const record={requestId:crypto.randomUUID(),fingerprint:'f'.repeat(64),connectionId:first,connectionRevision:1,endpoint,toolName:'send',schemaJSON:'{"type":"object"}',argumentsJSON:'{"text":"mismo"}',state:'uncertain',createdAt:1,updatedAt:1};
    await new Promise<void>((resolve,reject)=>{const open=indexedDB.open('capri-ios-external-connections',2);open.onupgradeneeded=()=>{
      const db=open.result,connections=db.createObjectStore('connections',{keyPath:'id'});connections.put({id:second,kind:'mcp',label:'Nueva',endpoint,revision:1,enabled:true,createdAt:1,updatedAt:1});
      const executions=db.createObjectStore('executions',{keyPath:'requestId'});executions.createIndex('fingerprint','fingerprint');executions.createIndex('operation-state',['connectionId','endpoint','toolName','argumentsJSON','state']);executions.put(record);
    };open.onerror=()=>reject(open.error);open.onsuccess=()=>{open.result.close();resolve();};});
    const store=await import('/src/external-connections.ts');let blocked=false;try{await store.beginRemoteExecution({...record,requestId:crypto.randomUUID(),connectionId:second,state:'executing'});}catch{blocked=true;}
    return {blocked,records:await store.listRemoteExecutions()};
  });
  expect(result.blocked).toBe(true);expect(result.records).toHaveLength(1);expect(result.records[0].state).toBe('uncertain');
});
