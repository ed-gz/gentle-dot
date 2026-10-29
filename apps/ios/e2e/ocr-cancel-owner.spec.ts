import { expect,test } from './fixtures.ts';
test('late OCR cancellation carries its original identity and cannot cancel a newer request', async ({page})=>{
 await page.addInitScript(()=>{const state=globalThis as any; state.isTauri=true;state.count=0;state.current='';state.cancelled='';
 state.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
  if(command.endsWith('recognize_document')) {const n=++state.count;state.current=args.request.requestId;state[`id${n}`]=state.current;return new Promise(resolve=>{state[`finish${n}`]=()=>resolve({ok:false,message:'fixture'});});}
  if(command.endsWith('cancel_document')) {state.canceledId=args.requestId;if(args.requestId===state.current) state.cancelled=state.current;return {ok:true};} return {ok:true};}};});
 await page.goto('/');
 const data=await page.evaluate(async()=>{const state=globalThis as any,{recognizeDocument}=await import('/src/perception.ts');const a=new AbortController(),b=new AbortController();const file=new File(['image'],'test.png',{type:'image/png'});
  const first=recognizeDocument(file,a.signal).catch(()=>{});while(!state.finish1) await new Promise(r=>setTimeout(r,0)); state.current='';
  const second=recognizeDocument(file,b.signal).catch(()=>{});while(!state.finish2) await new Promise(r=>setTimeout(r,0)); a.abort(); await new Promise(r=>setTimeout(r,0));
  state.finish1();state.finish2();await Promise.all([first,second]);return { cancelled: state.cancelled, canceledId: state.canceledId, firstId: state.id1, secondId: state.id2 };
 });expect(data.cancelled).toBe(''); expect(data.canceledId).toBe(data.firstId); expect(data.firstId).not.toBe(data.secondId);
});
