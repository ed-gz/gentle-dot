import { expect, test, type Page } from './fixtures.ts';

type Fixture = { holdFirst?: boolean; toolSequence?: boolean; unavailable?: boolean; failFirstEnd?: boolean };
async function nativeActivity(page: Page, fixture: Fixture = {}) {
  await page.addInitScript((initial: Fixture) => {
    const state = globalThis as any;
    state.isTauri = true; state.activityCalls = []; state.modelCalls = []; state.cancelCalls = 0;
    state.currentActivity = JSON.parse(sessionStorage.getItem("fixture-live-activity") || "null") ?? undefined;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      const name = command.split('|').at(-1);
      if (name === 'secret_get') { const request=args.request, value=sessionStorage.getItem(`fixture-keychain:${request.scope}:${request.account}`); return value===null?{ok:true}:{ok:true,value}; }
      if (name === 'secret_set') { const request=args.request;const key=`fixture-keychain:${request.scope}:${request.account}`;if(request.compare===true && sessionStorage.getItem(key)!==(request.expected??null))return {ok:true,persisted:false};sessionStorage.setItem(key,request.value);return {ok:true,persisted:true}; }
      if (name?.startsWith('live_activity_')) {
        const action = name.slice('live_activity_'.length), request = args?.request ?? {};
        state.activityCalls.push({ action, request: structuredClone(request), ...(action === 'end' ? { journalAcked: sessionStorage.getItem('fixture-journal-acked') === '1' } : {}) });
        if (action === 'available') return { ok: true, enabled: !initial.unavailable };
        if (action === 'list') return { ok: true, items: state.currentActivity ? [structuredClone(state.currentActivity)] : [] };
        if (action === 'start') {
          state.currentActivity = { ...request, id: 'activity-1', observedAt: request.observedAt ?? Date.now(), stale: false };
          sessionStorage.setItem('fixture-live-activity', JSON.stringify(state.currentActivity));
          return { ok: true, id: 'activity-1', items: [structuredClone(state.currentActivity)] };
        }
        if (action === 'update') {
          state.currentActivity = { ...request, observedAt: request.observedAt ?? Date.now(), stale: false };
          sessionStorage.setItem('fixture-live-activity', JSON.stringify(state.currentActivity));
          return { ok: true, id: request.id };
        }
        if (action === 'end') {
          if (initial.failFirstEnd && !sessionStorage.getItem('fixture-live-end-failed')) {
            sessionStorage.setItem('fixture-live-end-failed', '1'); return { ok: false, message: 'No se confirmó el cierre.' };
          }
          state.currentActivity = undefined; sessionStorage.removeItem('fixture-live-activity'); return { ok: true, id: request.id };
        }
      }
      if (command.endsWith('results_list')) return { ok: true, items: JSON.parse(sessionStorage.getItem('fixture-inference-journal') || '[]') };
      if (command.endsWith('results_acknowledge')) {
        const { loadConversation } = await import('/src/conversation.ts' as string);
        const { conversationArchive } = await import('/src/conversation-archive.ts' as string);
        const entry = (await loadConversation()).entries.find((item: any) => item.id === args.turnId);
        const archived = await conversationArchive.load(JSON.stringify(['iphone', 'iphone:main', args.turnId]));
        sessionStorage.setItem('fixture-journal-ack-detail', JSON.stringify({ args, entry, archived }));
        const items = JSON.parse(sessionStorage.getItem('fixture-inference-journal') || '[]');
        sessionStorage.setItem('fixture-inference-journal', JSON.stringify(items.filter((item: any) => item.id !== args.turnId || item.revision !== args.revision)));
        sessionStorage.setItem('fixture-journal-acked', '1'); return { ok: true };
      }
      if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('notification_status')) return { ok: true, enabled: false, authorization: 'not_determined' };
      if (command.endsWith('check_availability')) return { available: true, status: 'available', supportsSpanish: true };
      if (command.endsWith('check_voice')) {
        if (state.holdVoice) await new Promise<void>(resolve => { state.finishVoice = resolve; });
        return { available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted', recording: false };
      }
      if (command.endsWith('cancel')) { state.cancelCalls++; return { ok: true }; }
      if (command.endsWith('agent_step')) {
        state.modelCalls.push({ turnId: args.turnId });
        const step = state.modelCalls.length;
        if (step === 1 && initial.holdFirst) await new Promise<void>(resolve => { state.finishFirst = resolve; });
        if (initial.toolSequence && step === 1) return { ok: true, decision: { kind: 'tool', text: 'Consultaré capacidades.', toolName: 'tool_describe', argumentsJSON: '{"name":"local_capabilities"}' } };
        if (initial.toolSequence && step === 2) {
          state.holdVoice = true;
          return { ok: true, decision: { kind: 'tool', text: 'Comprobaré capacidades.', toolName: 'local_capabilities', argumentsJSON: '{}' } };
        }
        return { ok: true, decision: { kind: 'answer', text: 'Resultado local confirmado.', toolName: '', argumentsJSON: '{}' } };
      }
      return { ok: true };
    } };
  }, fixture);
  await page.goto('/');
  await expect(page.locator('#send')).toBeEnabled();
}
async function openSettings(page: Page) {
  await page.locator('[data-panel="settings"]').click();
  if (!(await page.locator('#settings-intelligence').evaluate((el: HTMLDetailsElement) => el.open))) await page.locator('#settings-intelligence > summary').click();
}
async function submit(page: Page) {
  await page.locator('[data-panel="chat"]').click();
  await page.locator('#prompt').fill('Revisa mis capacidades.');
  await page.locator('#send').click();
}
const toggle = '#live-activity-settings input';
const status = '#live-activity-settings [role="status"]';

