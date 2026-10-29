import { expect, test } from './fixtures.ts';

test('the local conversation discovers and stores a proposal without invoking a service', async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true; state.steps = 0; state.prompts = []; state.network = [];
    const decision = (kind: string, toolName: string, args: unknown, text = '') => ({ ok: true, decision: { kind, toolName, argumentsJSON: JSON.stringify(args), text } });
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('check_availability')) return { available:true,status:'available',supportsSpanish:true };
      if (command.endsWith('results_list') || command.endsWith('share_list') || command.endsWith('documents_list')) return {ok:true,items:[]};
      if (command.endsWith('https_request')) { state.network.push(command); throw new Error('Unexpected external request'); }
      if (command.endsWith('agent_step')) {
        const prompt = args.prompt as string; state.prompts.push(prompt);
        switch (++state.steps) {
          case 1: return decision('tool','tool_describe',{name:'work_propose_action'});
          case 2: return decision('tool','work_propose_action',{workId:state.workId,revision:state.revision,connectionId:'11111111-1111-4111-8111-111111111111',tool:'mcp_0123456789abcdef01234567',description:'Propuesta de seguimiento',arguments:{text:'Seguimiento del acuerdo'}});
          case 3: return decision('tool','tool_describe',{name:'work_proposals'});
          case 4: return decision('tool','work_proposals',{id:state.workId});
          default: return decision('answer','',{},prompt.includes('Propuesta de seguimiento') && prompt.includes('"actionApproved":false') ? 'Propuesta guardada sin enviar.' : 'No pude guardar la propuesta.');
        }
      }
      return {ok:true};
    } };
  });
  await page.goto('/'); await expect(page.locator('#send')).toBeEnabled();
  const fixture = await page.evaluate(async () => {
    const inbox=await import('/src/work-inbox.ts'), sync=await import('/src/work-sync.ts');
    let work=await inbox.createWork({title:'Minuta de prueba',kind:'meeting',instruction:'Revisar acuerdo',files:[new File(['Acuerdo'], 'notas.txt',{type:'text/plain'})]});
    work=await inbox.transitionWork(work.id,work.revision,'prepared'); work=await inbox.transitionWork(work.id,work.revision,'approved');
    const transfer=await sync.prepareWorkTransfer(work,'wss://fixture/ws'); work=await inbox.beginWorkTransfer(work.id,work.revision,transfer);
    work=await inbox.settleWorkTransfer(work.id,transfer.transferId,{transferId:transfer.transferId,workId:work.id,revision:transfer.manifest.revision,manifestHash:transfer.manifestHash,committedAt:1});
    work=await inbox.saveWorkResult(work.id,transfer.transferId,{schema:1,manifestHash:transfer.manifestHash,createdAt:2,model:'fixture',minutes:{title:'Minuta',summary:'Acuerdo',items:[]},evidence:[],transcriptComparison:'',requiresReview:true});
    work=await inbox.approveMinute(work.id,work.revision,'result'); const state=globalThis as any;state.workId=work.id;state.revision=work.revision; return {id:work.id,revision:work.revision};
  });
  await page.locator('#prompt').fill('Prepara una propuesta a partir de la minuta aprobada.'); await page.locator('#send').click();
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText('Propuesta guardada sin enviar.');
  const facts=await page.evaluate(async id=>{const state=globalThis as any, proposals=await import('/src/minute-proposals.ts'); return {prompts:state.prompts,network:state.network,proposals:await proposals.listMinuteProposals(id)};},fixture.id);
  expect(facts.network).toEqual([]); expect(facts.prompts).toHaveLength(5); expect(facts.prompts.every((s:string)=>Array.from(s).length<=8000)).toBe(true);
  expect(facts.prompts[0]).toContain('work_propose_action'); expect(facts.prompts[0]).toContain('work_proposals'); expect(facts.prompts[0]).toContain('work_review_action');
  expect(facts.proposals).toMatchObject([{current:true,actionApproved:false,executed:false,description:'Propuesta de seguimiento'}]);
});

