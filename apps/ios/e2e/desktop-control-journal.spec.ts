import {expect,test} from './fixtures.ts';

test('a lost human answer blocks changed answers from both the panel and agent after restart',async({page})=>{
  await page.goto('/');
  const perform=async(source:'panel'|'agent',text:string)=>page.evaluate(async({source,text})=>{
    const {createLaptopClient}=await import('/src/laptop-client.ts'),{createDesktopSessionClient}=await import('/src/desktop-tools.ts');
    const conn={url:'wss://example.test/ws',token:'fixture'},target={paneId:'p',sessionId:'s'};
    const question={id:'q1',kind:'input',title:'Pregunta',message:'Indica la respuesta',expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
    const approval={...question,paneId:'p',sessionId:'s',action:question.title,createdAt:'',questionRevision:'a'.repeat(64)};
    const request=async(req:any)=>{const body=req.body?JSON.parse(req.body):null;
      if(!body)return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[],approvals:[approval],policies:[],events:[]})};
      if(body?.action==='answer'){sessionStorage.setItem('control-sends',String(Number(sessionStorage.getItem('control-sends')??0)+1));throw new Error('lost ACK');}
      return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'waiting',messages:[],deliveries:[],question,questionRevision:'a'.repeat(64),capabilities:{questionBinding:1},history:{hasEarlier:false}})};
    };
    let blocked=false;try{
      if(source==='panel')await createLaptopClient(conn,{current:()=>conn,request,receiptState:async()=> 'terminal'}).act({action:'answer',...target,requestId:'q1',text,reviewedApproval:approval});
      else await createDesktopSessionClient({getConnection:()=>conn,request,receiptState:async()=> 'terminal'}).answerFromHuman({...target,requestId:'q1',text},{signal:new AbortController().signal,askApproval:async()=>true});
    }catch{blocked=true;}
    const client=createDesktopSessionClient({getConnection:()=>conn,request,receiptState:async()=> 'terminal'});
    return {blocked,sends:Number(sessionStorage.getItem('control-sends')??0),records:await client.listControls()};
  },{source,text});
  const first=await perform('panel','Primera');expect(first.blocked).toBe(true);expect(first.sends).toBe(1);expect(first.records.items[0].state).toBe('unconfirmed');
  await page.reload();const duplicate=await perform('agent','Diferente');expect(duplicate.blocked).toBe(true);expect(duplicate.sends).toBe(1);expect(duplicate.records.items).toHaveLength(1);
});

test('a control in flight cannot be reviewed or duplicated from another window',async({page,context})=>{
  await page.goto('/');const other=await context.newPage();await other.goto('/');
  await page.evaluate(async()=>{
    const {createLaptopClient}=await import('/src/laptop-client.ts'),conn={url:'wss://example.test/ws',token:'fixture'};let ready!:()=>void;const started=new Promise<void>(r=>ready=r);
    const request=async(req:any)=>{const body=req.body?JSON.parse(req.body):null;if(!body)return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[],approvals:[],policies:[],events:[]})};if(body.action==='abort'){ready();return new Promise<any>(()=>{});}return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'working',messages:[],deliveries:[],question:null,history:{hasEarlier:false}})};};
    (globalThis as any).pending=createLaptopClient(conn,{current:()=>conn,request,receiptState:async()=> 'active'}).act({action:'abort',paneId:'p',sessionId:'s'});await started;
  });
  const verify=async()=>other.evaluate(async()=>{
    const {createDesktopSessionClient}=await import('/src/desktop-tools.ts'),conn={url:'wss://example.test/ws',token:'fixture'};
    const request=async(req:any)=>({status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',messages:[],deliveries:[]})});
    const client=createDesktopSessionClient({getConnection:()=>conn,request,receiptState:async()=> 'active'});const records=await client.listControls();let approval=0,blocked=false;
    try{await client.resolveControl({id:records.items[0].id},{signal:new AbortController().signal,askApproval:async()=>{approval++;return true;}});}catch{blocked=true;}
    let duplicate=false;try{await client.abort({paneId:'p',sessionId:'s'},{signal:new AbortController().signal,askApproval:async()=>true});}catch{duplicate=true;}
    return {blocked,approval,duplicate,state:records.items[0].state};
  });
  expect(await verify()).toEqual({blocked:true,approval:0,duplicate:true,state:'dispatching'});await page.close();expect(await verify()).toEqual({blocked:true,approval:0,duplicate:true,state:'dispatching'});await other.close();
});

