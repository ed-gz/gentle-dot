import { expect, test } from './fixtures.ts';

test('the real rig stops drawing in background and reduced motion and resumes across panels', async ({ page }) => {
  test.slow();
  await page.addInitScript(() => {
    const proto=WebGLRenderingContext.prototype, original=proto.drawArrays;
    (globalThis as any).capriDraws=0;
    proto.drawArrays=function(...args:Parameters<WebGLRenderingContext['drawArrays']>) {
      if(this.canvas instanceof HTMLCanvasElement && this.canvas.id==='capri') (globalThis as any).capriDraws++;
      return original.apply(this,args);
    };
  });
  await page.goto('/');
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=240;c.height=420;const ctx=c.getContext('2d')!;ctx.fillStyle='#ff408e';ctx.fillRect(50,20,140,370);return c.toDataURL().split(',')[1]!;});
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#art').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready','true',{timeout:30000});
  const count=()=>page.evaluate(()=>(globalThis as any).capriDraws as number);
  let previous=await count(); await expect.poll(count,{timeout:15000}).toBeGreaterThan(previous);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  const hidden=await count(); await page.waitForTimeout(400); expect(await count()).toBe(hidden);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await expect.poll(count,{timeout:15000}).toBeGreaterThan(hidden);
  for (const panel of ['agents','chat','settings']) {
    await page.locator(`[data-panel="${panel}"]`).click();
    await expect(page.locator('#rig-handle')).toBeVisible();
    previous=await count(); await expect.poll(count,{timeout:15000}).toBeGreaterThan(previous);
  }
  await page.locator('#settings-character > summary').click();
  await page.locator('#motion').selectOption('reduced');
  await expect(page.locator('html')).toHaveAttribute('data-motion','reduced');
  await page.waitForTimeout(300);
  const reduced=await count(); await page.waitForTimeout(400); expect(await count()).toBe(reduced);
  await page.locator('[data-panel="chat"]').click(); await page.waitForTimeout(300);
  const afterPanel=await count(); expect(afterPanel).toBeGreaterThan(reduced);
  await page.waitForTimeout(400); expect(await count()).toBe(afterPanel);
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#motion').selectOption('full');
  await expect.poll(count,{timeout:15000}).toBeGreaterThan(afterPanel);
});

test('the system reduced-motion setting is respected from startup', async ({page}) => {
  test.slow(); await page.emulateMedia({reducedMotion:'reduce'});
  await page.addInitScript(() => {
    const proto=WebGLRenderingContext.prototype, original=proto.drawArrays; (globalThis as any).capriDraws=0;
    proto.drawArrays=function(...args:Parameters<WebGLRenderingContext['drawArrays']>) {
      if(this.canvas instanceof HTMLCanvasElement && this.canvas.id==='capri') (globalThis as any).capriDraws++;
      return original.apply(this,args);
    };
  });
  await page.goto('/'); const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=240;c.height=420;c.getContext('2d')!.fillRect(50,20,140,370);return c.toDataURL().split(',')[1]!;});
  await page.locator('[data-panel="settings"]').click(); await page.locator('#art').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready','true',{timeout:30000});
  await expect(page.locator('html')).toHaveAttribute('data-motion','reduced');
  await expect.poll(()=>page.evaluate(()=>(globalThis as any).capriDraws)).toBeGreaterThan(0);
  await page.waitForTimeout(300); const count=await page.evaluate(()=>(globalThis as any).capriDraws);
  await page.waitForTimeout(400); expect(await page.evaluate(()=>(globalThis as any).capriDraws)).toBe(count);
});

test('a cached page resumes interrupted GPU setup without repeated rebuilds', async ({page}) => {
  test.slow();
  await page.addInitScript(() => {
    const state=globalThis as any;state.programs=0;state.polls=0;state.ready=false;
    const p=WebGLRenderingContext.prototype, create=p.createProgram, extension=p.getExtension, parameter=p.getProgramParameter;
    p.createProgram=function(){state.programs++;return create.call(this);};
    p.getExtension=function(name:string){return name==='KHR_parallel_shader_compile'?{COMPLETION_STATUS_KHR:0x91b1} as any:extension.call(this,name);};
    p.getProgramParameter=function(program:WebGLProgram,pname:number){if(pname===0x91b1){state.polls++;return state.ready;}return parameter.call(this,program,pname);};
  });
  await page.goto('/'); const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=240;c.height=420;c.getContext('2d')!.fillRect(50,20,140,370);return c.toDataURL().split(',')[1]!;});
  await page.locator('[data-panel="settings"]').click();await page.locator('#art').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await expect.poll(()=>page.evaluate(()=>(globalThis as any).polls)).toBeGreaterThan(0);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
  const halted=await page.evaluate(()=>(globalThis as any).polls);await page.waitForTimeout(150);expect(await page.evaluate(()=>(globalThis as any).polls)).toBe(halted);
  await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));(globalThis as any).ready=true;});
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready','true',{timeout:30000});
  expect(await page.evaluate(()=>(globalThis as any).programs)).toBe(2);
});
