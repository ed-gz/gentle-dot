import {expect,test} from './fixtures.ts';

test('create, close, duplicate, revoke and grant use action-specific acknowledgement semantics',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
  const {createLaptopClient}=await import('/src/laptop-client.ts'),{createDesktopSessionClient}=await import('/src/desktop-tools.ts'),conn={url:'wss://example.test/ws',token:'fixture'};let posts:any[]=[],correct=false;
  const request=async(req:any)=>{const action=req.body?JSON.parse(req.body):null;if(!action)return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[],approvals:[],policies:[],events:[]})};if(action.action==='inspect')return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'idle',messages:[],deliveries:[],question:null,history:{hasEarlier:false}})};
   posts.push(action);let body:any={accepted:true};
   if(correct&&action.action==='create')body={created:true,starting:true};
   if(correct&&action.action==='close')body={accepted:true,closing:true,sessionId:'s',instanceId:'i'};
   if(correct&&action.action==='duplicate')body={created:true,sourceSessionId:'s',sessionId:'copy'};
   if(correct&&action.action==='revoke')body={revoked:true};
   return {status:200,headers:{},body:JSON.stringify(body)};
  };
  const receiptState=async()=> 'terminal' as const,panel=createLaptopClient(conn,{current:()=>conn,request,receiptState}),desktop=createDesktopSessionClient({getConnection:()=>conn,request,receiptState});
  const actions=[{action:'create' as const,cwd:'/workspace'},{action:'close' as const,paneId:'p',sessionId:'s'},{action:'revoke' as const,policyId:'policy-1'}];
  const rejected=[];for(const action of actions)try{await panel.act(action);rejected.push(false);}catch{rejected.push(true);}
  const pending=await desktop.listControls();let blocked=false;try{await panel.act(actions[0]);}catch{blocked=true;}
  for(const item of pending.items)await desktop.resolveControl({id:item.id},{signal:new AbortController().signal,askApproval:async()=>true});
  correct=true;for(const action of actions)await panel.act(action);
  await panel.act({action:'duplicate',paneId:'p',sessionId:'s'});const duplicate=await desktop.listControls();
  let grantBlocked=false;try{await panel.act({action:'grant',paneId:'p',sessionId:'s',requestId:'q',expiresAt:'2099-01-01',maxUses:1});}catch{grantBlocked=true;}
  return {rejected,blocked,pending:pending.total,duplicate:duplicate.items.map(x=>({kind:x.kind,state:x.state})),grantBlocked,actions:posts.map(x=>x.action)};
 });
 expect(result.rejected).toEqual([true,true,true]);expect(result.blocked).toBe(true);expect(result.pending).toBe(3);expect(result.duplicate).toEqual([]);expect(result.grantBlocked).toBe(true);
 expect(result.actions).toEqual(['create','close','revoke','create','close','revoke','duplicate']);
});

test('concurrent identical creations dispatch once even when the native callback is lost',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
  const {createLaptopClient}=await import('/src/laptop-client.ts'),{createDesktopSessionClient}=await import('/src/desktop-tools.ts'),conn={url:'wss://example.test/ws',token:'fixture'};let posts=0;
  const request=async()=>{posts++;return new Promise<any>(()=>{});},receiptState=async()=> 'active' as const;
  const a=createLaptopClient(conn,{current:()=>conn,request,receiptState,controlTimeoutMs:20}),b=createLaptopClient(conn,{current:()=>conn,request,receiptState,controlTimeoutMs:20});
  const action={action:'create' as const,cwd:'/workspace'};const statuses=await Promise.allSettled([a.act(action),b.act(action)]);
  const desktop=createDesktopSessionClient({getConnection:()=>conn,request,receiptState});return {posts,statuses:statuses.map(x=>x.status),page:await desktop.listControls()};
 });
 expect(result.posts).toBe(1);expect(result.statuses).toEqual(['rejected','rejected']);expect(result.page.items[0]).toMatchObject({kind:'create',state:'dispatching'});
});

