import { expect, test } from './fixtures.ts';

test('a failed activity save stops the next model step after a local effect', async ({page})=>{
  await page.addInitScript(()=>{
    const state=globalThis as any;state.isTauri=true;state.steps=0;state.failedEvidenceWrites=0;
    const original=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(value:any,key?:IDBValidKey){
      if(value?.schema==='capri-conversation-write-rescue/v1' && value.entries?.some((entry:any)=>entry.activities?.some((activity:any)=>activity.status==='done' && activity.title==='Guardando trabajo'))){
        state.failedEvidenceWrites++;throw new DOMException('Cuota simulada','QuotaExceededError');
      }
      return Reflect.apply(original,this,key===undefined?[value]:[value,key]);
    };
    const decision=(kind:string,toolName:string,args:unknown,text='')=>({ok:true,decision:{kind,toolName,argumentsJSON:JSON.stringify(args),text}});
    state.__TAURI_INTERNALS__={invoke:async(command:string)=>{
      if(command.endsWith('check_availability'))return {available:true,status:'available',supportsSpanish:true};
      if(command.endsWith('results_list')||command.endsWith('share_list')||command.endsWith('documents_list'))return {ok:true,items:[]};
      if(command.endsWith('agent_step')){switch(++state.steps){
        case 1:return decision('tool','tool_describe',{name:'work_create'});
        case 2:return decision('tool','work_create',{title:'Trabajo con evidencia',kind:'task',instruction:'Revisar'});
        default:return decision('answer','',{},'NO DEBERÍA ALCANZAR ESTE PASO');
      }}
      return {ok:true};
    }};
  });
  await page.goto('/');await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#prompt').fill('Guarda el trabajo.');await page.locator('#send').click();
  await expect(page.locator('#storage-warning')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(globalThis as any).failedEvidenceWrites)).toBeGreaterThan(0);
  expect(await page.evaluate(()=>(globalThis as any).steps)).toBe(2);
  const work=await page.evaluate(async()=> (await (await import('/src/work-inbox.ts')).listWork()).find(item=>item.title==='Trabajo con evidencia'));
  expect(work?.instruction).toBe('Revisar');
  const trace=page.locator('.chat-card[data-role="assistant"] .tool-trace');
  await expect(trace).toContainText('Guardando trabajo');await trace.locator(':scope > summary').click();
  await expect(trace.locator('li[data-status="done"]')).toContainText('Guardando trabajo');
  await expect(page.locator('#send')).toBeDisabled();
});
