import { expect, test, type Page } from './fixtures.ts';

async function failFirstRead(page: Page) {
  await page.addInitScript(() => {
    const original = IDBFactory.prototype.open; let failed = false;
    IDBFactory.prototype.open = function (name: string, version?: number) {
      if (name === 'capri-ios-conversation' && !failed) { failed = true; throw new DOMException('Lectura temporal', 'UnknownError'); }
      return Reflect.apply(original, this, version === undefined ? [name] : [name, version]);
    };
  });
}

test('two early drafts remain independently recoverable after both windows close', async ({ page, context }) => {
  const second = await context.newPage();
  await failFirstRead(page); await failFirstRead(second);
  await Promise.all([page.goto('/'), second.goto('/')]);
  await expect(page.locator('#retry-conversation')).toBeVisible();
  await expect(second.locator('#retry-conversation')).toBeVisible();
  await Promise.all([page.locator('#prompt').fill('Borrador primera ventana'), second.locator('#prompt').fill('Borrador segunda ventana')]);
  const records = () => page.evaluate(async () => (await (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue().list()).map(item => item.draft));
  await expect.poll(records).toEqual(expect.arrayContaining(['Borrador primera ventana', 'Borrador segunda ventana']));
  await Promise.all([page.close(), second.close()]);
  const recovered = await context.newPage(); await recovered.goto('/');
  await expect.poll(() => recovered.evaluate(async () => (await (await import('/src/conversation-draft-rescue.ts')).createConversationDraftRescue().list()).map(item => item.draft)))
    .toEqual(expect.arrayContaining(['Borrador primera ventana', 'Borrador segunda ventana']));
  await expect(recovered.getByText('Borrador para recuperar')).toHaveCount(2);
  await recovered.close();
});
