import { createHash } from 'node:crypto';
import { expect, test } from './fixtures.ts';

test('a damaged manifest and a failed file read do not hide healthy imports and remain recoverable', async ({page}) => {
  const contents='synthetic voice memo';
  const digest=createHash('sha256').update(contents).digest('hex');
  const first='a5a6e456-7a93-4bcc-b006-4493c78b5b66', second='b5a6e456-7a93-4bcc-b006-4493c78b5b66', damaged='c5a6e456-7a93-4bcc-b006-4493c78b5b66';
  await page.addInitScript(({contents,digest,first,second,damaged})=>{
    const state=globalThis as any;
    state.isTauri=true;state.testShare={pending:[first,second],broken:true,failRead:true,staging:true,ack:[] as string[]};
    const item=(id:string)=>({schemaVersion:1,id,createdAt:1,title:id===first?'Audio sano':'Audio recuperable',notes:'',files:[{id:'d5a6e456-7a93-4bcc-b006-4493c78b5b66',name:'nota.m4a',mime:'audio/mp4',size:contents.length,sha256:digest}]});
    state.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
      if(command.endsWith('share_list'))return {ok:true,items:state.testShare.pending.map(item),invalidIds:state.testShare.broken?[damaged]:[],pendingCopies:state.testShare.staging?[{id:'e5a6e456-7a93-4bcc-b006-4493c78b5b66',bytes:12345}]:[],omittedPending:0};
      if(command.endsWith('documents_list'))return {ok:true,items:[],invalidIds:[]};
      if(command.endsWith('share_read')) {const request=args.request;if(request.id===second&&state.testShare.failRead)throw Error('lectura interrumpida');return {ok:true,data:btoa(contents.slice(request.offset,request.offset+request.length))};}
      if(command.endsWith('share_ack')) {state.testShare.ack.push(args.request.id);state.testShare.pending=state.testShare.pending.filter((id:string)=>id!==args.request.id);return {ok:true};}
      if(command.endsWith('check_availability'))return {available:false,status:'sdk_unavailable',supportsSpanish:false};
      if(command.endsWith('list_voice_receipts'))return {ok:true,receipts:[]};
      if(command.endsWith('inspect_retained_voice'))return {ok:true,retainedAudio:null};
      return {ok:true};
    }};
  },{contents,digest,first,second,damaged});
  await page.goto('/');
  const panel=page.getByRole('group',{name:'Recuperación de archivos'});
  await expect(panel).toContainText(`material ${damaged}`);
  await expect(panel).toContainText('Audio recuperable');
  await expect(panel).toContainText('La copia original se conserva');
  await expect(panel).toContainText(/12[.,]345 bytes/);
  await expect(panel).toContainText('aún no hay una forma de recuperarla desde Capri');
  await expect.poll(()=>page.evaluate(()=>((globalThis as any).testShare.ack as string[]))).toEqual([first]);
  expect(await page.evaluate(async()=>(await (await import('/src/work-inbox.ts')).listWork()).map(x=>x.title))).toEqual(['Audio sano']);
  await page.evaluate(()=>{(globalThis as any).testShare.failRead=false;(globalThis as any).testShare.broken=false;(globalThis as any).testShare.staging=false;});
  await panel.getByRole('button',{name:'Reintentar'}).first().click();
  await expect.poll(()=>page.evaluate(()=>((globalThis as any).testShare.ack as string[]))).toEqual([first,second]);
  await expect(panel).toBeHidden();
  expect((await page.evaluate(async()=>(await (await import('/src/work-inbox.ts')).listWork()).map(x=>x.title))).sort()).toEqual(['Audio recuperable','Audio sano']);
});
