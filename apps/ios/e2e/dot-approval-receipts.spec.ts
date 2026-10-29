import { expect, test } from './fixtures.ts';

test('a lost Dot answer stays reserved after restart and can be reviewed without resending', async ({page}) => {
  await page.goto('/');
  const attempt = (phase:'send'|'retry'|'review'|'after') => page.evaluate(async phase => {
    const {createLaptopClient}=await import('/src/laptop-client.ts');
    const {createDesktopSessionClient}=await import('/src/desktop-tools.ts');
    const conn={url:'wss://example.test/ws',token:'fixture'};
    const card={id:'request-1',title:'Enviar',message:'Destinatario: test@example.test',expiresAt:'2099-01-01T00:00:00.000Z',revision:'550e8400-e29b-41d4-a716-446655440000'};
    const receiptState=async()=>phase==='review'?'terminal' as const:'active' as const;
    const request=async(req:any)=>{
      if(req.method==='GET')return {status:200,headers:{},body:JSON.stringify({approvals:[card]})};
      sessionStorage.setItem('dot-posts',JSON.stringify([...(JSON.parse(sessionStorage.getItem('dot-posts')??'[]')),{url:req.url,body:JSON.parse(req.body),receipt:!!req.receiptId&&!!req.receiptOwner}]));
      if(phase==='send')throw new Error('lost callback');
      return {status:200,headers:{},body:JSON.stringify({ok:true,requestId:card.id,revision:card.revision})};
    };
    const panel=createLaptopClient(conn,{current:()=>conn,request,receiptState});
    const desktop=createDesktopSessionClient({getConnection:()=>conn,request,receiptState});
    let blocked=false;
    if(phase==='review') {const records=await desktop.listControls();await desktop.resolveControl({id:records.items[0].id},{signal:new AbortController().signal,askApproval:async()=>true});}
    else try {await panel.answerDotApproval!(card.id,false,card);} catch {blocked=true;}
    return {blocked,posts:JSON.parse(sessionStorage.getItem('dot-posts')??'[]'),records:await desktop.listControls()};
  },phase);
  const first=await attempt('send');expect(first.blocked).toBe(true);expect(first.posts).toHaveLength(1);expect(first.posts[0]).toMatchObject({url:'https://example.test/api/mobile/answer-v1',receipt:true,body:{approved:false,review:{message:'Destinatario: test@example.test'}}});expect(first.records.items[0]).toMatchObject({kind:'dotAnswer',state:'dispatching'});
  await page.reload();const retry=await attempt('retry');expect(retry.blocked).toBe(true);expect(retry.posts).toHaveLength(1);
  const reviewed=await attempt('review');expect(reviewed.posts).toHaveLength(1);expect(reviewed.records.items).toHaveLength(0);
  const after=await attempt('after');expect(after.blocked).toBe(false);expect(after.posts).toHaveLength(2);
});

test('changed cards, legacy cards and wrong acknowledgements do not authorize or confirm a different request', async ({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {createLaptopClient}=await import('/src/laptop-client.ts'),{createDesktopSessionClient}=await import('/src/desktop-tools.ts');
    const conn={url:'wss://example.test/ws',token:'fixture'},card={id:'request-2',title:'Acción',message:'Contenido',expiresAt:'2099-01-01T00:00:00.000Z',revision:'550e8400-e29b-41d4-a716-446655440000'};let changed=true,posts=0;
    const request=async(req:any)=>{if(req.method==='GET')return {status:200,headers:{},body:JSON.stringify({approvals:[changed?{...card,message:'Otro contenido'}:card]})};posts++;return {status:200,headers:{},body:JSON.stringify({ok:true,requestId:card.id,revision:'wrong'})};};
    const receiptState=async()=> 'terminal' as const,panel=createLaptopClient(conn,{current:()=>conn,request,receiptState});
    let mismatch=false,legacy=false,badAck=false,approvalBlocked=false;
    try{await panel.answerDotApproval!(card.id,false,card);}catch{mismatch=true;}
    try{await panel.answerDotApproval!(card.id,false,{...card,revision:undefined});}catch(error){legacy=String(error).includes('necesita actualizarse');}
    try{await panel.answerDotApproval!(card.id,true,card);}catch{approvalBlocked=true;}
    changed=false;try{await panel.answerDotApproval!(card.id,false,card);}catch{badAck=true;}
    return {mismatch,legacy,badAck,approvalBlocked,posts,records:await createDesktopSessionClient({getConnection:()=>conn,request,receiptState}).listControls()};
  });
  expect(result).toMatchObject({mismatch:true,legacy:true,badAck:true,approvalBlocked:true,posts:1});expect(result.records.items[0]).toMatchObject({kind:'dotAnswer',state:'unconfirmed'});
});

test('a host downgraded after the read never receives an answer on its legacy endpoint',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {createLaptopClient}=await import('/src/laptop-client.ts'),conn={url:'wss://example.test/ws',token:'fixture'},card={id:'request-3',title:'Acción',message:'Contenido',expiresAt:'2099-01-01T00:00:00.000Z',revision:'550e8400-e29b-41d4-a716-446655440000'};const posts:string[]=[];
    const request=async(req:any)=>{if(req.method==='GET')return {status:200,headers:{},body:JSON.stringify({approvals:[card]})};posts.push(req.url);return {status:404,headers:{},body:'not found'};};
    let rejected=false;try{await createLaptopClient(conn,{current:()=>conn,request,receiptState:async()=> 'terminal'}).answerDotApproval!(card.id,false,card);}catch{rejected=true;}return {rejected,posts};
  });
  expect(result).toEqual({rejected:true,posts:['https://example.test/api/mobile/answer-v1']});
});

test('two views declining the same card reserve one transport',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {createLaptopClient}=await import('/src/laptop-client.ts');
    const conn={url:'wss://example.test/ws',token:'fixture'},card={id:'request-4',title:'Acción',message:'Contenido',expiresAt:'2099-01-01T00:00:00.000Z',revision:'550e8400-e29b-41d4-a716-446655440000'};let posts=0;
    const request=async(req:any)=>{if(req.method==='GET')return {status:200,headers:{},body:JSON.stringify({approvals:[card]})};posts++;return new Promise<any>(()=>{});};
    const options={current:()=>conn,request,receiptState:async()=> 'active' as const,controlTimeoutMs:20};
    const a=createLaptopClient(conn,options),b=createLaptopClient(conn,options);
    const statuses=await Promise.allSettled([a.answerDotApproval!(card.id,false,card),b.answerDotApproval!(card.id,false,card)]);
    return {posts,statuses:statuses.map(x=>x.status)};
  });
  expect(result).toEqual({posts:1,statuses:['rejected','rejected']});
});
