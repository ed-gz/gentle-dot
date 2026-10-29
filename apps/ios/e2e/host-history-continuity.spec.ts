import { expect, test } from './fixtures.ts';

test('reconnection preserves tool evidence and identity when earlier turns repeat the same text', async ({ page }) => {
  let connections = 0;
  await page.routeWebSocket('wss://history.example/ws', ws => {
    connections++; const current = connections; let seq = 0;
    const send = (data: object) => ws.send(JSON.stringify({ seq: seq++, ...data }));
    ws.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello') send({ type: 'ready', agentState: 'idle', conversationId: 'c1' });
      if (message.type === 'get_history') {
        const newer = [{ id:'h3', role:'user', text:'Repetir', activities:[] }, { id:'h4', role:'assistant', text:'Respuesta actual', activities:[] }];
        const older = [{ id:'h1', role:'user', text:'Repetir', activities:[] }, { id:'h2', role:'assistant', text:'Respuesta anterior', activities:[] }];
        send({ type:'history', conversationId:'c1', messages: current === 1 ? newer : [...older,...newer] });
        if (current === 1) send({ type:'activity', messageId:'h4', activity:{ id:'tool-1', title:'Buscar evidencia', kind:'search', status:'done', detail:'Archivo encontrado' } });
      }
    });
  });
  await page.goto('/'); await page.locator('[data-panel="settings"]').click();
  await page.getByText('Conexión manual',{exact:true}).click();
  await page.locator('#url').fill('wss://history.example/ws'); await page.locator('#token').fill('fixture-only');
  await page.locator('#connection button[type="submit"]').click();
  await expect(page.locator('#status')).toHaveText('Vinculado a Gentle Dot');
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('.chat-card[data-role="assistant"]')).toContainText(['Respuesta actual']);
  await expect(page.locator('.chat-card[data-role="assistant"] .tool-trace').filter({hasText:'Buscar evidencia'})).toContainText('Buscar evidencia');
  const id = 'host:wss://history.example/ws|c1|h3';
  const previousAt = await page.evaluate(async id => {
    const { loadConversation } = await import('/src/conversation.ts');
    for (let i=0; i<50; i++) { const entry=(await loadConversation()).entries.find(item=>item.id===id); if(entry) return entry.at; await new Promise(resolve=>setTimeout(resolve,50)); }
    throw new Error('No se guardó la conversación inicial.');
  }, id);
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#disconnect').click(); await page.locator('#token').fill('fixture-only');
  await page.locator('#connection button[type="submit"]').click();
  await expect.poll(() => connections).toBe(2);
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('.chat-card[data-role="user"]')).toHaveCount(2);
  await expect(page.locator('.chat-card[data-role="assistant"]')).toHaveCount(2);
  await expect(page.locator('.chat-card[data-role="assistant"] .tool-trace').filter({hasText:'Buscar evidencia'})).toContainText('Buscar evidencia');
  await expect.poll(() => page.evaluate(async ({id, previousAt}) => {
    const entries=(await (await import('/src/conversation.ts')).loadConversation()).entries;
    return ['h1','h2','h3','h4'].every(suffix => entries.some(item=>item.id.endsWith(`|${suffix}`))) && entries.find(item=>item.id===id)?.at===previousAt && entries.some(item=>item.id.endsWith('|h4') && item.activities?.some(activity=>activity.id==='tool-1' && activity.status==='done'));
  }, {id, previousAt})).toBe(true);
  await page.reload(); await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('.chat-card[data-role="user"]')).toHaveCount(2);
  await expect(page.locator('.chat-card[data-role="assistant"] .tool-trace').filter({hasText:'Buscar evidencia'})).toContainText('Buscar evidencia');
});
