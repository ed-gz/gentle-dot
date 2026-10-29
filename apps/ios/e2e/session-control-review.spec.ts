import {expect,test} from './fixtures.ts';

test('human can review exact control and close the notice without a model or resending',async({page})=>{
 await page.goto('/');
 await page.evaluate(async()=>{
  const {createControlJournal}=await import('/src/desktop-control-journal.ts'),{sessionOperationKey}=await import('/src/desktop-session-journal.ts'),journal=createControlJournal();
  const host='https://example.test/orchestration',text=JSON.stringify(['answer','q1']),id=crypto.randomUUID(),owner=crypto.randomUUID();
  await journal.begin({id,owner,key:sessionOperationKey(host,'p','s',text),host,paneId:'p',sessionId:'s',instanceId:'i',text,deliverAs:'followUp',state:'prepared',createdAt:1,nativeReceipt:1,control:{kind:'answer',payload:{action:'answer',requestId:'q1',text:'Contenido exacto',reviewedApproval:{message:'Evidencia de la pregunta'}}}});
  await journal.dispatching(id);await journal.unconfirmed(id);
  const harness=await import('/e2e/session-control-review-harness.tsx');(globalThis as any).reviewHarness=harness.mountReviewHarness({url:'wss://example.test/ws',token:'fixture'});
 });
 const root=page.locator('#review-harness');await root.getByRole('button',{name:'Avisos'}).click();const item=root.getByRole('button',{name:/Respuesta · s/});await item.dblclick();
 let dialog=root.getByRole('dialog');await expect(dialog).toBeVisible();await expect(dialog).toContainText('Contenido exacto');await expect(dialog).toContainText('Evidencia de la pregunta');
 await dialog.getByRole('button',{name:'Volver'}).click();await expect(dialog).toHaveCount(0);await item.click();dialog=root.getByRole('dialog');await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'Cerrar aviso'}).click();
 await expect(root.getByText('No hay avisos para esta laptop.')).toBeVisible();
 const count=await page.evaluate(async()=>{const {createControlJournal}=await import('/src/desktop-control-journal.ts');return (await createControlJournal().list('https://example.test/orchestration')).length;});expect(count).toBe(0);
});

test('changing hosts during review cancels the old dialog and unlocks the new host controls',async({page})=>{
 await page.goto('/');
 await page.evaluate(async()=>{
  const {createControlJournal}=await import('/src/desktop-control-journal.ts'),{sessionOperationKey}=await import('/src/desktop-session-journal.ts'),journal=createControlJournal();
  for(const name of ['first','second']){const host=`https://${name}.example.test/orchestration`,text=JSON.stringify(['answer','q']),id=crypto.randomUUID(),owner=crypto.randomUUID();
   await journal.begin({id,owner,key:sessionOperationKey(host,'p','s',text),host,paneId:'p',sessionId:'s',instanceId:'i',text,deliverAs:'followUp',state:'prepared',createdAt:1,control:{kind:'answer',payload:{action:'answer',requestId:'q',text:name}}});await journal.dispatching(id);await journal.unconfirmed(id);
  }
  const harness=await import('/e2e/session-control-review-harness.tsx');(globalThis as any).reviewHarness=harness.mountReviewHarness({url:'wss://first.example.test/ws',token:'fixture'});
 });
 const root=page.locator('#review-harness');await root.getByRole('button',{name:'Avisos'}).click();await root.getByRole('button',{name:/Respuesta · s/}).click();await expect(root.getByRole('dialog')).toContainText('first');
 await page.evaluate(()=>(globalThis as any).reviewHarness.setConnection({url:'wss://second.example.test/ws',token:'fixture'}));await expect(root.getByRole('dialog')).toHaveCount(0);
 await root.getByRole('button',{name:'Avisos'}).click();const next=root.getByRole('button',{name:/Respuesta · s/});await expect(next).toBeEnabled();await next.click();await expect(root.getByRole('dialog')).toContainText('second');
});

test('control and agent delivery pages advance independently without hiding either source',async({page})=>{
 await page.goto('/');
 await page.evaluate(async()=>{
  const c=await import('/src/desktop-control-journal.ts'),j=await import('/src/desktop-session-journal.ts'),controls=c.createControlJournal(),sends=j.createSessionJournal(),host='https://pages.example.test/orchestration';
  for(let i=0;i<12;i++){const text=JSON.stringify(['answer',`q${i}`]),id=crypto.randomUUID(),owner=crypto.randomUUID();await controls.begin({id,owner,key:j.sessionOperationKey(host,'p',`control-${i}`,text),host,paneId:'p',sessionId:`control-${i}`,instanceId:'i',text,deliverAs:'followUp',state:'prepared',createdAt:i,control:{kind:'answer',payload:{requestId:`q${i}`}}});await controls.dispatching(id);await controls.unconfirmed(id);}
  const text='Envío único',id=crypto.randomUUID(),owner=crypto.randomUUID();await sends.begin({id,owner,key:j.sessionOperationKey(host,'p','delivery-only',text),host,paneId:'p',sessionId:'delivery-only',instanceId:'i',text,deliverAs:'followUp',state:'prepared',createdAt:1});await sends.dispatching(id);await sends.unconfirmed(id);
  const h=await import('/e2e/session-control-review-harness.tsx');(globalThis as any).reviewHarness=h.mountReviewHarness({url:'wss://pages.example.test/ws',token:'fixture'});
 });
 const root=page.locator('#review-harness');await root.getByRole('button',{name:'Avisos'}).click();await expect(root.getByRole('button',{name:/Instrucción · delivery-only/})).toBeVisible();
 await root.getByRole('button',{name:'Más controles'}).click();await expect(root.getByRole('button',{name:'Controles anteriores'})).toBeVisible();await expect(root.getByRole('button',{name:/Instrucción · delivery-only/})).toBeVisible();
 expect(await root.getByRole('button',{name:/Respuesta · control-/}).count()).toBe(2);
});
