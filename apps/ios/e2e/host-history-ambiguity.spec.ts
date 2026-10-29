import { expect, test } from './fixtures.ts';

test('a delayed earlier snapshot with identical text never replaces a live turn', async ({page}) => {
  await page.routeWebSocket('wss://ambiguous.example/ws', ws => {
    let seq=0;const send=(value:object)=>ws.send(JSON.stringify({seq:seq++,...value}));
    ws.onMessage(raw=>{
      const event=JSON.parse(String(raw));
      if(event.type==='hello')send({type:'ready',agentState:'idle',conversationId:'c1'});
      if(event.type==='get_history'){
        send({type:'user_message',messageId:'u-live',text:'Sí'});
        send({type:'history',conversationId:'c1',messages:[{id:'s0-1',role:'user',text:'Sí',activities:[]}]});
      }
    });
  });
  await page.goto('/'); await page.locator('[data-panel="settings"]').click(); await page.getByText('Conexión manual',{exact:true}).click();
  await page.locator('#url').fill('wss://ambiguous.example/ws'); await page.locator('#token').fill('fixture-only'); await page.locator('#connection button[type="submit"]').click();
  await page.locator('[data-panel="chat"]').click(); await expect(page.locator('.chat-card[data-role="user"]')).toHaveCount(2);
  const suffixes=['|u-live','|s0-1'];
  await expect.poll(()=>page.evaluate(async suffixes=>{const items=(await (await import('/src/conversation.ts')).loadConversation()).entries;return suffixes.every(suffix=>items.some(item=>item.id.endsWith(suffix)));},suffixes)).toBe(true);
  await page.reload(); await page.locator('[data-panel="chat"]').click(); await expect(page.locator('.chat-card[data-role="user"]')).toHaveCount(2);
});
