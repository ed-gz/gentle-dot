import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { OrchestrationPanel } from '@gentle-dot/ui/src/components/OrchestrationPanel.tsx';
import type { OrchestrationClient, OrchestrationSnapshot } from '@gentle-dot/ui/src/orchestration.ts';
import type { OrchestrationControls } from '@gentle-dot/ui/src/useOrchestration.ts';
export function mountOutboxHarness() {
 const container=document.createElement('div');container.id='outbox-harness';document.body.appendChild(container);
 const session={paneId:'p',sessionId:'s',label:'Legacy session',state:'idle',connected:true,provider:'herdr',capabilities:{inspect:true,prompt:true,abort:true,approvals:true,deliveryReceipts:true}};
 const snapshot={available:true,sessions:[session],approvals:[],policies:[],events:[]} as unknown as OrchestrationSnapshot;
 const controls={snapshot,busy:false,refresh:async()=>{},act:async()=>true} as OrchestrationControls;
 const client={inspect:async()=>({sessionId:'s',instanceId:'i',status:'idle',messages:[],deliveries:[],question:null,history:{hasEarlier:false,supported:true}})} as unknown as OrchestrationClient;
 const root=createRoot(container);root.render(createElement(OrchestrationPanel,{client,controls,active:true,mobile:true,capriMobile:true,identityScope:'scope|'}));
 return {destroy(){root.unmount();container.remove();}};
}
export async function mountDelayedOutboxHarness() {
 const {createLaptopClient}=await import('../src/laptop-client.ts');const connection={url:'wss://panel.example.test/ws',token:'fixture'};let posts=0;
 const request=async (req:any)=>{const body=req.body?JSON.parse(req.body):null;if(body?.action==='prompt'){posts++;return new Promise<any>(()=>{});}return {status:200,headers:{},body:JSON.stringify({sessionId:'s',instanceId:'i',status:'idle',messages:[],deliveries:[],question:null,history:{hasEarlier:false,supported:true}})};};
 const client=createLaptopClient(connection,{current:()=>connection,request,receiptState:async()=> 'active',controlTimeoutMs:40});
 const session={paneId:'p',sessionId:'s',label:'Delayed session',state:'idle',connected:true,provider:'herdr',capabilities:{inspect:true,prompt:true,abort:true,approvals:true,deliveryReceipts:true}};
 const controls={snapshot:{available:true,sessions:[session],approvals:[],policies:[],events:[]},busy:false,refresh:async()=>{},act:async(action:any)=>{try{await client.act(action);return true;}catch{return false;}}} as unknown as OrchestrationControls;
 const container=document.createElement('div');container.id='delayed-outbox-harness';document.body.appendChild(container);const root=createRoot(container);
 root.render(createElement(OrchestrationPanel,{client,controls,active:true,mobile:true,capriMobile:true,identityScope:'panel|'}));
 return {posts:()=>posts,destroy(){root.unmount();container.remove();}};
}
