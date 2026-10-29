import {expect,test} from './fixtures.ts';

test('a contradictory history ID leaves the prior conversation intact and reports the error',async({page})=>{
  let emit:((value:object)=>void)|undefined;
  await page.routeWebSocket('wss://conflict.example/ws',ws=>{
    let seq=0;const send=(value:object)=>ws.send(JSON.stringify({seq:seq++,...value}));emit=send;
    ws.onMessage(raw=>{const value=JSON.parse(String(raw));if(value.type==='hello')send({type:'ready',agentState:'idle',conversationId:'c1'});
      if(value.type==='get_history')send({type:'history',conversationId:'c1',messages:[{id:'s0-1',role:'user',text:'Mensaje conservado',activities:[]}]});});
  });
  await page.goto('/');await page.locator('[data-panel="settings"]').click();await page.getByText('Conexión manual',{exact:true}).click();
  await page.locator('#url').fill('wss://conflict.example/ws');await page.locator('#token').fill('fixture-only');await page.locator('#connection button[type="submit"]').click();
  await page.locator('[data-panel="chat"]').click();await expect(page.locator('#cards')).toContainText('Mensaje conservado');
  await expect.poll(()=>page.evaluate(async()=> (await (await import('/src/conversation.ts')).loadConversation()).entries.some(entry=>entry.text==='Mensaje conservado'))).toBe(true);
  emit!({type:'history',conversationId:'c1',messages:[{id:'s0-1',role:'assistant',text:'No debe reemplazar',activities:[]}]});
  await expect(page.locator('#chat-notice')).toContainText('identidades contradictorias');
  await expect(page.locator('#cards')).toContainText('Mensaje conservado');await expect(page.locator('#cards')).not.toContainText('No debe reemplazar');
  await page.reload();await page.locator('[data-panel="chat"]').click();await expect(page.locator('#cards')).toContainText('Mensaje conservado');await expect(page.locator('#cards')).not.toContainText('No debe reemplazar');
});
