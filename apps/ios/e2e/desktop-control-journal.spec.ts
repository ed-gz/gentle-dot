import {expect,test} from './fixtures.ts';

test('a lost human answer blocks changed answers from both the panel and agent after restart',async({page})=>{
  await page.goto('/');
  const perform=async(source:'panel'|'agent',text:string)=>page.evaluate(async({source,text})=>{
    const {createLaptopClient}=await import('/src/laptop-client.ts'),{createDesktopSessionClient}=await import('/src/desktop-tools.ts');
    const conn={url:'wss://example.test/ws',token:'fixture'},target={paneId:'p',sessionId:'s'};
    const question={id:'q1',kind:'input',title:'Pregunta',message:'Indica la respuesta',expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
    const approval={...question,paneId:'p',sessionId:'s',action:question.title,createdAt:''};
    const request=async(req:any)=>{const body=req.body?JSON.parse(req.body):null;
      if(!body)return {status:200,headers:{},body:JSON.stringify({available:true,sessions:[],approvals:[approval],policies:[],events:[]})};
      if(body?.action==='answer'){sessionStorage.setItem('control-sends',String(Number(sessionStorage.getItem('control-sends')??0)+1));throw new Error('lost ACK');}
      return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'waiting',messages:[],deliveries:[],question,history:{hasEarlier:false}})};
    };
    let blocked=false;try{
      if(source==='panel')await createLaptopClient(conn,{current:()=>conn,request}).act({action:'answer',...target,requestId:'q1',text,reviewedApproval:approval});
      else await createDesktopSessionClient({getConnection:()=>conn,request}).answerFromHuman({...target,requestId:'q1',text},{signal:new AbortController().signal,askApproval:async()=>true});
    }catch{blocked=true;}
    const client=createDesktopSessionClient({getConnection:()=>conn,request});
    return {blocked,sends:Number(sessionStorage.getItem('control-sends')??0),records:await client.listControls()};
  },{source,text});
  const first=await perform('panel','Primera');expect(first.blocked).toBe(true);expect(first.sends).toBe(1);expect(first.records.items[0].state).toBe('unconfirmed');
  await page.reload();const duplicate=await perform('agent','Diferente');expect(duplicate.blocked).toBe(true);expect(duplicate.sends).toBe(1);expect(duplicate.records.items).toHaveLength(1);
});

test('a control in flight cannot be reviewed or duplicated from another window',async({page,context})=>{
  await page.goto('/');const other=await context.newPage();await other.goto('/');
  await page.evaluate(async()=>{
    const {createLaptopClient}=await import('/src/laptop-client.ts'),conn={url:'wss://example.test/ws',token:'fixture'};let ready!:()=>void;const started=new Promise<void>(r=>ready=r);
    const request=async(req:any)=>{const body=JSON.parse(req.body);if(body.action==='abort'){ready();return new Promise<any>(()=>{});}return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'working',messages:[],deliveries:[],question:null,history:{hasEarlier:false}})};};
    (globalThis as any).pending=createLaptopClient(conn,{current:()=>conn,request}).act({action:'abort',paneId:'p',sessionId:'s'});await started;
  });
  const verify=async()=>other.evaluate(async()=>{
    const {createDesktopSessionClient}=await import('/src/desktop-tools.ts'),conn={url:'wss://example.test/ws',token:'fixture'};
    const request=async(req:any)=>({status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',messages:[],deliveries:[]})});
    const client=createDesktopSessionClient({getConnection:()=>conn,request});const records=await client.listControls();let approval=0,blocked=false;
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
    const approval={...question,paneId:'p',sessionId:'s',action:question.title,createdAt:''};
    const request=async(req:any)=>{const body=req.body?JSON.parse(req.body):null;if(!body)return {status:200,headers:{},body:JSON.stringify({available:true,sessions:[],approvals:[approval],policies:[],events:[]})};if(body.action==='answer'){sends++;throw new Error('lost ACK');}return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'waiting',messages:[],deliveries:[],question,history:{hasEarlier:false}})};};
    const panel=createLaptopClient(conn,{current:()=>conn,request}),desktop=createDesktopSessionClient({getConnection:()=>conn,request});
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
    const approval={id:'q1',paneId:'p',sessionId:'s',title:'Enviar',message:'Texto original',action:'send',kind:'confirm' as const,createdAt:'',expiresAt:new Date(Date.now()+60000).toISOString(),answerable:true};
    let changed=true;const sent:any[]=[];
    const request=async(req:any)=>{const body=req.body?JSON.parse(req.body):null;if(!body)return {status:200,headers:{},body:JSON.stringify({available:true,sessions:[],approvals:[{...approval,message:changed?'Texto cambiado':approval.message}],policies:[],events:[]})};
      if(body.action==='answer'){sent.push(body);return {status:200,headers:{},body:JSON.stringify({accepted:true,sessionId:'s',instanceId:'i'})};}
      return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'waiting',messages:[],deliveries:[],question:null,history:{hasEarlier:false}})};
    };
    const client=createLaptopClient(conn,{current:()=>conn,request});let blocked=false;try{await client.act({action:'answer',paneId:'p',sessionId:'s',requestId:'q1',approved:true,reviewedApproval:approval});}catch{blocked=true;}
    changed=false;await client.act({action:'answer',paneId:'p',sessionId:'s',requestId:'q1',approved:true,reviewedApproval:approval});
    return {blocked,sent};
  });
  expect(result.blocked).toBe(true);expect(result.sent).toEqual([{action:'answer',paneId:'p',sessionId:'s',requestId:'q1',approved:true}]);
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
