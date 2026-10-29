import {expect,test} from './fixtures.ts';

test('chat approval path cannot approve and journals a lost rejection across helper recreation',async({page})=>{
  await page.goto('/');
  const exercise=(phase:'first'|'retry')=>page.evaluate(async phase=>{
    const {createTrustedApprovals}=await import('/src/trusted-approvals.ts'),{createDesktopSessionClient}=await import('/src/desktop-tools.ts');
    const conn={url:'wss://example.test/ws',token:'t'.repeat(48)},card={id:'app-test',title:'Enviar',message:'Texto exacto',expiresAt:'2099-01-01T00:00:00.000Z',revision:'550e8400-e29b-41d4-a716-446655440000'};
    const request=async(req:any)=>{
      if(req.method==='GET')return {status:200,headers:{},body:JSON.stringify({approvals:[card]})};
      const posts=JSON.parse(sessionStorage.getItem('chat-approval-posts')??'[]');posts.push({url:req.url,body:JSON.parse(req.body),receipt:!!req.receiptId&&!!req.receiptOwner});sessionStorage.setItem('chat-approval-posts',JSON.stringify(posts));
      throw Error('lost callback');
    };
    const helper=createTrustedApprovals({getConnection:()=>conn,request});const [shown]=await helper.list();let allowed=false,rejected=false;
    try{await helper.answer(shown,true);}catch{allowed=true;}
    try{await helper.answer(shown,false);}catch{rejected=true;}
    const journal=await createDesktopSessionClient({getConnection:()=>conn,request,receiptState:async()=> 'active'}).listControls();
    return {allowed,rejected,posts:JSON.parse(sessionStorage.getItem('chat-approval-posts')??'[]'),journal};
  },phase);
  const first=await exercise('first');expect(first.allowed).toBe(true);expect(first.rejected).toBe(true);
  expect(first.posts).toHaveLength(1);expect(first.posts[0]).toMatchObject({url:'https://example.test/api/mobile/answer-v1',receipt:true,body:{approved:false,review:{revision:'550e8400-e29b-41d4-a716-446655440000',message:'Texto exacto'}}});
  expect(first.journal.items[0]).toMatchObject({kind:'dotAnswer',state:'dispatching'});
  await page.reload();const second=await exercise('retry');expect(second.allowed).toBe(true);expect(second.rejected).toBe(true);expect(second.posts).toHaveLength(1);expect(second.journal.items[0]).toMatchObject({kind:'dotAnswer',state:'dispatching'});
});