test('an uncertain control requires exact human review before allowing another attempt',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {createLaptopClient}=await import('/src/laptop-client.ts'),{createDesktopSessionClient}=await import('/src/desktop-tools.ts'),conn={url:'wss://example.test/ws',token:'fixture'};
    let sends=0;const question={id:'q1',kind:'input',title:'Pregunta',message:'Contenido a revisar',expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
    const approval={...question,paneId:'p',sessionId:'s',action:question.title,createdAt:'',questionRevision:'a'.repeat(64)};
    const request=async(req:any)=>{const body=req.body?JSON.parse(req.body):null;if(!body)return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[],approvals:[approval],policies:[],events:[]})};if(body.action==='answer'){sends++;throw new Error('lost ACK');}return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'waiting',messages:[],deliveries:[],question,history:{hasEarlier:false}})};};
    const panel=createLaptopClient(conn,{current:()=>conn,request,receiptState:async()=> 'terminal'}),desktop=createDesktopSessionClient({getConnection:()=>conn,request,receiptState:async()=> 'terminal'});
    try{await panel.act({action:'answer',paneId:'p',sessionId:'s',requestId:'q1',text:'Respuesta exacta',reviewedApproval:approval});}catch{}
    const {items}=await desktop.listControls();let denied=false;try{await desktop.resolveControl({id:items[0].id},{signal:new AbortController().signal,askApproval:async()=>false});}catch{denied=true;}
    let details:any;const resolved=await desktop.resolveControl({id:items[0].id},{signal:new AbortController().signal,askApproval:async value=>{details=JSON.parse(value.details);return true;}});
    const before=sends;try{await panel.act({action:'answer',paneId:'p',sessionId:'s',requestId:'q1',text:'Nueva respuesta',reviewedApproval:approval});}catch{}
    return {denied,details,resolved,before,after:sends};
  });
  expect(result.denied).toBe(true);expect(result.details.attempt.control.payload.text).toBe('Respuesta exacta');expect(result.details.warning).toContain('podría seguir procesando');
  expect(result.resolved).toMatchObject({reviewed:true,resent:false,confirmed:false});expect(result.before).toBe(1);expect(result.after).toBe(2);
});

test('panel refuses changed approval content with the same ID and never sends local review metadata',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {createLaptopClient}=await import('/src/laptop-client.ts'),conn={url:'wss://example.test/ws',token:'fixture'};
    const approval={id:'q1',paneId:'p',sessionId:'s',title:'Enviar',message:'Texto original',action:'send',kind:'confirm' as const,createdAt:'',expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true,questionRevision:'a'.repeat(64)};
    let changed=true;const sent:any[]=[];
    const request=async(req:any)=>{const body=req.body?JSON.parse(req.body):null;if(!body)return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[],approvals:[{...approval,message:changed?'Texto cambiado':approval.message}],policies:[],events:[]})};
      if(body.action==='answer'){sent.push(body);return {status:200,headers:{},body:JSON.stringify({accepted:true,sessionId:'s',instanceId:'i'})};}
      return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'waiting',messages:[],deliveries:[],question:null,history:{hasEarlier:false}})};
    };
    const client=createLaptopClient(conn,{current:()=>conn,request,receiptState:async()=> 'terminal'});let blocked=false;try{await client.act({action:'answer',paneId:'p',sessionId:'s',requestId:'q1',approved:true,reviewedApproval:approval});}catch{blocked=true;}
    changed=false;await client.act({action:'answer',paneId:'p',sessionId:'s',requestId:'q1',approved:true,reviewedApproval:approval});
    return {blocked,sent};
  });
  expect(result.blocked).toBe(true);expect(result.sent).toEqual([{action:'answer',paneId:'p',sessionId:'s',requestId:'q1',approved:true,expectedInstanceId:'i',expectedQuestionRevision:'a'.repeat(64)}]);
});

