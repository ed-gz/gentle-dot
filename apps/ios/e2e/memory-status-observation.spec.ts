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
  await page.evaluate(() => {const state=globalThis as any;state.archiveStatusFixture.pending=0;state.archiveStatusFixture.count=206;state.memoryStatusFixture.updateStatus();});
  await expect(status).toContainText('206 mensajes');
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


test('a stats read spanning a completed write is refreshed before showing its count', async ({page}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const {mountMemoryView} = await import('/src/memory-view.ts');
    const {conversationArchive} = await import('/src/conversation-archive.ts');
    const state = globalThis as any;
    state.archiveRaceFixture = {pending:0,blocked:false,calls:0};
    (conversationArchive as any).stats = () => {
      if (++state.archiveRaceFixture.calls === 1) return new Promise(resolve => {state.resolveOldStats = resolve;});
      return Promise.resolve({entries:211,bytes:0,maximumEntries:1000,maximumBytes:1048576});
    };
    state.memoryRaceFixture = mountMemoryView({status:()=>state.archiveRaceFixture,pending:()=>[],visible:()=>[],draft:()=>'',retry:async()=>{}});
    state.refreshRace = state.memoryRaceFixture.refresh();
    state.archiveRaceFixture.pending=1;state.memoryRaceFixture.updateStatus();
    state.archiveRaceFixture.pending=0;state.memoryRaceFixture.updateStatus();
    state.resolveOldStats({entries:205,bytes:0,maximumEntries:1000,maximumBytes:1048576});
    await state.refreshRace;
  });
  const status=page.locator('#conversation-memory').last().locator('#memory-status');
  await expect(status).toContainText('211 mensajes');
  expect(await page.evaluate(() => (globalThis as any).archiveRaceFixture.calls)).toBe(2);
});


test('a read completed during a pending write refreshes after the write ends', async ({page}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const {mountMemoryView} = await import('/src/memory-view.ts');
    const {conversationArchive} = await import('/src/conversation-archive.ts');
    const state = globalThis as any;
    state.archivePendingFixture = {pending:1,blocked:false,calls:0};
    (conversationArchive as any).stats = async () => ({entries:++state.archivePendingFixture.calls === 1 ? 205 : 211,bytes:0,maximumEntries:1000,maximumBytes:1048576});
    state.memoryPendingFixture = mountMemoryView({status:()=>state.archivePendingFixture,pending:()=>[],visible:()=>[],draft:()=>'',retry:async()=>{}});
    await state.memoryPendingFixture.refresh();
    state.archivePendingFixture.pending=0;state.memoryPendingFixture.updateStatus();
  });
  await expect(page.locator('#conversation-memory').last().locator('#memory-status')).toContainText('211 mensajes');
  expect(await page.evaluate(() => (globalThis as any).archivePendingFixture.calls)).toBe(2);
});