test('without opt-in, a real local turn never queries or starts a Lock Screen activity', async ({ page }) => {
  await nativeActivity(page);
  await submit(page);
  await expect(page.locator('#cards')).toContainText('Resultado local confirmado.');
  await expect.poll(() => page.evaluate(() => (globalThis as any).modelCalls.length)).toBe(1);
  expect(await page.evaluate(() => (globalThis as any).activityCalls)).toEqual([]);
  await openSettings(page); await expect(page.locator(toggle)).not.toBeChecked();
  await expect(page.locator(status)).toContainText('Desactivado');
});

test('opt-in inspects the system; real inference and tool events drive a confirmed activity', async ({ page }) => {
  await nativeActivity(page, { holdFirst: true, toolSequence: true });
  await openSettings(page); await page.getByLabel('Mostrar progreso en pantalla bloqueada').check();
  await expect(page.locator(status)).toContainText('Se mostrará al iniciar una respuesta local');
  expect((await page.evaluate(() => (globalThis as any).activityCalls)).map((call: any) => call.action)).toEqual(['available', 'list']);
  await submit(page);
  await expect.poll(() => page.evaluate(() => (globalThis as any).activityCalls.some((call: any) => call.action === 'start'))).toBe(true);
  const start = await page.evaluate(() => (globalThis as any).activityCalls.find((call: any) => call.action === 'start'));
  expect(start.request).toMatchObject({ origin: 'iphone', phase: 'thinking', sequence: 1 });
  expect(Object.keys(start.request).sort()).toEqual(['origin', 'phase', 'sequence', 'turnId']);
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishFirst)).toBe('function');
  expect(await page.evaluate(() => (globalThis as any).modelCalls[0].turnId)).toBe(start.request.turnId);
  await page.evaluate(() => (globalThis as any).finishFirst());
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishVoice)).toBe('function');
  await expect.poll(() => page.evaluate(() => (globalThis as any).activityCalls.some((call: any) => call.action === 'update' && call.request.phase === 'working'))).toBe(true);
  await page.evaluate(() => { (globalThis as any).holdVoice = false; (globalThis as any).finishVoice(); });
  await expect(page.locator('#cards')).toContainText('Resultado local confirmado.');
  await expect.poll(() => page.evaluate(() => (globalThis as any).activityCalls.some((call: any) => call.action === 'end'))).toBe(true);
  const calls = await page.evaluate(() => (globalThis as any).activityCalls);
  const end = calls.find((call: any) => call.action === 'end');
  expect(end.request).toMatchObject({ id: 'activity-1', turnId: start.request.turnId, origin: 'iphone', phase: 'finished' });
  const startAt = calls.findIndex((call: any) => call.action === 'start');
  expect(calls.slice(0, startAt).map((call: any) => call.action)).toEqual(['available', 'list']);
  expect(calls.some((call: any) => JSON.stringify(call.request).includes('Revisa mis capacidades.'))).toBe(false);
});