test('a copy ACK naming another source cannot confirm this session',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
  const {createLaptopClient}=await import('/src/laptop-client.ts'),{createDesktopSessionClient}=await import('/src/desktop-tools.ts'),conn={url:'wss://example.test/ws',token:'fixture'},receiptState=async()=> 'terminal' as const;let sends=0;
  const request=async(req:any)=>{const action=req.body?JSON.parse(req.body):null;if(!action)return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[],approvals:[],policies:[],events:[]})};if(action.action==='inspect')return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'idle',messages:[],deliveries:[],question:null,history:{hasEarlier:false}})};
   sends++;return {status:200,headers:{},body:JSON.stringify({created:true,sourceSessionId:'other',sessionId:'new'})};};
  const panel=createLaptopClient(conn,{current:()=>conn,request,receiptState}),desktop=createDesktopSessionClient({getConnection:()=>conn,request,receiptState});let rejected=false;
  try{await panel.act({action:'duplicate',paneId:'p',sessionId:'s'});}catch{rejected=true;}let blocked=false;try{await panel.act({action:'duplicate',paneId:'p',sessionId:'s'});}catch{blocked=true;}
  return {rejected,blocked,sends,records:await desktop.listControls()};
 });
 expect(result.rejected).toBe(true);expect(result.blocked).toBe(true);expect(result.sends).toBe(1);expect(result.records.items[0]).toMatchObject({kind:'duplicate',state:'unconfirmed'});
});

test('old host without instance fencing remains readable but cannot mutate a session',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
  const {createLaptopClient}=await import('/src/laptop-client.ts'),conn={url:'wss://example.test/ws',token:'fixture'};let effects=0;
  const request=async(req:any)=>{const action=req.body?JSON.parse(req.body):null;if(!action)return {status:200,headers:{},body:JSON.stringify({available:true,sessions:[],approvals:[],policies:[],events:[]})};if(action.action==='inspect')return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'idle',messages:[],deliveries:[],question:null,history:{hasEarlier:false}})};effects++;return {status:200,headers:{},body:'{}'};};
  const panel=createLaptopClient(conn,{current:()=>conn,request,receiptState:async()=> 'terminal'});let blocked=0;
  const actions=[{action:'close' as const,paneId:'p',sessionId:'s'},{action:'duplicate' as const,paneId:'p',sessionId:'s'},{action:'abort' as const,paneId:'p',sessionId:'s'},{action:'prompt' as const,paneId:'p',sessionId:'s',text:'x'},{action:'answer' as const,paneId:'p',sessionId:'s',requestId:'q',approved:true}];
  const readable=(await panel.inspect('p','s')).sessionId;for(const action of actions)try{await panel.act(action);}catch(error){if(String(error).includes('necesita actualizarse'))blocked++;}
  return {blocked,effects,readable};
 });
 expect(result).toEqual({blocked:5,effects:0,readable:'s'});
});

test('a daemon downgraded after discovery never receives a legacy mutation fallback',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
  const {createLaptopClient}=await import('/src/laptop-client.ts'),{createDesktopSessionClient}=await import('/src/desktop-tools.ts'),conn={url:'wss://example.test/ws',token:'fixture'};const posts:string[]=[];
  const request=async(req:any)=>{const action=req.body?JSON.parse(req.body):null;if(!action)return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[],approvals:[],policies:[],events:[]})};
   if(action.action==='inspect')return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'idle',messages:[],deliveries:[],question:null,history:{hasEarlier:false}})};
   posts.push(req.url);return {status:404,headers:{},body:'not found'};};
  const receiptState=async()=> 'terminal' as const,panel=createLaptopClient(conn,{current:()=>conn,request,receiptState});let rejected=false;
  try{await panel.act({action:'prompt',paneId:'p',sessionId:'s',text:'Exacto',clientMessageId:'message-id'});}catch{rejected=true;}
  const records=await createDesktopSessionClient({getConnection:()=>conn,request,receiptState}).listControls();return {rejected,posts,records};
 });
 expect(result.rejected).toBe(true);expect(result.posts).toEqual(['https://example.test/orchestration/guarded-v1']);expect(result.records.items[0]).toMatchObject({kind:'prompt',state:'unconfirmed'});
});

