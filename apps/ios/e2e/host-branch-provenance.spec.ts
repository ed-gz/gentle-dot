import { expect, test } from './fixtures.ts';
test('unverified previous session remains labelled after save and reload without changing current cards', async ({page})=>{
 await page.routeWebSocket('wss://branch.fixture/ws',ws=>{let seq=0;ws.onMessage(raw=>{const m=JSON.parse(String(raw));if(m.type==='hello')ws.send(JSON.stringify({seq:seq++,type:'ready',agentState:'idle',conversationId:'c1'}));if(m.type==='get_history')ws.send(JSON.stringify({seq:seq++,type:'history',conversationId:'c1',branchVerified:true,messages:[{id:'old',role:'assistant',text:'Texto anterior',activities:[],earlier:true,branchUnverified:true},{id:'current',role:'assistant',text:'Texto vigente',activities:[]}]}));});});
 await page.goto('/');await page.locator('[data-panel="settings"]').click();await page.getByText('Conexión manual',{exact:true}).click();await page.locator('#url').fill('wss://branch.fixture/ws');await page.locator('#token').fill('fixture-only');await page.locator('#connection button[type="submit"]').click();await expect(page.locator('#status')).toHaveText('Vinculado a Gentle Dot');await page.locator('[data-panel="chat"]').click();
 const old=page.locator('.chat-card').filter({hasText:'Texto anterior'}), current=page.locator('.chat-card').filter({hasText:'Texto vigente'});
 await expect(old).toContainText('Rama no verificada');await expect(current).not.toContainText('Rama no verificada');
 await expect.poll(()=>page.evaluate(async()=>{const c=await import('/src/conversation.ts');return (await c.loadConversation()).entries.find(e=>e.text==='Texto anterior')?.branchUnverified;})).toBe(true);
 await page.reload();await expect(old).toContainText('Rama no verificada');await expect(current).not.toContainText('Rama no verificada');
 const records=await page.evaluate(async()=>{const a=await import('/src/conversation-archive.ts');return (await a.conversationArchive.page({limit:100})).entries.filter(e=>e.text==='Texto anterior');});expect(records).toMatchObject([{branchUnverified:true}]);
 const memory=await page.evaluate(async()=>{const {createMemoryTools}=await import('/src/conversation-memory-tools.ts');const tools=createMemoryTools();const context={signal:new AbortController().signal};const found:any=await tools.find(t=>t.definition.name==='search_memory')!.execute({query:'Texto anterior'},context);const recalled:any=await tools.find(t=>t.definition.name==='recall_history')!.execute({entryKey:found.records[0].source.key},context);return {found,recalled};});
 expect(memory.found.records[0].source).toMatchObject({branchUnverified:true,warning:'El archivo por sí solo no confirma la pertenencia a la rama activa actual.'});
 expect(memory.recalled.source).toMatchObject({branchUnverified:true});
});

test('verified page labels older visible cards not in that page without deleting them', async ({page}) => {
 let sendVerified: (() => void) | undefined;
 await page.routeWebSocket('wss://branch.fixture/ws', ws => { let seq=0; ws.onMessage(raw => {
  const m=JSON.parse(String(raw));
  if(m.type==='hello') ws.send(JSON.stringify({seq:seq++,type:'ready',agentState:'idle',conversationId:'c1'}));
  if(m.type==='get_history') {
   ws.send(JSON.stringify({seq:seq++,type:'history',conversationId:'c1',messages:[{id:'previous',role:'assistant',text:'Tarjeta conservada',activities:[]}]}));
   sendVerified=()=>ws.send(JSON.stringify({seq:seq++,type:'history',conversationId:'c1',branchVerified:true,messages:[{id:'current',role:'assistant',text:'Tarjeta de página actual',activities:[]}]}));
  }
 }); });
 await page.goto('/'); await page.locator('[data-panel="settings"]').click(); await page.getByText('Conexión manual',{exact:true}).click();
 await page.locator('#url').fill('wss://branch.fixture/ws'); await page.locator('#token').fill('fixture-only'); await page.locator('#connection button[type="submit"]').click();
 await page.locator('[data-panel="chat"]').click(); const old=page.locator('.chat-card').filter({hasText:'Tarjeta conservada'});
 await expect(old).toBeVisible(); expect(sendVerified).toBeDefined(); sendVerified!();
 await expect(old).toContainText('Rama no verificada'); await expect(page.locator('.chat-card').filter({hasText:'Tarjeta de página actual'})).not.toContainText('Rama no verificada');
 await expect.poll(()=>page.evaluate(async()=>{const c=await import('/src/conversation.ts');return (await c.loadConversation()).entries.find(e=>e.text==='Tarjeta conservada')?.branchUnverified;})).toBe(true);
 await page.reload(); await expect(old).toContainText('Rama no verificada');
});
