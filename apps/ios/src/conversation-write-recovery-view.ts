import { isTauri } from '@tauri-apps/api/core';
import { exportNativeFile } from './file-export.ts';
import type { createConversationWriteRescue, WriteRescue } from './conversation-write-rescue.ts';

/** Export a rescue copy as unconfirmed data, without private transport aliases. */
export function writeRescueBlob(record:WriteRescue):Blob {
  const lines=[JSON.stringify({schema:'capri-conversation-write-rescue-export/v1',committed:false,owner:record.owner,sequence:record.sequence,baseRevision:record.baseRevision}),
    JSON.stringify({schema:'capri-conversation-draft/v1',source:'unconfirmed-writer',submitted:false,text:record.draft,...(record.attachedWork?{attachedWork:record.attachedWork}:{})}),
    ...record.entries.map(entry=>JSON.stringify({source:'unconfirmed-writer',id:entry.id,engine:entry.engine,role:entry.role,state:entry.state,text:entry.text,at:entry.at,
      ...(entry.replyTo?{replyTo:entry.replyTo}:{}),...(entry.localCancelled?{localCancelled:true}:{}),...(entry.branchUnverified?{branchUnverified:true}:{}),
      ...(entry.activities?{activities:entry.activities.map(({id,title,kind,status,detail})=>({id,title,kind,status,...(detail===undefined?{}:{detail})}))}:{})}))];
  return new Blob([lines.join('\n'),'\n'],{type:'application/x-ndjson'});
}
async function deliver(blob:Blob):Promise<'exported'|'cancelled'|'prepared'> {
  const name='capri-copia-conversacion.ndjson';
  if(isTauri())return (await exportNativeFile(blob,name)).status;
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60_000);return 'prepared';
}
export function mountConversationWriteRecovery(root:HTMLElement, options:{store:Pick<ReturnType<typeof createConversationWriteRescue>,'list'|'discard'>; deliver?:(blob:Blob)=>Promise<'exported'|'cancelled'|'prepared'>}) {
  let epoch=0;
  root.classList.add('conversation-write-recovery');
  const details=document.createElement('details'),summary=document.createElement('summary'),content=document.createElement('div'),status=document.createElement('p');
  summary.textContent='Copias de conversación por revisar';status.setAttribute('role','status');details.append(summary,content,status);root.append(details);root.hidden=true;
  async function refresh(){
    const current=++epoch;
    try{
      const records=await options.store.list();if(current!==epoch)return;
      root.hidden=records.length===0;content.replaceChildren();status.textContent='';
      for(const record of records){
        const item=document.createElement('section'),description=document.createElement('p'),preview=document.createElement('details'),previewTitle=document.createElement('summary'),previewText=document.createElement('pre'),exportButton=document.createElement('button'),discardButton=document.createElement('button'),confirmButton=document.createElement('button'),cancelButton=document.createElement('button');
        description.textContent=`Copia sin confirmar · ${record.entries.length} mensajes · ${record.draft ? 'con borrador' : 'sin borrador'}`;
        previewTitle.textContent='Ver contenido';
        previewText.textContent=[...(record.draft?[`Borrador: ${record.draft.slice(0,1000)}${record.draft.length>1000?'…':''}`]:[]),...record.entries.slice(0,20).map(entry=>`${entry.role}: ${entry.text.slice(0,1000)}${entry.text.length>1000?'…':''}`),...(record.entries.length>20?['La copia contiene más mensajes; expórtala para verlos completos.']:[])].join('\n\n');
        preview.append(previewTitle,previewText);
        exportButton.type=discardButton.type=confirmButton.type=cancelButton.type='button';exportButton.textContent='Exportar copia';discardButton.textContent='Descartar copia';confirmButton.textContent='Sí, descartar esta copia';cancelButton.textContent='Cancelar';
        confirmButton.hidden=cancelButton.hidden=true;
        exportButton.addEventListener('click',()=>void(async()=>{
          exportButton.disabled=true;try{
            const latest=(await options.store.list()).find(value=>value.owner===record.owner);
            if(!latest || JSON.stringify(latest)!==JSON.stringify(record)){status.textContent='La copia cambió; vuelve a revisarla.';return;}
            const outcome=await (options.deliver??deliver)(writeRescueBlob(record));
            status.textContent=outcome==='exported'?'Copia guardada en Archivos. La copia local se conserva.':outcome==='cancelled'?'Exportación cancelada. La copia local se conserva.':'Copia preparada. Comprueba la descarga; la copia local se conserva.';
          }catch{status.textContent='No pude confirmar la exportación. La copia local se conserva.';}finally{exportButton.disabled=false;}
        })());
        discardButton.addEventListener('click',()=>{discardButton.hidden=true;confirmButton.hidden=cancelButton.hidden=false;status.textContent='Descartar elimina esta copia, incluidos sus mensajes no confirmados.';});
        cancelButton.addEventListener('click',()=>{discardButton.hidden=false;confirmButton.hidden=cancelButton.hidden=true;status.textContent='';});
        confirmButton.addEventListener('click',()=>void(async()=>{confirmButton.disabled=true;try{
          if(!await options.store.discard(record)){status.textContent='La copia cambió; vuelve a revisarla.';return;}
          await refresh();
        }catch{status.textContent='No pude descartar la copia. Se conserva.';}finally{confirmButton.disabled=false;}})());
        item.append(description,preview,exportButton,discardButton,confirmButton,cancelButton);content.append(item);
      }
    }catch{if(current===epoch){root.hidden=false;status.textContent='No pude leer las copias de conversación; no se modificaron.';}}
  }
  return {refresh};
}