test('control pages and exact review avoid bulk reads of pending payloads',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
   const {createControlJournal}=await import('/src/desktop-control-journal.ts'),{sessionOperationKey}=await import('/src/desktop-session-journal.ts');const journal=createControlJournal();
   const host='https://example.test/orchestration',owner=crypto.randomUUID();let first='';
   for(let i=0;i<60;i++){const id=crypto.randomUUID(),text=JSON.stringify(['answer',`q${i}`]);if(!i)first=id;await journal.begin({id,owner,key:sessionOperationKey(host,'p','s',text),host,paneId:'p',sessionId:'s',instanceId:'i',text,deliverAs:'followUp',state:'prepared',createdAt:i,control:{kind:'answer',payload:{text:'x'.repeat(30000)}}});}
   const getAll=IDBObjectStore.prototype.getAll;IDBObjectStore.prototype.getAll=function(){throw new Error('bulk read forbidden');};
   try{const page=await journal.page(host,0,2),item=await journal.getPending(host,first);return {total:page.total,count:page.items.length,id:item?.id};}finally{IDBObjectStore.prototype.getAll=getAll;}
 });
 expect(result).toMatchObject({total:60,count:2});expect(result.id).toBeTruthy();
});

test('new host receives the reviewed revision, while the local approval remains private',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
   const {createLaptopClient}=await import('/src/laptop-client.ts'),conn={url:'wss://example.test/ws',token:'fixture'},revision='a'.repeat(64);
   const approval={id:'q',paneId:'p',sessionId:'s',title:'Enviar',message:'Contenido revisado',action:'send',kind:'confirm' as const,createdAt:'',expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true,questionRevision:revision};let sent:any,changed=true;
   const request=async(req:any)=>{const body=req.body?JSON.parse(req.body):null;if(!body)return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[],approvals:[{...approval,questionRevision:changed?'b'.repeat(64):revision}],policies:[],events:[]})};if(body.action==='answer'){sent=body;return {status:200,headers:{},body:JSON.stringify({accepted:true,sessionId:'s',instanceId:'i'})};}return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'waiting',messages:[],deliveries:[],question:null,history:{hasEarlier:false}})};};
   const client=createLaptopClient(conn,{current:()=>conn,request,receiptState:async()=> 'terminal'});let blocked=false;try{await client.act({action:'answer',paneId:'p',sessionId:'s',requestId:'q',approved:true,reviewedApproval:approval});}catch{blocked=true;}changed=false;await client.act({action:'answer',paneId:'p',sessionId:'s',requestId:'q',approved:true,reviewedApproval:approval});return {sent,blocked};
 });
 expect(result.blocked).toBe(true);expect(result.sent).toEqual({action:'answer',paneId:'p',sessionId:'s',requestId:'q',approved:true,expectedInstanceId:'i',expectedQuestionRevision:'a'.repeat(64)});
});

