import { test, expect } from './fixtures.ts';
test('durable draft rescue is accessible while native inference recovery is waiting', async ({page}) => {
  await page.goto('/');
  await page.evaluate(async()=>{const {createConversationDraftRescue}=await import('/src/conversation-draft-rescue.ts'); await createConversationDraftRescue().save({schema:'capri-draft-rescue/v1',owner:'00000000-0000-4000-8000-000000000001',sequence:1,baseRevision:0,draft:'Copia importante'});});
  await page.addInitScript(()=>{const s=globalThis as any;s.isTauri=true;s.inferenceStarted=false;s.__TAURI_INTERNALS__={invoke:async(command:string)=>{if(command.endsWith('results_list')){s.inferenceStarted=true;return await new Promise(()=>{});}if(command.endsWith('share_list')||command.endsWith('documents_list')||command.endsWith('list_voice_receipts'))return {ok:true,items:[],receipts:[]};if(command.endsWith('check_availability'))return {available:false,status:'model_not_ready',supportsSpanish:false};return {ok:true};}};});
  await page.reload();
  await expect.poll(()=>page.evaluate(()=>(globalThis as any).inferenceStarted)).toBe(true);
  await expect(page.getByText('Borrador para recuperar')).toBeVisible({timeout:3000});
  await page.getByText('Borrador para recuperar').click(); await expect(page.getByText('Copia importante')).toBeVisible();
});

test('early rescue stays read-only until the previous base is restored', async ({page}) => {
  await page.goto('/'); await expect(page.locator('#history-loading')).toBeHidden();
  await page.evaluate(async()=>{ const conversation=await import('/src/conversation.ts'), rescue=await import('/src/conversation-draft-rescue.ts');
    let saved=false; for(let i=0;i<40&&!saved;i++){const base=await conversation.loadConversationBase();try {await conversation.saveConversation({revision:(base?.revision??0)+1,draft:'Base anterior',entries:[]});saved=true;}catch{await new Promise(resolve=>setTimeout(resolve,50));}} if(!saved) throw new Error('No pude preparar base.');
    await rescue.createConversationDraftRescue().save({schema:'capri-draft-rescue/v1',owner:'00000000-0000-4000-8000-000000000002',sequence:1,baseRevision:1,draft:'Copia distinta'});
  });
  await page.addInitScript(()=>{const s=globalThis as any, original=IDBFactory.prototype.open; let held=false;
    IDBFactory.prototype.open=function(name:string, version?:number) {const req=Reflect.apply(original,this,version===undefined?[name]:[name,version]);
      if(name==='capri-ios-conversation'&&!held){held=true;let callback:((event:Event)=>void)|null=null;Object.defineProperty(req,'onsuccess',{configurable:true,get:()=>callback,set:value=>{callback=value;}});
        req.addEventListener('success',(event:Event)=>{s.releaseBase=()=>callback?.call(req,event);});}return req;};});
  await page.reload(); await expect.poll(()=>page.evaluate(()=>typeof (globalThis as any).releaseBase)).toBe('function');
  const summary=page.getByText('Borrador para recuperar'); await expect(summary).toBeVisible(); await summary.click();
  const append=page.getByRole('button',{name:'Añadir al mensaje'}), discard=page.getByRole('button',{name:'Descartar copia'});
  await expect(append).toBeDisabled(); await expect(discard).toBeDisabled();
  await append.evaluate((button:HTMLButtonElement)=>button.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  await discard.evaluate((button:HTMLButtonElement)=>button.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  expect(await page.locator('#prompt').inputValue()).toBe('');
  expect(await page.evaluate(async()=>(await (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue().list()).map(x=>x.draft))).toContain('Copia distinta');
  await page.evaluate(()=>(globalThis as any).releaseBase());
  await expect(page.locator('#prompt')).toHaveValue('Base anterior');
  const activeSummary=page.getByText('Borrador para recuperar'); await expect(activeSummary).toBeVisible(); await activeSummary.click();
  await expect(append).toBeEnabled(); await append.click(); await expect(page.locator('#prompt')).toHaveValue('Base anterior\nCopia distinta');
});

test('late native inference recovery cannot overwrite an explicitly restored draft', async ({page}) => {
  await page.goto('/'); await expect(page.locator('#history-loading')).toBeHidden();
  await page.evaluate(async()=>{const conversation=await import('/src/conversation.ts'),rescue=await import('/src/conversation-draft-rescue.ts');
    let saved=false; for(let i=0;i<40&&!saved;i++){const base=await conversation.loadConversationBase();try {await conversation.saveConversation({revision:(base?.revision??0)+1,draft:'Base anterior',entries:[{id:'d3dba896-4b5c-4c1c-98c9-4e60238fe6b9',role:'assistant',engine:'iphone',state:'pending',text:'',at:1234}]});saved=true;}catch{await new Promise(resolve=>setTimeout(resolve,50));}} if(!saved)throw new Error('No pude preparar base.');
    await rescue.createConversationDraftRescue().save({schema:'capri-draft-rescue/v1',owner:'00000000-0000-4000-8000-000000000003',sequence:1,baseRevision:1,draft:'Copia preservada'});
  });
  await page.addInitScript(()=>{const state=globalThis as any;state.isTauri=true;state.__TAURI_INTERNALS__={invoke:async(command:string)=>{
    if(command.endsWith('results_list')){if(sessionStorage.getItem('ack-draft-test')==='yes')return {ok:true,items:[]};return await new Promise(resolve=>{state.finishInference=()=>resolve({ok:true,items:[{id:'d3dba896-4b5c-4c1c-98c9-4e60238fe6b9',revision:'a3dba896-4b5c-4c1c-98c9-4e60238fe6b9',startedAt:1234,status:'answer',text:'Respuesta recuperada'}]});});}
    if(command.endsWith('results_acknowledge')){sessionStorage.setItem('ack-draft-test','yes');return {ok:true};}
    if(command.endsWith('share_list')||command.endsWith('documents_list')||command.endsWith('list_voice_receipts'))return {ok:true,items:[],receipts:[]};
    if(command.endsWith('check_availability'))return {available:false,status:'model_not_ready',supportsSpanish:false};return {ok:true};}};});
  await page.reload(); await expect.poll(()=>page.evaluate(()=>typeof (globalThis as any).finishInference)).toBe('function');
  await expect(page.locator('#prompt')).toHaveValue('Base anterior'); await page.getByText('Borrador para recuperar').click();
  await page.getByRole('button',{name:'Añadir al mensaje'}).click(); await expect(page.locator('#prompt')).toHaveValue('Base anterior\nCopia preservada');
  await page.evaluate(()=>(globalThis as any).finishInference()); await expect(page.locator('#cards')).toContainText('Respuesta recuperada');
  await expect.poll(()=>page.evaluate(()=>sessionStorage.getItem('ack-draft-test'))).toBe('yes');
  await expect(page.locator('#prompt')).toHaveValue('Base anterior\nCopia preservada');
  await page.reload(); await expect(page.locator('#prompt')).toHaveValue('Base anterior\nCopia preservada');
});
