import { test, expect } from './fixtures.ts';

test('a blocked startup autosave does not invent an empty rescue beside an existing draft', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const {createConversationDraftRescue} = await import('/src/conversation-draft-rescue.ts');
    await createConversationDraftRescue().save({schema:'capri-draft-rescue/v1',owner:'00000000-0000-4000-8000-000000000001',sequence:1,baseRevision:0,draft:'Copia importante'});
  });
  await page.addInitScript(() => {
    const s = globalThis as any, original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.transaction.db.name === 'capri-ios-conversation' && key === 'conversation-journal:v1') throw new DOMException('Guardado bloqueado', 'UnknownError');
      return Reflect.apply(original, this, [value, key]);
    };
    s.isTauri = true;
    s.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
      if (command.endsWith('results_list')) return await new Promise(() => {});
      if (command.endsWith('share_list') || command.endsWith('documents_list') || command.endsWith('list_voice_receipts')) return {ok:true,items:[],receipts:[]};
      if (command.endsWith('check_availability')) return {available:false,status:'model_not_ready',supportsSpanish:false};
      return {ok:true};
    }};
  });
  await page.reload();
  await expect(page.getByText('Borrador para recuperar')).toHaveCount(1);
  await page.getByText('Borrador para recuperar').click();
  await expect(page.getByText('Copia importante')).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue().list()).map((item: {draft:string}) => item.draft))).toEqual(['Copia importante']);
});
