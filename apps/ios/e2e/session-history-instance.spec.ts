import { expect, test } from './fixtures.ts';

test('a late earlier page from the old runtime cannot enter the restarted session', async ({ page }) => {
  await page.addInitScript(() => {
    const state=globalThis as any;state.isTauri=true;state.instance='old';state.olderReads=0;
    state.__TAURI_INTERNALS__={invoke:async (command:string,args:any)=>{
      if(command.endsWith('https_request')) {
        const request=args.request.body ? JSON.parse(args.request.body) : undefined;
        if(request?.action==='inspect') {
          const instance=state.instance;
          const result={sessionId:request.sessionId,instanceId:instance,status:'working',question:null,
            messages:[{id:request.before ? `earlier-${instance}`:'shared-id',role:'assistant',content:[{type:'text',text:request.before ? `Anterior ${instance}` : `Actual ${instance}`}]}],
            history:{supported:true,hasEarlier:!request.before,...(!request.before?{before:'same-cursor'}:{})}};
          const reply={ok:true,status:200,headers:{},body:JSON.stringify(result)};
          if(request.before && ++state.olderReads===1) return await new Promise(resolve=>{state.releaseOld=()=>resolve(reply);});
          return reply;
        }
        return {ok:true,status:200,headers:{},body:JSON.stringify({available:true,sessions:[{paneId:'pane',sessionId:'session',label:'Proyecto',provider:'herdr',state:'working',connected:true,managed:true,capabilities:{inspect:true,prompt:true}}],approvals:[],policies:[],events:[]})};
      }
      if(command.endsWith('check_availability'))return {available:false,status:'model_not_ready',supportsSpanish:false};
      if(command.endsWith('results_list')||command.endsWith('share_list')||command.endsWith('documents_list'))return {ok:true,items:[]};
      return {ok:true};
    }};
  });
  await page.goto('/');
  await page.evaluate(async()=>{
    document.querySelector<HTMLElement>('#panel-chat')!.hidden=true;document.querySelector<HTMLElement>('#panel-agents')!.hidden=false;
    const {mountLaptopView}=await import('/src/laptop-view.tsx' as string);
    mountLaptopView(document.querySelector('#laptop-root')!,()=>{},()=>{}).update({connection:{url:'wss://laptop.example/ws',token:'fixture'},active:true});
  });
  await page.getByRole('button',{name:/Proyecto/}).click();await expect(page.getByText('Actual old')).toBeVisible();
  await page.getByRole('button',{name:'Ver mensajes anteriores'}).click();
  await expect.poll(()=>page.evaluate(()=>typeof (globalThis as any).releaseOld)).toBe('function');
  await page.evaluate(()=>{(globalThis as any).instance='new';});
  await expect(page.getByText('Actual new')).toBeVisible({timeout:8000});
  await page.evaluate(()=>(globalThis as any).releaseOld());
  await expect(page.getByText('La instancia de la sesión cambió mientras cargaba el historial. Vuelve a pedir los mensajes anteriores.')).toBeVisible();
  await expect(page.getByText('Anterior old')).toHaveCount(0);
  await page.getByRole('button',{name:'Ver mensajes anteriores'}).click();
  await expect(page.getByText('Anterior new')).toBeVisible();
  await expect(page.getByText('Anterior old')).toHaveCount(0);
});

test('a legacy host without runtime identity keeps recent history readable but does not mix earlier pages', async ({page})=>{
  await page.addInitScript(()=>{
    const state=globalThis as any;state.isTauri=true;state.earlier=0;
    state.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
      if(command.endsWith('https_request')){
        const action=args.request.body?JSON.parse(args.request.body):undefined;
        if(action?.action==='inspect'){
          if(action.before)state.earlier++;
          return {ok:true,status:200,headers:{},body:JSON.stringify({sessionId:action.sessionId,status:'idle',question:null,messages:[{id:'recent',role:'assistant',content:[{type:'text',text:'Historia reciente legada'}]}],history:{supported:true,hasEarlier:true,before:'cursor'}})};
        }
        return {ok:true,status:200,headers:{},body:JSON.stringify({available:true,sessions:[{paneId:'pane',sessionId:'session',label:'Proyecto',state:'idle',connected:true,managed:true,capabilities:{inspect:true,prompt:true}}],approvals:[],policies:[],events:[]})};
      }
      if(command.endsWith('check_availability'))return {available:false,status:'model_not_ready',supportsSpanish:false};
      if(command.endsWith('results_list')||command.endsWith('share_list')||command.endsWith('documents_list'))return {ok:true,items:[]};return {ok:true};
    }};
  });
  await page.goto('/');await page.evaluate(async()=>{
    document.querySelector<HTMLElement>('#panel-chat')!.hidden=true;document.querySelector<HTMLElement>('#panel-agents')!.hidden=false;
    const {mountLaptopView}=await import('/src/laptop-view.tsx' as string);mountLaptopView(document.querySelector('#laptop-root')!,()=>{},()=>{}).update({connection:{url:'wss://laptop.example/ws',token:'fixture'},active:true});
  });
  await page.getByRole('button',{name:/Proyecto/}).click();await expect(page.getByText('Historia reciente legada')).toBeVisible();
  await page.getByRole('button',{name:'Ver mensajes anteriores'}).click();
  await expect(page.getByText('La laptop necesita actualizarse para verificar páginas anteriores de esta sesión. El historial reciente sigue disponible.')).toBeVisible();
  expect(await page.evaluate(()=>(globalThis as any).earlier)).toBe(0);
});