test('legacy Pi questions stay readable but both human response paths refuse an unbound answer',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
   const {createLaptopClient}=await import('/src/laptop-client.ts'),{createDesktopSessionClient}=await import('/src/desktop-tools.ts');
   const conn={url:'wss://example.test/ws',token:'fixture'},question={id:'q',kind:'confirm',title:'Enviar',message:'Contenido',expiresAt:'2099-01-01T00:00:00.000Z',answerable:true};
   const approval={...question,paneId:'p',sessionId:'s',action:'send',createdAt:''};let effects=0,asks=0;
   const request=async(req:any)=>{const body=req.body?JSON.parse(req.body):null;if(!body)return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[],approvals:[approval],policies:[],events:[]})};if(body.action==='inspect')return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'waiting',messages:[],deliveries:[],question,history:{hasEarlier:false}})};effects++;return {status:200,headers:{},body:'{}'};};
   const panel=createLaptopClient(conn,{current:()=>conn,request}),desktop=createDesktopSessionClient({getConnection:()=>conn,request});
   let panelBlocked=false,agentBlocked=false;try{await panel.act({action:'answer',paneId:'p',sessionId:'s',requestId:'q',approved:true,reviewedApproval:approval});}catch(error){panelBlocked=String(error).includes('responde en la laptop');}
   try{await desktop.answerFromHuman({paneId:'p',sessionId:'s',requestId:'q',confirmed:true},{signal:new AbortController().signal,askApproval:async()=>{asks++;return true;}});}catch(error){agentBlocked=String(error).includes('responde en la laptop');}
   return {panelBlocked,agentBlocked,effects,asks,readable:(await panel.inspect('p','s')).sessionId};
 });
 expect(result).toEqual({panelBlocked:true,agentBlocked:true,effects:0,asks:0,readable:'s'});
});

test('shared composer retries use fresh transport IDs and wait for native terminal plus human review',async({page})=>{
 await page.goto('/');
 const perform=async(phase:'first'|'retry'|'review'|'after')=>page.evaluate(async phase=>{
  const {createLaptopClient}=await import('/src/laptop-client.ts'),{createDesktopSessionClient}=await import('/src/desktop-tools.ts'),conn={url:'wss://example.test/ws',token:'fixture'};
  const receiptState=async()=>phase==='first'||phase==='retry'?'active' as const:'terminal' as const;
  const request=async(req:any)=>{const body=req.body?JSON.parse(req.body):null;if(!body)return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[],approvals:[],policies:[],events:[]})};if(body.action==='prompt'){
    const prior=JSON.parse(sessionStorage.getItem('prompt-attempts')??'[]');prior.push({receiptId:req.receiptId,receiptOwner:req.receiptOwner,clientMessageId:body.clientMessageId});sessionStorage.setItem('prompt-attempts',JSON.stringify(prior));
    if(phase==='first')throw new Error('early timeout');return {status:200,headers:{},body:JSON.stringify({accepted:true,sessionId:'s',instanceId:'i'})};
   }return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'idle',messages:[],deliveries:[],question:null,history:{hasEarlier:false}})};};
  const desktop=createDesktopSessionClient({getConnection:()=>conn,request,receiptState});let blocked=false;
  if(phase==='review') {const list=await desktop.listControls();await desktop.resolveControl({id:list.items[0].id},{signal:new AbortController().signal,askApproval:async()=>true});}
  else try{await createLaptopClient(conn,{current:()=>conn,request,receiptState}).act({action:'prompt',paneId:'p',sessionId:'s',text:'Exacto',clientMessageId:'same-client-message'});}catch{blocked=true;}
  return {blocked,attempts:JSON.parse(sessionStorage.getItem('prompt-attempts')??'[]'),records:await desktop.listControls()};
 },phase);
 const first=await perform('first');expect(first.blocked).toBe(true);expect(first.records.items[0].state).toBe('dispatching');expect(first.attempts).toHaveLength(1);
 await page.reload();const retry=await perform('retry');expect(retry.blocked).toBe(true);expect(retry.attempts).toHaveLength(1);
 const review=await perform('review');expect(review.attempts).toHaveLength(1);expect(review.records.items).toHaveLength(0);
 const after=await perform('after');expect(after.blocked).toBe(false);expect(after.attempts).toHaveLength(2);
 expect(after.attempts[0].clientMessageId).toBe('same-client-message');expect(after.attempts[1].clientMessageId).toBe('same-client-message');
 expect(after.attempts[0].receiptId).not.toBe(after.attempts[1].receiptId);expect(after.attempts[0].receiptId).not.toBe('same-client-message');
});

