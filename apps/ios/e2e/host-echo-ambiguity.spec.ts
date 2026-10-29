import {expect,test} from './fixtures.ts';

test('an identical message from another client does not confirm or erase the submitted request', async ({page}) => {
  const sent:string[]=[];
  await page.routeWebSocket('wss://echo.example/ws', ws => {
    let seq=0;const send=(value:object)=>ws.send(JSON.stringify({seq:seq++,...value}));
    ws.onMessage(raw=>{const value=JSON.parse(String(raw));
      if(value.type==='hello')send({type:'ready',agentState:'idle',conversationId:'c1'});
      if(value.type==='get_history')send({type:'history',conversationId:'c1',messages:sent.length?[{id:'s0-1',role:'user',text:'Sí',activities:[]}]:[]});
      if(value.type==='send') {sent.push(value.text);send({type:'user_message',messageId:'other-client-1',text:value.text});}
    });
  });
  await page.goto('/');await page.locator('[data-panel="settings"]').click();await page.getByText('Conexión manual',{exact:true}).click();
  await page.locator('#url').fill('wss://echo.example/ws');await page.locator('#token').fill('fixture-only');await page.locator('#connection button[type="submit"]').click();
  await page.locator('[data-panel="chat"]').click();await page.locator('.engine-details summary').click();await page.locator('#engine').selectOption('gentle');
  await page.locator('#prompt').fill('Sí');await page.locator('#send').click();
  const cards=page.locator('.chat-card[data-role="user"]');await expect(cards).toHaveCount(2);
  await expect(cards.filter({hasText:'sin confirmar'})).toHaveCount(1);
  await expect(cards.filter({hasText:'sin confirmar'})).toHaveAttribute('data-state','interrupted');
  await expect(page.locator('#send')).toBeEnabled();expect(sent).toEqual(['Sí']);
  await expect.poll(()=>page.evaluate(async()=>{const entries=(await (await import('/src/conversation.ts')).loadConversation()).entries;return entries.filter(entry=>entry.engine==='gentle'&&entry.role==='user').map(entry=>entry.state).sort();})).toEqual(['complete','interrupted']);
  // A subsequent equal-text history must not retroactively confirm the request.
  await page.locator('[data-panel="settings"]').click();await page.locator('#disconnect').click();await page.locator('#token').fill('fixture-only');await page.locator('#connection button[type="submit"]').click();
  await page.locator('[data-panel="chat"]').click();await expect(cards).toHaveCount(3);await expect(cards.filter({hasText:'sin confirmar'})).toHaveCount(1);
  await expect.poll(()=>page.evaluate(async()=>{const entries=(await (await import('/src/conversation.ts')).loadConversation()).entries;return entries.some(entry=>entry.id.endsWith('|s0-1'))&&entries.some(entry=>entry.id.includes('|pending:')&&entry.state==='interrupted');})).toBe(true);
  expect(sent).toEqual(['Sí']);
  await page.reload();await page.locator('[data-panel="chat"]').click();await expect(cards).toHaveCount(3);await expect(cards.filter({hasText:'sin confirmar'})).toHaveCount(1);
});
