import { expect, test } from './fixtures.ts';

test('two browser views cannot overwrite a newer Keychain selection with a delayed write', async ({ page, context }) => {
  await page.route('**/cas-fixture', route => route.fulfill({ contentType:'text/html', body:'<!doctype html><title>CAS fixture</title>' }));
  const second = await context.newPage();
  await second.route('**/cas-fixture', route => route.fulfill({ contentType:'text/html', body:'<!doctype html><title>CAS fixture</title>' }));
  for (const view of [page, second]) {
    await view.addInitScript(() => {
      const state = globalThis as any; state.isTauri = true;
      state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
        const request = args.request;
        if (command.endsWith('|secret_get')) { const value=localStorage.getItem('cas-fixture-keychain'); return value===null ? {ok:true} : {ok:true,value}; }
        if (command.endsWith('|secret_set')) {
          if (state.delayNext) { state.delayNext=false; await new Promise<void>(resolve => { state.releaseWrite=resolve; }); }
          if (request.compare !== true) return {ok:false};
          if (localStorage.getItem('cas-fixture-keychain') !== request.expected) return {ok:true,persisted:false};
          localStorage.setItem('cas-fixture-keychain',request.value); return {ok:true,persisted:true};
        }
        return {ok:true};
      } };
    });
    await view.goto('/cas-fixture');
    await view.evaluate(async () => { const module=await import('/src/connection-selection.ts' as string); (globalThis as any).selection=module.createConnectionSelectionStore(); });
  }
  await page.evaluate(() => {
    const state=globalThis as any; state.delayNext=true;
    state.staleResult=state.selection.begin('wss://laptop.example.ts.net/ws').then(()=>'unexpected success',()=> 'conflict');
  });
  await expect.poll(()=>page.evaluate(()=>typeof (globalThis as any).releaseWrite)).toBe('function');
  await second.evaluate(async () => {
    const store=(globalThis as any).selection, url='wss://laptop.example.ts.net/ws';
    const ticket=await store.begin(url);await store.commit(ticket,{source:'manual',url,token:'synthetic-fixture'});
  });
  await page.evaluate(() => (globalThis as any).releaseWrite());
  expect(await page.evaluate(() => (globalThis as any).staleResult)).toBe('conflict');
  const selected=await second.evaluate(() => (globalThis as any).selection.restore());
  expect(selected).toMatchObject({source:'manual',url:'wss://laptop.example.ts.net/ws',token:'synthetic-fixture'});
  await second.close();
});
