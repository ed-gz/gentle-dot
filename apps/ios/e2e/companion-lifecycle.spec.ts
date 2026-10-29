import { expect, test } from './fixtures.ts';

test('slow GPU preparation pauses while the app is hidden and restarts in foreground', async ({page}) => {
  test.slow();
  await page.addInitScript(() => {
    const state=globalThis as any; state.shaderPolls=0; state.shaderPrograms=0; state.releaseShader=false;
    const proto=WebGLRenderingContext.prototype;
    const getExtension=proto.getExtension, getParameter=proto.getProgramParameter, createProgram=proto.createProgram;
    proto.createProgram=function() { state.shaderPrograms++; return createProgram.call(this); };
    proto.getExtension=function(name:string) { return name==='KHR_parallel_shader_compile' ? {COMPLETION_STATUS_KHR:0x91b1} as any : getExtension.call(this,name); };
    proto.getProgramParameter=function(program:WebGLProgram,pname:number) { if(pname===0x91b1){state.shaderPolls++; return state.releaseShader;} return getParameter.call(this,program,pname); };
  });
  await page.goto('/'); const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=240;c.height=420; const ctx=c.getContext('2d')!;ctx.fillStyle='#ff408e';ctx.fillRect(30,10,180,400); return c.toDataURL().split(',')[1]!;});
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#art').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await expect.poll(()=>page.evaluate(()=>(globalThis as any).shaderPolls)).toBeGreaterThan(1);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange'));});
  const paused=await page.evaluate(()=>(globalThis as any).shaderPolls);
  await page.waitForTimeout(250);
  expect(await page.evaluate(()=>(globalThis as any).shaderPolls)).toBe(paused);
  await page.evaluate(()=>{(globalThis as any).releaseShader=true; Object.defineProperty(document,'hidden',{configurable:true,value:false}); document.dispatchEvent(new Event('visibilitychange'));});
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready','true',{timeout:30000});
  const programs=await page.evaluate(()=>(globalThis as any).shaderPrograms);
  expect(programs).toBe(2);
  await page.evaluate(()=>{
    Object.defineProperty(document,'hidden',{configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document,'hidden',{configurable:true,value:false}); document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(150);
  expect(await page.evaluate(()=>(globalThis as any).shaderPrograms)).toBe(programs);
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready','true');
});

test('immediate background and foreground cannot strand the aborted GPU attempt', async ({page}) => {
  test.slow();
  await page.addInitScript(() => {
    const state=globalThis as any; state.shaderPolls=0; state.shaderPrograms=0; state.releaseShader=false;
    const proto=WebGLRenderingContext.prototype, getExtension=proto.getExtension, getParameter=proto.getProgramParameter, createProgram=proto.createProgram;
    proto.createProgram=function() { state.shaderPrograms++; return createProgram.call(this); };
    proto.getExtension=function(name:string) { return name==='KHR_parallel_shader_compile' ? {COMPLETION_STATUS_KHR:0x91b1} as any : getExtension.call(this,name); };
    proto.getProgramParameter=function(program:WebGLProgram,pname:number) { if(pname===0x91b1){state.shaderPolls++; return state.releaseShader;} return getParameter.call(this,program,pname); };
  });
  await page.goto('/'); const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=240;c.height=420;c.getContext('2d')!.fillRect(30,10,180,400);return c.toDataURL().split(',')[1]!;});
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#art').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await expect.poll(()=>page.evaluate(()=>(globalThis as any).shaderPolls)).toBeGreaterThan(0);
  await page.evaluate(()=>{
    Object.defineProperty(document,'hidden',{configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document,'hidden',{configurable:true,value:false}); document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    (globalThis as any).releaseShader=true;
  });
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready','true',{timeout:30000});
  await expect(page.locator('#art-placeholder')).toBeHidden();
  expect(await page.evaluate(()=>(globalThis as any).shaderPrograms)).toBe(2);
});

test('an artwork chosen while shader preparation is suspended is the one resumed', async ({page}) => {
  test.slow();
  await page.addInitScript(() => {
    const state=globalThis as any; state.shaderPolls=0; state.releaseShader=sessionStorage.getItem('fixture-shader-ready')==='1';
    const proto=WebGLRenderingContext.prototype, getExtension=proto.getExtension, getParameter=proto.getProgramParameter;
    const texture=proto.texImage2D;
    (proto as any).texImage2D=function(...args:any[]) {
      const source=args.at(-1);
      if(source instanceof HTMLImageElement) { const canvas=document.createElement('canvas'); canvas.width=240; canvas.height=420; const ctx=canvas.getContext('2d')!;ctx.drawImage(source,0,0); state.uploadedPixel=[...ctx.getImageData(120,100,1,1).data]; }
      return (texture as any).apply(this,args);
    };
    proto.getExtension=function(name:string) { return name==='KHR_parallel_shader_compile' ? {COMPLETION_STATUS_KHR:0x91b1} as any : getExtension.call(this,name); };
    proto.getProgramParameter=function(program:WebGLProgram,pname:number) { if(pname===0x91b1){state.shaderPolls++; return state.releaseShader;} return getParameter.call(this,program,pname); };
  });
  await page.goto('/'); const images=await page.evaluate(()=>['#ff408e','#baff67'].map(color=>{const c=document.createElement('canvas');c.width=240;c.height=420;const ctx=c.getContext('2d')!;ctx.fillStyle=color;ctx.fillRect(30,10,180,400);return c.toDataURL().split(',')[1]!;}));
  await page.locator('[data-panel="settings"]').click();
  const input=page.locator('#art'); await input.setInputFiles({name:'first.png',mimeType:'image/png',buffer:Buffer.from(images[0]!, 'base64')});
  await expect.poll(()=>page.evaluate(()=>(globalThis as any).shaderPolls)).toBeGreaterThan(0);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange'));});
  const paused=await page.evaluate(()=>(globalThis as any).shaderPolls);
  await input.setInputFiles({name:'second.png',mimeType:'image/png',buffer:Buffer.from(images[1]!, 'base64')});
  await expect.poll(()=>page.evaluate(async()=>{
    const blob=await (await import('/src/local-state.ts')).loadArtwork(); if(!blob)return '';
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  })).toBe(images[1]);
  await page.waitForTimeout(100); expect(await page.evaluate(()=>(globalThis as any).shaderPolls)).toBe(paused);
  await page.evaluate(()=>{(globalThis as any).releaseShader=true;Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready','true',{timeout:30000});
  expect(await page.evaluate(()=>(globalThis as any).uploadedPixel)).toEqual([186,255,103,255]);
  await page.evaluate(()=>sessionStorage.setItem('fixture-shader-ready','1'));
  await page.reload(); await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready','true',{timeout:30000});
  expect(await page.evaluate(async()=>{const blob=await (await import('/src/local-state.ts')).loadArtwork();return blob ? btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer()))) : '';})).toBe(images[1]);
});