test('turning off the Lock Screen surface dismisses it without cancelling the model', async ({ page }) => {
  await nativeActivity(page, { holdFirst: true });
  await openSettings(page); await page.getByLabel('Mostrar progreso en pantalla bloqueada').check();
  await expect(page.locator(status)).toContainText('Se mostrará al iniciar una respuesta local');
  await submit(page);
  await expect.poll(() => page.evaluate(() => (globalThis as any).activityCalls.some((call: any) => call.action === 'start'))).toBe(true);
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishFirst)).toBe('function');
  await openSettings(page); await page.getByLabel('Mostrar progreso en pantalla bloqueada').uncheck();
  await expect(page.locator(status)).toContainText('el trabajo continúa');
  await expect.poll(() => page.evaluate(() => (globalThis as any).activityCalls.some((call: any) => call.action === 'end'))).toBe(true);
  let events = await page.evaluate(() => (globalThis as any).activityCalls.filter((call: any) => call.action === 'end'));
  expect(events).toHaveLength(1); expect(events[0].request.phase).toBe('dismissed');
  expect(await page.evaluate(() => (globalThis as any).cancelCalls)).toBe(0);
  await page.evaluate(() => (globalThis as any).finishFirst());
  await page.locator('[data-panel="chat"]').click();
  await expect(page.locator('#cards')).toContainText('Resultado local confirmado.');
  events = await page.evaluate(() => (globalThis as any).activityCalls.filter((call: any) => call.action === 'end'));
  expect(events).toHaveLength(1); expect(await page.evaluate(() => (globalThis as any).cancelCalls)).toBe(0);
});

test('opt-out with an uncertain close inspects after restart and only dismisses on a new tap', async ({ page }) => {
  await nativeActivity(page, { holdFirst: true, failFirstEnd: true });
  await openSettings(page); await page.getByLabel('Mostrar progreso en pantalla bloqueada').check();
  await expect(page.locator(status)).toContainText('Se mostrará al iniciar una respuesta local');
  await submit(page);
  await expect.poll(() => page.evaluate(() => (globalThis as any).activityCalls.some((call: any) => call.action === 'start'))).toBe(true);
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishFirst)).toBe('function');
  await openSettings(page); await page.getByLabel('Mostrar progreso en pantalla bloqueada').uncheck();
  await expect(page.locator(status)).toContainText('No se confirmó el cierre.');
  await expect(page.getByRole('button', { name: 'Comprobar estado' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('capri.ios.lock-screen-activity.v1'))).toBe('0');
  const first = await page.evaluate(() => (globalThis as any).activityCalls.filter((call: any) => call.action === 'end'));
  expect(first).toHaveLength(1); expect(first[0].request.phase).toBe('dismissed');

  await page.reload(); await openSettings(page);
  await expect(page.locator(toggle)).not.toBeChecked();
  await expect(page.locator(status)).toContainText('actividad abierta');
  const before = await page.evaluate(() => (globalThis as any).activityCalls);
  expect(before.map((call: any) => call.action)).toEqual(['available', 'list']);
  expect(await page.evaluate(() => (globalThis as any).modelCalls.length)).toBe(0);
  await page.getByRole('button', { name: 'Ocultar actividad' }).click();
  await expect(page.locator(status)).toContainText('el trabajo continúa');
  const after = await page.evaluate(() => (globalThis as any).activityCalls);
  expect(after.map((call: any) => call.action)).toEqual(['available', 'list', 'end']);
  expect(after[2].request.phase).toBe('dismissed');
  expect(await page.evaluate(() => (globalThis as any).cancelCalls)).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem('fixture-live-activity'))).toBeNull();
});

test('after restart a confirmed native answer is saved and ACKed before finishing its existing activity', async ({ page }) => {
  await nativeActivity(page, { holdFirst: true });
  await openSettings(page); await page.getByLabel('Mostrar progreso en pantalla bloqueada').check();
  await expect(page.locator(status)).toContainText('Se mostrará al iniciar una respuesta local');
  await submit(page);
  await expect.poll(() => page.evaluate(() => (globalThis as any).activityCalls.some((call: any) => call.action === 'start'))).toBe(true);
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishFirst)).toBe('function');
  const turnId = await page.evaluate(() => (globalThis as any).activityCalls.find((call: any) => call.action === 'start').request.turnId);
  const revision = 'a3dba896-4b5c-4c1c-98c9-4e60238fe6b9';
  const response = 'Respuesta recuperada de la inferencia terminada.';
  await page.evaluate(({ turnId, revision, response }) => {
    sessionStorage.removeItem('fixture-journal-acked');
    sessionStorage.setItem('fixture-inference-journal', JSON.stringify([{ id: turnId, revision, startedAt: Date.now(), status: 'answer', text: response }]));
  }, { turnId, revision, response });
  await page.reload();
  await expect(page.locator('#cards')).toContainText(response);
  await expect.poll(() => page.evaluate(() => (globalThis as any).activityCalls.some((call: any) => call.action === 'end'))).toBe(true);
  const result = await page.evaluate(() => ({ calls: (globalThis as any).activityCalls, modelCalls: (globalThis as any).modelCalls,
    ack: JSON.parse(sessionStorage.getItem('fixture-journal-ack-detail') || 'null'), journal: JSON.parse(sessionStorage.getItem('fixture-inference-journal') || '[]') }));
  expect(result.modelCalls).toEqual([]);
  expect(result.calls.filter((call: any) => call.action === 'start')).toEqual([]);
  const ends = result.calls.filter((call: any) => call.action === 'end');
  expect(ends).toHaveLength(1);
  expect(ends[0]).toMatchObject({ journalAcked: true, request: { id: 'activity-1', turnId, origin: 'iphone', phase: 'finished' } });
  expect(result.ack).toMatchObject({ args: { turnId, revision }, entry: { id: turnId, state: 'complete', text: response }, archived: { id: turnId, state: 'complete', text: response } });
  expect(result.journal).toEqual([]);
});

