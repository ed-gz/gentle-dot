import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';
import { persistedPiMessageIdentity } from '../src/extensions/pi-message-identity.ts';
import { tempDir } from './helpers.ts';

it('obtains the real Pi assistant entry ID at turn_end but not from a JSON copy', async () => {
  const dir=tempDir(); const manager=SessionManager.inMemory(dir); const sessionId=manager.getSessionId();
  let endWasPersisted: boolean|undefined; const boundaries: {entryId:string; byIdentity:unknown; fromWire:unknown}[]=[];
  const trace: string[]=[]; const proofs: string[]=[];
  const identityProbe=(pi:ExtensionAPI) => {
    pi.on('message_end', event => {
      if(event.message.role==='assistant') endWasPersisted=Boolean(persistedPiMessageIdentity(manager,sessionId,event.message));
    });
    pi.on('turn_end', (event, ctx) => {
      boundaries.push({entryId:event.messageEntryId,byIdentity:persistedPiMessageIdentity(manager,sessionId,event.message),
        fromWire:persistedPiMessageIdentity(manager,sessionId,JSON.parse(JSON.stringify(event.message)))});
      // Simulate the existing RPC setStatus transport, with source identifiers only.
      ctx.ui.setStatus('identity-proof-fixture', JSON.stringify({sessionId, entryId:event.messageEntryId}));
    });
  };
  const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true,extensionFactories:[identityProbe]});
  const model:Model<'openai-completions'>={id:'fixture',name:'Fixture',api:'openai-completions',provider:'openai',baseUrl:'https://fixture.invalid',input:['text'],reasoning:false,contextWindow:10000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,modelsStorePath:join(dir,'models'),refreshOnCreate:false,allowModelNetwork:false});
  await runtime.setRuntimeApiKey('openai','offline-fixture-key'); await loader.reload();
  const {session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader:loader,model,modelRuntime:runtime,settingsManager:settings,sessionManager:manager,tools:[]});
  try {
    session.agent.streamFunction=()=>{
      const message:AssistantMessage={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',content:[{type:'text',text:'Respuesta'}]};
      const stream=createAssistantMessageEventStream(); stream.push({type:'done',reason:'stop',message}); return stream;
    };
    const subscription = () => session.subscribe(event => { if (event.type === 'message_end' && event.message.role === 'assistant') trace.push('message_end'); if (event.type === 'turn_end') trace.push('turn_end'); });
    let off=subscription();
    await session.bindExtensions({mode:'rpc',uiContext:{...session.extensionRunner.getUIContext(),setStatus:(key,value)=>{ if(key==='identity-proof-fixture' && value) {trace.push('proof'); proofs.push(value);} }},onError:error=>{throw error;}});
    await session.prompt('Repetir'); await session.waitForIdle();
    off(); off=subscription(); // Simulates a subscriber reconnect, not durable replay.
    await session.prompt('Repetir'); await session.waitForIdle(); off();
    expect(endWasPersisted).toBe(false);
    expect(boundaries).toHaveLength(2);
    for(const boundary of boundaries) {
      expect(boundary.byIdentity).toEqual({sessionId,entryId:boundary.entryId});
      expect(boundary.fromWire).toBeUndefined();
    }
    expect(boundaries[0]!.entryId).not.toBe(boundaries[1]!.entryId);
    expect(trace).toEqual(['message_end','proof','turn_end','message_end','proof','turn_end']);
    expect(proofs.map(value=>JSON.parse(value))).toEqual(boundaries.map(({entryId})=>({sessionId,entryId})));
    expect(JSON.stringify(proofs)).not.toContain('Repetir'); expect(JSON.stringify(proofs)).not.toContain('Respuesta');
  } finally { await session.abort(); session.dispose(); }
});