test('conversation requires human review before a real MCP client dispatches a minute proposal', async ({ page }) => {
  await page.setViewportSize({width:320,height:568}); await page.emulateMedia({reducedMotion:'reduce'});
  await page.addInitScript(() => {
    const state=globalThis as any; state.isTauri=true; state.steps=0; state.rpc=[];
    const decision=(kind:string,toolName:string,args:unknown,text='')=>({ok:true,decision:{kind,toolName,argumentsJSON:JSON.stringify(args),text}});
    state.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
      if(command.endsWith('check_availability'))return {available:true,status:'available',supportsSpanish:true};
      if(command.endsWith('results_list')||command.endsWith('share_list')||command.endsWith('documents_list'))return {ok:true,items:[]};
      if(command.endsWith('agent_step')){switch(++state.steps){case 1:return decision('tool','tool_describe',{name:'work_review_action'});case 2:return decision('tool','work_review_action',{id:state.workId,proposalId:state.proposalId});default:return decision('answer','',{},'Revisé el resultado de la propuesta.');}}
      if(command.endsWith('https_request')){
        const req=args.request, rpc=JSON.parse(req.body); state.rpc.push(rpc.method);
        if(rpc.method==='notifications/initialized') return {ok:true,status:202,headers:{},body:''};
        const result=rpc.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}}}:rpc.method==='tools/list'?{tools:[{name:'fixture.followup',description:'Seguimiento',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}]}:rpc.method==='tools/call'?{content:[{type:'text',text:'Recibido por fixture'}]}:null;
        return {ok:true,status:200,headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:rpc.id,result})};
      }
      return {ok:true};
    }};
  });
  await page.goto('/'); await expect(page.locator('#send')).toBeEnabled(); await page.evaluate(() => { document.documentElement.style.fontSize='200%'; });
  const fixture=await page.evaluate(async()=>{
    const inbox=await import('/src/work-inbox.ts'), sync=await import('/src/work-sync.ts'), connections=await import('/src/external-connections.ts'), proposals=await import('/src/minute-proposals.ts');
    const conn=await connections.saveConnection({kind:'mcp',label:'Servicio fixture',endpoint:'https://fixture.example/mcp'});
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(conn.id+'\nfixture.followup')))].map(n=>n.toString(16).padStart(2,'0')).join('').slice(0,24);
    let work=await inbox.createWork({title:'Reunión revisada',kind:'meeting',instruction:'',files:[new File(['Acuerdo'],'notas.txt',{type:'text/plain'})]});
    work=await inbox.transitionWork(work.id,work.revision,'prepared');work=await inbox.transitionWork(work.id,work.revision,'approved');
    const transfer=await sync.prepareWorkTransfer(work,'wss://fixture/ws');work=await inbox.beginWorkTransfer(work.id,work.revision,transfer);
    work=await inbox.settleWorkTransfer(work.id,transfer.transferId,{transferId:transfer.transferId,workId:work.id,revision:transfer.manifest.revision,manifestHash:transfer.manifestHash,committedAt:1});
    work=await inbox.saveWorkResult(work.id,transfer.transferId,{schema:1,manifestHash:transfer.manifestHash,createdAt:2,model:'fixture',minutes:{title:'Minuta',summary:'Acuerdo',items:[]},evidence:[],transcriptComparison:'',requiresReview:true});
    work=await inbox.approveMinute(work.id,work.revision,'result');
    const proposal=await proposals.createMinuteProposal({workId:work.id,revision:work.revision,connectionId:conn.id,tool:`mcp_${hash}`,description:'Seguimiento del acuerdo',arguments:{text:'Seguimiento exacto'}});
    const state=globalThis as any;state.workId=work.id;state.proposalId=proposal.id;return {id:work.id,proposalId:proposal.id};
  });
  await page.locator('#prompt').fill('Revisa la propuesta del acuerdo.'); await page.locator('#send').click();
  const review=page.locator('#requests .review-card'); await expect(review).toContainText('Reunión revisada'); await expect(review).toContainText('Seguimiento exacto');
  expect(await page.evaluate(()=>(globalThis as any).rpc.includes('tools/call'))).toBe(false);
  const approve=review.getByRole('button',{name:'Aprobar esta operación'}); await approve.focus(); await expect(approve).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText('Revisé el resultado de la propuesta.');
  const outcome=await page.evaluate(async ({id,proposalId})=>{const proposals=await import('/src/minute-proposals.ts');return {calls:(globalThis as any).rpc.filter((name:string)=>name==='tools/call').length,proposal:(await proposals.listMinuteProposals(id)).find(item=>item.id===proposalId)};},fixture);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  expect(outcome.calls).toBe(1); expect(outcome.proposal).toMatchObject({state:'responded',responseReceived:true,executed:null});
});