test('explicitly stopping a local turn ends its activity as interrupted, and a late answer cannot finish it', async ({ page }) => {
  await nativeActivity(page, { holdFirst: true });
  await openSettings(page); await page.getByLabel('Mostrar progreso en pantalla bloqueada').check();
  await expect(page.locator(status)).toContainText('Se mostrará al iniciar una respuesta local');
  await submit(page);
  await expect.poll(() => page.evaluate(() => (globalThis as any).activityCalls.some((call: any) => call.action === 'start'))).toBe(true);
  await expect.poll(() => page.evaluate(() => typeof (globalThis as any).finishFirst)).toBe('function');
  await page.locator('#stop').click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).activityCalls.some((call: any) => call.action === 'end'))).toBe(true);
  const ends = await page.evaluate(() => (globalThis as any).activityCalls.filter((call: any) => call.action === 'end'));
  expect(ends).toHaveLength(1); expect(ends[0].request.phase).toBe('interrupted');
  expect(await page.evaluate(() => (globalThis as any).cancelCalls)).toBe(1);
  await page.evaluate(() => (globalThis as any).finishFirst());
  await expect(page.locator('#cards')).toContainText('Respuesta interrumpida.');
  await expect(page.locator('#cards')).not.toContainText('Resultado local confirmado.');
  expect(await page.evaluate(() => (globalThis as any).activityCalls.filter((call: any) => call.action === 'end'))).toHaveLength(1);
});

test('an unavailable system never starts a guessed activity', async ({ page }) => {
  await nativeActivity(page, { unavailable: true });
  await openSettings(page); await page.getByLabel('Mostrar progreso en pantalla bloqueada').check();
  await expect(page.locator(status)).toContainText('no están disponibles');
  await submit(page); await expect(page.locator('#cards')).toContainText('Resultado local confirmado.');
  const calls = await page.evaluate(() => (globalThis as any).activityCalls);
  expect(calls.map((call: any) => call.action)).toEqual(['available']);
});

test('browser preview cannot enable the native surface', async ({ page }) => {
  await page.goto('/'); await openSettings(page);
  await expect(page.locator(toggle)).toBeDisabled();
  await expect(page.locator(status)).toContainText('app instalada en el iPhone');
  await expect(page.locator(toggle)).not.toBeChecked();
});

