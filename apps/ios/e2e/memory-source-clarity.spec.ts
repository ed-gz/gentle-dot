import { expect, test, openRecoveryHarness } from './fixtures.ts';

test('recovery identifies separate similar records without merging, leaking transport or changing export', async ({page}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { conversationArchive } = await import('/src/conversation-archive.ts');
    await conversationArchive.upsert([
      {id:'host:wss://fixture.example/ws|main|live-1',engine:'gentle',role:'user',state:'complete',text:'Repetir exactamente',transportText:'PRIVATE CONTEXT',at:1000},
      {id:'host:wss://fixture.example/ws|main|history-1',engine:'gentle',role:'user',state:'complete',text:'Repetir exactamente',at:2000},
      {id:'host:wss://fixture.example/ws|other|history-2',engine:'gentle',role:'user',state:'complete',text:'Repetir exactamente',at:3000},
    ]);
  });
  await openRecoveryHarness(page);
  await page.locator('#conversation-memory > details > summary').click();
  await expect(page.locator('#conversation-memory')).toContainText('Los registros parecidos pueden ser eventos distintos o copias');
  await page.locator('#memory-query').fill('Repetir exactamente'); await page.locator('#memory-search button').click();
  const articles=page.locator('#memory-entries article'); await expect(articles).toHaveCount(3);
  await expect(articles.filter({hasText:'Repetir exactamente'})).toHaveCount(3);
  await expect(page.locator('#memory-entries')).not.toContainText('PRIVATE CONTEXT');
  await expect(articles.first().locator('details')).not.toHaveAttribute('open');
  await articles.first().getByText('Detalles de origen',{exact:true}).click();
  await expect(articles.first().locator('details small')).toContainText('Identificador: host:wss://fixture.example/ws|main|live-1');
  const exportText=await page.evaluate(async()=>await (await (await import('/src/conversation-archive.ts')).conversationArchive.export()).blob.text());
  expect(exportText).toContain('live-1');expect(exportText).toContain('history-1');expect(exportText).toContain('history-2');
  expect(exportText).not.toContain('PRIVATE CONTEXT');
});