test('reopening a session waits for its runtime before displaying cached history', async ({page})=>{
  await page.addInitScript(()=>{
    const state=globalThis as any;state.isTauri=true;state.instance='old';state.hold=false;
    state.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
      if(command.endsWith('https_request')){
        const action=args.request.body?JSON.parse(args.request.body):undefined;
        if(action?.action==='inspect'){
          const instance=state.instance;
          const reply={ok:true,status:200,headers:{},body:JSON.stringify({sessionId:action.sessionId,instanceId:instance,status:'idle',question:null,messages:[{id:'shared',role:'assistant',content:[{type:'text',text:`Historial ${instance}`}]}],history:{supported:true,hasEarlier:false}})};
          if(state.hold){state.hold=false;return await new Promise(resolve=>{state.finishReopen=()=>resolve(reply);});}
          return reply;
        }
        return {ok:true,status:200,headers:{},body:JSON.stringify({available:true,sessions:[{paneId:'pane',sessionId:'session',label:'Proyecto',state:'idle',connected:true,managed:true,capabilities:{inspect:true,prompt:true}}],approvals:[],policies:[],events:[]})};
      }
      if(command.endsWith('check_availability'))return {available:false,status:'model_not_ready',supportsSpanish:false};
      if(command.endsWith('results_list')||command.endsWith('share_list')||command.endsWith('documents_list'))return {ok:true,items:[]};return {ok:true};
    }};
  });
  await page.goto('/');await page.evaluate(async()=>{
    document.querySelector<HTMLElement>('#panel-chat')!.hidden=true;document.querySelector<HTMLElement>('#panel-agents')!.hidden=false;
    const {mountLaptopView}=await import('/src/laptop-view.tsx' as string);(globalThis as any).testLaptop=mountLaptopView(document.querySelector('#laptop-root')!,()=>{},()=>{});(globalThis as any).testLaptop.update({connection:{url:'wss://laptop.example/ws',token:'fixture'},active:true});
  });
  await page.getByRole('button',{name:/Proyecto/}).click();await expect(page.getByText('Historial old')).toBeVisible();
  await page.evaluate(()=>window.dispatchEvent(new Event('gentledot-back',{cancelable:true})));
  await page.evaluate(()=>{(globalThis as any).instance='new';(globalThis as any).hold=true;});
  await page.getByRole('button',{name:/Proyecto/}).click();await expect.poll(()=>page.evaluate(()=>typeof (globalThis as any).finishReopen)).toBe('function');
  await expect(page.getByText('Historial old')).toHaveCount(0);await expect(page.getByText('Cargando el historial de esta sesión…')).toBeVisible();
  await page.evaluate(()=>(globalThis as any).finishReopen());await expect(page.getByText('Historial new')).toBeVisible();
  await expect(page.getByText('Historial old')).toHaveCount(0);
  await page.evaluate(()=>{const state=globalThis as any;state.testLaptop.update({connection:{url:'wss://laptop.example/ws',token:'fixture'},active:false});state.instance='again';state.hold=true;state.finishReopen=undefined;});
  await page.evaluate(()=>{(globalThis as any).testLaptop.update({connection:{url:'wss://laptop.example/ws',token:'fixture'},active:true});});
  await expect.poll(()=>page.evaluate(()=>typeof (globalThis as any).finishReopen)).toBe('function');
  await expect(page.getByText('Historial new')).toHaveCount(0);
  await page.evaluate(()=>(globalThis as any).finishReopen());await expect(page.getByText('Historial again')).toBeVisible();
  await page.evaluate(()=>{const state=globalThis as any;Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));state.instance='foreground';state.hold=true;state.finishReopen=undefined;});
  await expect(page.getByText('Historial again')).toHaveCount(0);
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));});
  await expect.poll(()=>page.evaluate(()=>typeof (globalThis as any).finishReopen)).toBe('function');
  await expect(page.getByText('Historial again')).toHaveCount(0);
  await page.evaluate(()=>(globalThis as any).finishReopen());await expect(page.getByText('Historial foreground')).toBeVisible();
});