test('laptop activity starts only on a human tap and retains the authenticated observation time', async ({page})=>{
  let emit:(value:object)=>void=()=>{},disconnect:()=>void=()=>{};let lastObserved=0;
  await page.routeWebSocket('wss://activity.example/ws',ws=>{let seq=0;emit=value=>ws.send(JSON.stringify({seq:seq++,...value}));disconnect=()=>ws.close();ws.onMessage(raw=>{const value=JSON.parse(String(raw));if(value.type==='hello')emit({type:'ready',agentState:'idle',conversationId:'main'});if(value.type==='get_history')emit({type:'history',conversationId:'main',messages:[]});});});
  await nativeActivity(page);
  await page.locator('[data-panel="settings"]').click();if(!await page.locator('#url').isVisible())await page.getByText('Conexión manual',{exact:true}).click();
  await page.locator('#url').fill('wss://activity.example/ws');await page.locator('#token').fill('t'.repeat(48));await page.locator('#connection button[type="submit"]').click();await expect(page.locator('#status')).toContainText('Vinculado');
  await openSettings(page);await page.getByLabel('Mostrar progreso en pantalla bloqueada').check();
  const button=page.getByRole('button',{name:'Mostrar estado de la laptop'}), info=page.locator('#laptop-live-activity [role="status"]');
  await expect(button).toBeDisabled();
  lastObserved=Date.now();emit({type:'agent_state',state:'working'});await expect(button).toBeEnabled();
  expect((await page.evaluate(()=>(globalThis as any).activityCalls)).some((item:any)=>item.action==='start')).toBe(false);
  await button.click();await expect.poll(()=>page.evaluate(()=>(globalThis as any).activityCalls.filter((item:any)=>item.action==='start').length)).toBe(1);
  const start=await page.evaluate(()=>(globalThis as any).activityCalls.find((item:any)=>item.action==='start').request);
  expect(start.origin).toBe('laptop');expect(start.phase).toBe('working');expect(start.observedAt).toBeGreaterThanOrEqual(lastObserved);expect(Object.keys(start).sort()).toEqual(['observedAt','origin','phase','sequence','turnId']);
  await expect(info).toContainText('Última observación');
  disconnect();await expect(info).toContainText('Sin señal');
  await expect.poll(()=>page.evaluate(()=>(globalThis as any).activityCalls.filter((item:any)=>item.action==='start').length)).toBe(1);
  expect((await page.evaluate(()=>(globalThis as any).activityCalls)).some((item:any)=>item.action==='end')).toBe(false);
  await expect(page.locator('#status')).toContainText('Vinculado');emit({type:'agent_state',state:'needs_you'});
  await expect(info).toContainText('seguimiento se interrumpió');
  const after=await page.evaluate(()=>({calls:(globalThis as any).activityCalls,activity:(globalThis as any).currentActivity}));
  expect(after.calls.filter((item:any)=>item.action==='start')).toHaveLength(1);expect(after.calls.filter((item:any)=>item.action==='update')).toHaveLength(0);
  expect(after.activity).toMatchObject({origin:'laptop',phase:'working',observedAt:start.observedAt});
  await page.getByRole('button',{name:'Ocultar estado de la laptop'}).click();
  await expect.poll(()=>page.evaluate(()=>(globalThis as any).activityCalls.filter((item:any)=>item.action==='end').length)).toBe(1);
  expect(await page.evaluate(()=>(globalThis as any).cancelCalls)).toBe(0);
});

test('backgrounding freezes the last laptop observation until the user chooses again', async ({page})=>{
  let emit:(value:object)=>void=()=>{};
  await page.routeWebSocket('wss://activity.example/ws',ws=>{let seq=0;emit=value=>ws.send(JSON.stringify({seq:seq++,...value}));ws.onMessage(raw=>{const value=JSON.parse(String(raw));if(value.type==='hello')emit({type:'ready',agentState:'idle',conversationId:'main'});if(value.type==='get_history')emit({type:'history',conversationId:'main',messages:[]});});});
  await nativeActivity(page);
  await page.locator('[data-panel="settings"]').click();if(!await page.locator('#url').isVisible())await page.getByText('Conexión manual',{exact:true}).click();
  await page.locator('#url').fill('wss://activity.example/ws');await page.locator('#token').fill('t'.repeat(48));await page.locator('#connection button[type="submit"]').click();await expect(page.locator('#status')).toContainText('Vinculado');
  await openSettings(page);await page.getByLabel('Mostrar progreso en pantalla bloqueada').check();
  emit({type:'agent_state',state:'working'});const button=page.getByRole('button',{name:'Mostrar estado de la laptop'});await expect(button).toBeEnabled();await button.click();
  await expect.poll(()=>page.evaluate(()=>(globalThis as any).activityCalls.filter((item:any)=>item.action==='start').length)).toBe(1);
  const before=await page.evaluate(()=>(globalThis as any).currentActivity);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  await expect(page.locator('#laptop-live-activity [role="status"]')).toContainText('Sin señal');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'));});
  await expect(page.locator('#status')).toContainText('Vinculado');emit({type:'agent_state',state:'needs_you'});
  await expect(page.locator('#laptop-live-activity [role="status"]')).toContainText('seguimiento se interrumpió');
  const after=await page.evaluate(()=>({calls:(globalThis as any).activityCalls,activity:(globalThis as any).currentActivity}));
  expect(after.activity).toEqual(before);expect(after.calls.filter((item:any)=>item.action==='start')).toHaveLength(1);expect(after.calls.filter((item:any)=>item.action==='update'||item.action==='end')).toHaveLength(0);
});