for (const first of ['panel','agent'] as const) test(`agent and panel block concurrent identical prompt from ${first}`,async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async first=>{
  const {createLaptopClient}=await import('/src/laptop-client.ts'),{createDesktopSessionClient}=await import('/src/desktop-tools.ts'),conn={url:'wss://example.test/ws',token:'fixture'};
  let sends=0,ready!:()=>void;const started=new Promise<void>(resolve=>ready=resolve),receiptState=async()=> 'active' as const;
  const request=async(req:any)=>{const body=req.body?JSON.parse(req.body):null;
   if(!body)return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[{paneId:'p',sessionId:'s',label:'Fixture',state:'idle',connected:true,capabilities:{inspect:true,prompt:true,abort:true,deliveryReceipts:true}}],approvals:[],policies:[],events:[]})};
   if(body.action==='prompt'){sends++;ready();return new Promise<any>(()=>{});}
   return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'idle',messages:[],deliveries:[],question:null,history:{hasEarlier:false}})};
  };
  const panel=createLaptopClient(conn,{current:()=>conn,request,receiptState,controlTimeoutMs:40});const agent=createDesktopSessionClient({getConnection:()=>conn,request,receiptState});
  const sendPanel=()=>panel.act({action:'prompt',paneId:'p',sessionId:'s',text:'Trabajo igual',clientMessageId:'ui-message'});
  const sendAgent=()=>agent.send({paneId:'p',sessionId:'s',text:'Trabajo igual'},{signal:new AbortController().signal,askApproval:async()=>true});
  (globalThis as any).held=(first==='panel'?sendPanel():sendAgent()).catch(()=>null);await started;
  let blocked=false;try{await (first==='panel'?sendAgent():sendPanel());}catch{blocked=true;}
  if(first==='panel')await (globalThis as any).held;
  const records=await agent.listControls();return {sends,blocked,state:records.items[0]?.state,total:records.total};
 },first);
 expect(result).toEqual({sends:1,blocked:true,state:'dispatching',total:1});
});

for(const first of ['panel','agent'] as const) test(`host ACK without Pi delivery blocks identical prompt from the other path after ${first}`,async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async first=>{
  const {createLaptopClient}=await import('/src/laptop-client.ts'),{createDesktopSessionClient}=await import('/src/desktop-tools.ts'),conn={url:'wss://example.test/ws',token:'fixture'};let sends=0;
  const request=async(req:any)=>{const body=req.body?JSON.parse(req.body):null;if(!body)return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[{paneId:'p',sessionId:'s',label:'Fixture',state:'idle',connected:true,capabilities:{inspect:true,prompt:true,abort:true,deliveryReceipts:true}}],approvals:[],policies:[],events:[]})};
   if(body.action==='prompt'){sends++;return {status:200,headers:{},body:JSON.stringify({accepted:true,sessionId:'s',instanceId:'i'})};}
   return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'idle',messages:[],deliveries:[],question:null,history:{hasEarlier:false}})};};
  const receiptState=async()=> 'terminal' as const,panel=createLaptopClient(conn,{current:()=>conn,request,receiptState}),agent=createDesktopSessionClient({getConnection:()=>conn,request,receiptState});
  const sendPanel=()=>panel.act({action:'prompt',paneId:'p',sessionId:'s',text:'Contenido igual',clientMessageId:'ui-ack'}),sendAgent=()=>agent.send({paneId:'p',sessionId:'s',text:'Contenido igual'},{signal:new AbortController().signal,askApproval:async()=>true});
  const initial=await(first==='panel'?sendPanel():sendAgent());let blocked=false;try{await(first==='panel'?sendAgent():sendPanel());}catch{blocked=true;}
  return {sends,blocked,initial,controls:await agent.listControls()};
 },first);
 expect(result.sends).toBe(1);expect(result.blocked).toBe(true);expect(result.controls.items[0].state).toBe('unconfirmed');
 if(first==='agent')expect(result.initial).toMatchObject({status:'accepted',completed:false});
});

