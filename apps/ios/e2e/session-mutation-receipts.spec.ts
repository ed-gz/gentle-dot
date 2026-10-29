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