test('chat cards only offer a journaled refusal and ignore an approval read after resolution',async({page})=>{
 const token='t'.repeat(48);let emit:(value:object)=>void=()=>{},disconnect:()=>void=()=>{};
 await page.addInitScript(({token})=>{
  const state=globalThis as any;state.isTauri=true;state.posts=[];state.card={id:'ask-1',title:'Permiso de prueba',message:'Destino y contenido sintéticos',expiresAt:'2099-01-01T00:00:00.000Z',revision:'550e8400-e29b-41d4-a716-446655440000'};
  state.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
    const name=command.split('|').at(-1),req=args?.request??{};
    if(name==='secret_get'){const value=sessionStorage.getItem(`key:${req.scope}:${req.account}`);return value===null?{ok:true}:{ok:true,value};}
    if(name==='secret_set'){const key=`key:${req.scope}:${req.account}`;if(req.compare===true && sessionStorage.getItem(key)!==(req.expected??null))return {ok:true,persisted:false};sessionStorage.setItem(key,req.value);return {ok:true,persisted:true};}
    if(name==='share_list'||name==='documents_list')return {ok:true,items:[]};
    if(name==='https_receipt_state')return {ok:true,receiptState:'active'};
    if(name==='https_request'){
      if(req.method==='GET') {if(state.holdRead){state.readStarted=true;await new Promise<void>(resolve=>{state.releaseRead=resolve;});}return {ok:true,status:200,headers:{},body:JSON.stringify({approvals:[state.card]})};}
      state.posts.push({url:req.url,body:JSON.parse(req.body),receipt:!!req.receiptId&&!!req.receiptOwner});throw Error('callback lost');
    }
    if(name==='check_availability')return {available:false,status:'sdk_unavailable',supportsSpanish:false};
    if(name==='list_voice_receipts')return {ok:true,receipts:[]};if(name==='inspect_retained_voice')return {ok:true,retainedAudio:null};
    return {ok:true};
  }};
 },{token});
 await page.routeWebSocket('wss://example.test/ws',ws=>{let sequence=0;emit=value=>ws.send(JSON.stringify({seq:sequence++,...value}));disconnect=()=>ws.close();ws.onMessage(raw=>{const message=JSON.parse(String(raw));if(message.type==='hello')emit({type:'ready',agentState:'idle',conversationId:'main'});if(message.type==='get_history')emit({type:'history',conversationId:'main',messages:[]});});});
 await page.goto('/');await page.locator('[data-panel="settings"]').click();if(!await page.locator('#url').isVisible())await page.getByText('Conexión manual',{exact:true}).click();
 await page.locator('#url').fill('wss://example.test/ws');await page.locator('#token').fill(token);await page.locator('#connection button[type="submit"]').click();await expect(page.locator('#status')).toContainText('Vinculado a Gentle Dot');
 await page.locator('[data-panel="chat"]').click();emit({type:'ask',ask:{requestId:'ask-1',method:'app',title:'Permiso de prueba'}});
 const card=page.locator('#requests .review-card').filter({hasText:'Permiso de prueba'}).last();await expect(card).toContainText('Destino y contenido sintéticos');await expect(card.getByRole('button',{name:'Permitir'})).toHaveCount(0);
 await card.getByRole('button',{name:'Rechazar'}).click();await expect(card).toContainText('No se confirmó el rechazo');
 const posts=await page.evaluate(()=>(globalThis as any).posts);expect(posts).toHaveLength(1);expect(posts[0]).toMatchObject({url:'https://example.test/api/mobile/answer-v1',receipt:true,body:{approved:false,review:{revision:'550e8400-e29b-41d4-a716-446655440000'}}});
 emit({type:'ask_resolved',requestId:'ask-1'});
 await page.evaluate(()=>{(globalThis as any).card={...(globalThis as any).card,id:'ask-2',title:'Tardía'};(globalThis as any).holdRead=true;});
 emit({type:'ask',ask:{requestId:'ask-2',method:'app',title:'Tardía'}});await expect.poll(()=>page.evaluate(()=>(globalThis as any).readStarted)).toBe(true);
 emit({type:'ask_resolved',requestId:'ask-2'});await page.evaluate(()=>(globalThis as any).releaseRead());
 await expect(page.locator('#requests .review-card').filter({hasText:'Tardía'})).toHaveCount(0);
 await page.evaluate(()=>{(globalThis as any).card={...(globalThis as any).card,id:'ask-3',title:'Anterior a reconexión'};(globalThis as any).holdRead=true;(globalThis as any).readStarted=false;});
 emit({type:'ask',ask:{requestId:'ask-3',method:'app',title:'Anterior a reconexión'}});await expect.poll(()=>page.evaluate(()=>(globalThis as any).readStarted)).toBe(true);
 disconnect();await expect(page.locator('#status')).not.toContainText('Vinculado a Gentle Dot');
 await page.evaluate(()=>{(globalThis as any).holdRead=false;(globalThis as any).releaseRead();});
 await expect(page.locator('#requests .review-card').filter({hasText:'Anterior a reconexión'})).toHaveCount(0);
 await expect(page.locator('#status')).toContainText('Vinculado a Gentle Dot');
 emit({type:'ask',ask:{requestId:'ask-3',method:'app',title:'Anterior a reconexión'}});
 await expect(page.locator('#requests .review-card').filter({hasText:'Anterior a reconexión'})).toHaveCount(1);
 emit({type:'ask_resolved',requestId:'ask-3'});
 await page.evaluate(()=>{const {revision,...legacy}=(globalThis as any).card;(globalThis as any).card={...legacy,id:'ask-4',title:'Host anterior'};});
 emit({type:'ask',ask:{requestId:'ask-4',method:'app',title:'Host anterior'}});
 const legacy=page.locator('#requests .review-card').filter({hasText:'Host anterior'});await expect(legacy).toContainText('necesita actualizarse');await expect(legacy.getByRole('button')).toHaveCount(0);
});