test('only unique correlated Pi delivery on the same host and instance clears the composer notice',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
  const {createLaptopClient}=await import('/src/laptop-client.ts'),{createDesktopSessionClient}=await import('/src/desktop-tools.ts'),conn={url:'wss://example.test/ws',token:'fixture'};
  let evidence:any,instance='i';const receiptState=async()=> 'terminal' as const;
  const receipt=()=>({id:'unique-message-id',status:'delivered',deliverAs:'followUp',acceptedAt:'2026-10-29T12:00:00Z',...(evidence?{evidence}:{}),preview:'Igual'});
  const request=async(req:any)=>{const body=req.body?JSON.parse(req.body):null;if(!body)return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[],approvals:[],policies:[],events:[]})};if(body.action==='prompt')return {status:200,headers:{},body:JSON.stringify({accepted:true,sessionId:'s',instanceId:'i'})};return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:instance,status:'idle',messages:[],deliveries:evidence==='none'?[]:[receipt()],question:null,history:{hasEarlier:false}})};};
  evidence='none';const laptop=createLaptopClient(conn,{current:()=>conn,request,receiptState}),desktop=createDesktopSessionClient({getConnection:()=>conn,request,receiptState});
  await laptop.act({action:'prompt',paneId:'p',sessionId:'s',text:'Igual',clientMessageId:'unique-message-id'});
  evidence=undefined;await laptop.inspect('p','s');const legacy=(await desktop.listControls()).total;
  evidence='correlated-v1';instance='other';await laptop.inspect('p','s');const wrong=(await desktop.listControls()).total;
  instance='i';await laptop.inspect('p','s');const confirmed=(await desktop.listControls()).total;
  return {legacy,wrong,confirmed};
 });
 expect(result).toEqual({legacy:1,wrong:1,confirmed:0});
});

test('a reused host message ID cannot reconcile two separate native attempts',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
  const {createLaptopClient}=await import('/src/laptop-client.ts'),{createDesktopSessionClient}=await import('/src/desktop-tools.ts'),conn={url:'wss://example.test/ws',token:'fixture'},receiptState=async()=> 'terminal' as const;let delivered=false;
  const request=async(req:any)=>{const body=req.body?JSON.parse(req.body):null;if(!body)return {status:200,headers:{},body:JSON.stringify({available:true,mutationInstanceFence:1,sessions:[],approvals:[],policies:[],events:[]})};if(body.action==='prompt')return {status:200,headers:{},body:JSON.stringify({accepted:true,sessionId:'s',instanceId:'i'})};return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'idle',messages:[],deliveries:delivered?[{id:'reused-message-id',status:'delivered',evidence:'correlated-v1',deliverAs:'followUp',acceptedAt:'2026-10-29T12:00:00Z'}]:[],question:null,history:{hasEarlier:false}})};};
  const panel=createLaptopClient(conn,{current:()=>conn,request,receiptState}),desktop=createDesktopSessionClient({getConnection:()=>conn,request,receiptState});
  const action={action:'prompt' as const,paneId:'p',sessionId:'s',text:'Igual',clientMessageId:'reused-message-id'};
  await panel.act(action);const first=(await desktop.listControls()).items[0];await desktop.resolveControl({id:first.id},{signal:new AbortController().signal,askApproval:async()=>true});await panel.act(action);
  delivered=true;await panel.inspect('p','s');return (await desktop.listControls()).total;
 });
 expect(result).toBe(1);
});
