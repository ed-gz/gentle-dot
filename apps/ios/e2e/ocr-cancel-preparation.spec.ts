import { expect, test } from './fixtures.ts';
for (const stage of ['read', 'hash'] as const) test(`cancel during OCR ${stage} never calls or cancels Vision`, async ({page}) => {
 await page.addInitScript(() => { const state=globalThis as any; state.isTauri=true; state.nativeCalls=[]; state.__TAURI_INTERNALS__={invoke:async (command:string)=> {state.nativeCalls.push(command); if(command.endsWith('recognize_document')) return {ok:false,message:'fixture'}; return {ok:true};}}; });
 await page.goto('/');
 const result=await page.evaluate(async(stage)=>{
  const state=globalThis as any; const original=File.prototype.arrayBuffer; let release!:()=>void, started!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}), ready=new Promise<void>(resolve=>{started=resolve;});
  if (stage === 'read') File.prototype.arrayBuffer=async function() {started(); await gate; return original.call(this);};
  else { const digest=crypto.subtle.digest.bind(crypto.subtle); Object.defineProperty(crypto.subtle,'digest',{configurable:true,value:async (...args: Parameters<SubtleCrypto['digest']>) => { started(); await gate; return digest(...args); }}); }
  const {createLocalTools}=await import('/src/agent-tools.ts'); const {recognizeDocument}=await import('/src/perception.ts');
  const file=new Blob(['image'],{type:'image/png'}), work={id:'work-1',title:'X',kind:'task',instruction:'',createdAt:1,updatedAt:1,status:'local',revision:1,files:[{id:'file-1',name:'a.png',type:'image/png',size:file.size}],versions:[]};
  const tool=createLocalTools({readWork:async()=>work,readWorkFile:async()=>file,recognizeDocument} as any).find(t=>t.definition.name==='file_ocr')!;
  const controller=new AbortController();const pending=tool.execute({workId:'work-1',fileId:'file-1'},{signal:controller.signal}).catch(()=>{});
  await ready;controller.abort();await new Promise(resolve=>setTimeout(resolve,0));release();await pending; File.prototype.arrayBuffer=original; return state.nativeCalls.filter((x:string)=>x.endsWith('cancel_document')||x.endsWith('recognize_document'));
 },stage);
 expect(result.map((x:string)=>x.split('|').at(-1))).toEqual([]);
});
