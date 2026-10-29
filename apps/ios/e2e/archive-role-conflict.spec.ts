import {expect,test} from './fixtures.ts';

test('archive rejects a conflicting role for a previously pruned message ID',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {createConversationArchive}=await import('/src/conversation-archive.ts');
    const archive=createConversationArchive({databaseName:'archive-conflict-fixture'});
    const old={id:'host:wss://example.invalid/ws|c1|s0-1',engine:'gentle' as const,role:'user' as const,state:'complete' as const,text:'Solicitud anterior',at:1};
    await archive.upsert([old]);let error='';
    try{await archive.upsert([{...old,role:'assistant',text:'Respuesta diferente'}]);}catch(e){error=e instanceof Error?e.message:'';}
    let batchError='';try{await archive.upsert([{...old,id:'batch'},{...old,id:'batch',role:'assistant'}]);}catch(e){batchError=e instanceof Error?e.message:'';}
    const found=await archive.page();return {error,batchError,found:found.entries.map(({id,role,text})=>({id,role,text}))};
  });
  expect(result.error).toMatch(/identidad|rol/i);
  expect(result.batchError).toMatch(/identidad|rol/i);
  expect(result.found).toEqual([{id:'host:wss://example.invalid/ws|c1|s0-1',role:'user',text:'Solicitud anterior'}]);
});
