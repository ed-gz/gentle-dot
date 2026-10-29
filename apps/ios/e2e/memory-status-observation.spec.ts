import { expect, test } from './fixtures.ts';

test('later persistence notifications preserve verified archive counts and read errors', async ({page}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const {mountMemoryView} = await import('/src/memory-view.ts');
    const {conversationArchive} = await import('/src/conversation-archive.ts');
    const state = globalThis as any;
    state.archiveStatusFixture = {pending:0,blocked:false,count:205,fail:false};
    (conversationArchive as any).stats = async () => {
      if (state.archiveStatusFixture.fail) throw new Error('Archivo temporalmente ilegible');
      return {entries:state.archiveStatusFixture.count,bytes:0,maximumEntries:1000,maximumBytes:1048576};
    };
    state.memoryStatusFixture = mountMemoryView({status:()=>state.archiveStatusFixture,pending:()=>[],visible:()=>[],draft:()=>'',retry:async()=>{}});
    await state.memoryStatusFixture.refresh();
  });
  const status=page.locator('#conversation-memory').last().locator('#memory-status');
  await expect(status).toContainText('205 mensajes');
  await page.evaluate(() => (globalThis as any).memoryStatusFixture.updateStatus());
  await expect(status).toContainText('205 mensajes');
  await page.evaluate(() => {const state=globalThis as any;state.archiveStatusFixture.pending=1;state.memoryStatusFixture.updateStatus();});
  await expect(status).toContainText('1 mensajes pendientes');
  await page.evaluate(() => {const state=globalThis as any;state.archiveStatusFixture.pending=0;state.memoryStatusFixture.updateStatus();});
  await expect(status).not.toContainText('205 mensajes');
  await page.evaluate(async () => {const state=globalThis as any;state.archiveStatusFixture.fail=true;await state.memoryStatusFixture.refresh();state.memoryStatusFixture.updateStatus();});
  await expect(status).toContainText('Archivo temporalmente ilegible');
  await page.evaluate(async () => {const state=globalThis as any;state.archiveStatusFixture.fail=false;state.archiveStatusFixture.count=210;await state.memoryStatusFixture.refresh();state.memoryStatusFixture.updateStatus();});
  await expect(status).toContainText('210 mensajes');
});


test('an export result does not hide a later archive read error', async ({page}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const {mountMemoryView} = await import('/src/memory-view.ts');
    const {conversationArchive} = await import('/src/conversation-archive.ts');
    const state = globalThis as any;
    (conversationArchive as any).export = async () => ({blob:new Blob(['saved'])});
    (conversationArchive as any).stats = async () => { throw new Error('Archivo temporalmente ilegible'); };
    state.memoryExportFixture = mountMemoryView({status:()=>({pending:0,blocked:false}),pending:()=>[],visible:()=>[],draft:()=>'',retry:async()=>{}});
  });
  const root=page.locator('#conversation-memory').last();
  await root.locator('#memory-export').evaluate(button => (button as HTMLButtonElement).click());
  await expect(root.locator('#memory-status')).toContainText('Exportación preparada');
  await page.evaluate(async () => {const state=globalThis as any;await state.memoryExportFixture.refresh();state.memoryExportFixture.updateStatus();});
  await expect(root.locator('#memory-status')).toContainText('Exportación preparada');
  await expect(root.locator('#memory-status')).toContainText('Archivo temporalmente ilegible');
});
