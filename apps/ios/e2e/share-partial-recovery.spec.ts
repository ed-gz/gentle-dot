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
  await expect(panel).toContainText('Los archivos parciales exportados podrían no reproducirse');
  await expect.poll(()=>page.evaluate(()=>((globalThis as any).testShare.ack as string[]))).toEqual([first]);
  expect(await page.evaluate(async()=>(await (await import('/src/work-inbox.ts')).listWork()).map(x=>x.title))).toEqual(['Audio sano']);
  await page.evaluate(()=>{(globalThis as any).testShare.failRead=false;(globalThis as any).testShare.broken=false;(globalThis as any).testShare.staging=false;});
  await panel.getByRole('button',{name:'Reintentar'}).first().click();
  await expect.poll(()=>page.evaluate(()=>((globalThis as any).testShare.ack as string[]))).toEqual([first,second]);
  await expect(panel).toBeHidden();
  expect((await page.evaluate(async()=>(await (await import('/src/work-inbox.ts')).listWork()).map(x=>x.title))).sort()).toEqual(['Audio recuperable','Audio sano']);
});

test('partial export reports cancellation and lost callback honestly and never deletes its source', async ({page})=>{
  await page.addInitScript(()=>{
    const state=globalThis as any;state.isTauri=true;state.part={mode:'cancel',reads:0,acks:0,outputs:0};
    const copyID='e5a6e456-7a93-4bcc-b006-4493c78b5b66',fileID='f5a6e456-7a93-4bcc-b006-4493c78b5b66',content='partial';let chunks:Uint8Array[]=[],saved:Uint8Array[]=[],metadata:any;
    const bytes=(v:string)=>Uint8Array.from(atob(v),c=>c.charCodeAt(0));
    const digest=async(parts:Uint8Array[])=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await new Blob(parts as BlobPart[]).arrayBuffer()))).map(x=>x.toString(16).padStart(2,'0')).join('');
    state.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
      const name=command.split('|').at(-1),req=args?.request??{};
      if(name==='share_list')return {ok:true,items:[],invalidIds:[],pendingCopies:[{id:copyID,bytes:content.length,files:[{id:fileID,bytes:content.length}]}],omittedPending:0};
      if(name==='documents_list')return {ok:true,items:[]};
      if(name==='share_read'){state.part.reads++;if(!req.pending||req.expectedSize!==content.length)throw Error('bad range');return {ok:true,data:btoa(content.slice(req.offset,req.offset+req.length))};}
      if(name==='share_ack'){state.part.acks++;return {ok:true};}
      if(name==='crypto_hash_begin'){chunks=[];return {ok:true,id:'00000000-0000-0000-0000-000000000001'};}
      if(name==='crypto_hash_update'){chunks.push(bytes(req.data));return {ok:true};}
      if(name==='crypto_hash_finish')return {ok:true,hex:await digest(chunks)};
      if(name==='export_begin'){metadata=req;saved=[];return {ok:true,id:'00000000-0000-0000-0000-000000000002'};}
      if(name==='export_write'){saved.push(bytes(req.data));return {ok:true,written:req.offset+bytes(req.data).length};}
      if(name==='export_present'){if(await digest(saved)!==metadata.sha256)throw Error('digest mismatch');state.part.outputs++;if(state.part.mode==='lost')return new Promise(()=>{});return state.part.mode==='cancel'?{ok:true,exported:false,cancelled:true}:{ok:true,exported:true,cancelled:false};}
      if(name==='check_availability')return {available:false,status:'sdk_unavailable',supportsSpanish:false};
      if(name==='list_voice_receipts')return {ok:true,receipts:[]};
      if(name==='inspect_retained_voice')return {ok:true,retainedAudio:null};
      return {ok:true};
    }};
  });
  await page.goto('/');
  const panel=page.getByRole('group',{name:'Recuperación de archivos'});
  const button=panel.getByRole('button',{name:/Exportar parcial/});await expect(button).toBeVisible();
  await button.click();await expect(panel).toContainText('Exportación cancelada. La copia local se conserva.');
  await page.evaluate(()=>{(globalThis as any).part.mode='lost';});await button.click();
  await expect(panel.getByRole('button',{name:'Dejar de esperar'})).toBeVisible();
  await panel.getByRole('button',{name:'Actualizar copias pendientes'}).click();
  await expect(panel.getByRole('button',{name:/Exportar parcial/})).toBeDisabled();
  await panel.getByRole('button',{name:'Dejar de esperar'}).click();
  await expect(panel).toContainText('No se confirmó la exportación');
  await expect(panel).not.toContainText('Copia parcial exportada');
  expect(await page.evaluate(()=>(globalThis as any).part.acks)).toBe(0);
  await page.evaluate(()=>{(globalThis as any).part.mode='success';});
  await panel.getByRole('button',{name:/Exportar parcial/}).click();
  await expect(panel).toContainText('No se verificó contra el archivo original ni se confirmó que esté completa');
  expect(await page.evaluate(()=>(globalThis as any).part.acks)).toBe(0);
});