test('uncertain creation blocks path aliases and all new creations until human review',async({page})=>{
 await page.goto('/');
 const attempt=async(kind:'first'|'alias'|'distinct'|'review')=>page.evaluate(async kind=>{
  const {createLaptopClient}=await import('/src/laptop-client.ts'),{createDesktopSessionClient}=await import('/src/desktop-tools.ts'),conn={url:'wss://example.test/ws',token:'fixture'},receiptState=async()=>kind==='review'?'terminal' as const:'active' as const;
  const request=async()=>{const count=Number(sessionStorage.getItem('created-posts')??0)+1;sessionStorage.setItem('created-posts',String(count));if(kind==='first')throw new Error('lost callback');return {status:200,headers:{},body:JSON.stringify({created:true,starting:true})};};
  const client=createLaptopClient(conn,{current:()=>conn,request,receiptState});if(kind==='review'){const desktop=createDesktopSessionClient({getConnection:()=>conn,request,receiptState});const records=await desktop.listControls();await desktop.resolveControl({id:records.items[0].id},{signal:new AbortController().signal,askApproval:async()=>true});return {blocked:false,posts:Number(sessionStorage.getItem('created-posts')??0)};}
  const action=kind==='first'?{action:'create' as const,cwd:'/work'}:kind==='alias'?{action:'create' as const,cwd:'/work/.',label:'Gentle Dot',provider:'herdr' as const}:{action:'create' as const,cwd:'/different',label:'Otro trabajo'};
  let blocked=false;try{await client.act(action);}catch{blocked=true;}return {blocked,posts:Number(sessionStorage.getItem('created-posts')??0)};
 },kind);
 expect(await attempt('first')).toEqual({blocked:true,posts:1});await page.reload();expect(await attempt('alias')).toEqual({blocked:true,posts:1});expect(await attempt('distinct')).toEqual({blocked:true,posts:1});expect(await attempt('review')).toEqual({blocked:false,posts:1});expect(await attempt('distinct')).toEqual({blocked:false,posts:2});
});

test('an uncertain revocation blocks the same policy but not a different policy',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
  const {createLaptopClient}=await import('/src/laptop-client.ts'),conn={url:'wss://example.test/ws',token:'fixture'},receiptState=async()=> 'terminal' as const;let posts:string[]=[];
  const request=async(req:any)=>{const action=JSON.parse(req.body);posts.push(action.policyId);return {status:200,headers:{},body:JSON.stringify(action.policyId==='p1'?{}:{revoked:true})};};
  const client=createLaptopClient(conn,{current:()=>conn,request,receiptState});let first=false,blocked=false;try{await client.act({action:'revoke',policyId:'p1'});}catch{first=true;}try{await client.act({action:'revoke',policyId:'p1'});}catch{blocked=true;}await client.act({action:'revoke',policyId:'p2'});
  return {first,blocked,posts};
 });
 expect(result).toEqual({first:true,blocked:true,posts:['p1','p2']});
});

test('legacy digest-keyed creation still blocks the new host-wide reservation',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
  const {createControlJournal}=await import('/src/desktop-control-journal.ts'),{sessionOperationKey}=await import('/src/desktop-session-journal.ts'),{createLaptopClient}=await import('/src/laptop-client.ts');
  const journal=createControlJournal(),host='https://example.test/orchestration',text=JSON.stringify(['create','a'.repeat(64)]),id=crypto.randomUUID(),owner=crypto.randomUUID();
  await journal.begin({id,owner,key:sessionOperationKey(host,'@create','@create',text),host,paneId:'@create',sessionId:'@create',instanceId:'global',text,deliverAs:'followUp',state:'prepared',createdAt:1,nativeReceipt:1,control:{kind:'create',payload:{action:'create',cwd:'/work'}}});await journal.dispatching(id);await journal.unconfirmed(id);
  let posts=0,blocked=false;const conn={url:'wss://example.test/ws',token:'fixture'},panel=createLaptopClient(conn,{current:()=>conn,request:async()=>{posts++;return {status:200,headers:{},body:'{"created":true}'};}});
  try{await panel.act({action:'create',cwd:'/work/.'});}catch{blocked=true;}return {blocked,posts,records:await journal.list(host)};
 });
 expect(result.blocked).toBe(true);expect(result.posts).toBe(0);expect(result.records).toHaveLength(1);expect(result.records[0].state).toBe('unconfirmed');
});

test('creation reservations with different legacy keys serialize atomically per host',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
  const {createControlJournal}=await import('/src/desktop-control-journal.ts'),{sessionOperationKey}=await import('/src/desktop-session-journal.ts'),journal=createControlJournal(),host='https://example.test/orchestration';
  const make=(text:string)=>({id:crypto.randomUUID(),owner:crypto.randomUUID(),key:sessionOperationKey(host,'@create','@create',text),host,paneId:'@create',sessionId:'@create',instanceId:'global',text,deliverAs:'followUp' as const,state:'prepared' as const,createdAt:1,control:{kind:'create' as const,payload:{action:'create',cwd:'/work'}}});
  const getAll=IDBObjectStore.prototype.getAll;IDBObjectStore.prototype.getAll=function(){throw new Error('bulk read forbidden');};
  try {const result=await Promise.allSettled([journal.begin(make('legacy-a')),journal.begin(make('new-host-key'))]);return result.map(item=>item.status).sort();}finally{IDBObjectStore.prototype.getAll=getAll;}
 });
 expect(result).toEqual(['fulfilled','rejected']);
});
