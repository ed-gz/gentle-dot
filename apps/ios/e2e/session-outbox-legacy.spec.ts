import {expect,test} from './fixtures.ts';

test('legacy unconfirmed mobile outbox remains visible but cannot be retried or discarded without evidence',async({page})=>{
 await page.goto('/');
 await page.evaluate(async url=>{
  const store=await import(/* @vite-ignore */ url);
  await store.persistDeliveries([{id:'legacy-message-123',identity:store.sessionDeliveryIdentity('scope|','p','s'),text:'Solicitud heredada',payload:JSON.stringify(['Solicitud heredada',null,null]),createdAt:Date.now(),status:'unconfirmed',baseline:new Set()}],true);
  const harness=await import('/e2e/session-outbox-harness.tsx');(globalThis as any).outboxHarness=harness.mountOutboxHarness();
 },`/@fs${process.cwd()}/packages/ui/src/session-delivery.ts`);
 const root=page.locator('#outbox-harness');await root.getByRole('button',{name:/Legacy session/}).click();await expect(root.getByText('Solicitud heredada')).toBeVisible();
 await expect(root.getByRole('button',{name:'Reintentar',exact:true})).toHaveCount(0);await expect(root.getByRole('button',{name:'Descartar',exact:true})).toHaveCount(0);
});

test('panel stays responsive after lost callback and cannot resend while native transport is active',async({page})=>{
 await page.goto('/');await page.evaluate(async()=>{const h=await import('/e2e/session-outbox-harness.tsx');(globalThis as any).delayedHarness=await h.mountDelayedOutboxHarness();});
 const root=page.locator('#delayed-outbox-harness');await root.getByRole('button',{name:/Delayed session/}).click();const text=root.getByRole('textbox',{name:'Continuar esta sesión'});await expect(text).toBeEnabled();await text.fill('Trabajo pendiente');
 const send=root.getByRole('button',{name:'Enviar instrucción',exact:true});await send.click();await expect.poll(()=>page.evaluate(()=>(globalThis as any).delayedHarness.posts())).toBe(1);
 await expect(send).toBeEnabled();await send.click();await expect.poll(()=>page.evaluate(()=>(globalThis as any).delayedHarness.posts())).toBe(1);
});
