import { test, expect, type Page } from './fixtures.ts';
async function linkedPhone(page: Page) {
  await page.addInitScript(() => {
    const state = globalThis as any; state.isTauri = true; state.sessionCalls = [];
    const sessions = ['Operaciones', 'Capri iOS'].map((label, i) => ({ paneId: `pane-${i}`, sessionId: `session-${i}`, provider: 'herdr', label, cwd: '/workspace/capri', state: i ? 'working' : 'idle', connected: true, managed: true, capabilities: { inspect: true, prompt: true, abort: true, deliveryReceipts: true, deliveryModes: ['steer', 'followUp'], attachments: { version: 1, files: true, images: true, audio: 'file' } } }));
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (command.endsWith('results_list')) return { ok: true, items: [] };
      if (command.startsWith('plugin:device-bridge|')) args = args?.request;
      state.sessionCalls.push({ command, ...(command.endsWith('https_request') ? { body: args.body } : {}) });
      // Simulate a persistent Keychain item; success without storing the
      // pending selection would make the app correctly reject confirmation.
      if (command.endsWith('secret_get')) {
        const value = sessionStorage.getItem(`fixture-keychain:${args.scope}:${args.account}`);
        return value === null ? { ok: true } : { ok: true, value };
      }
      if (command.endsWith('secret_set')) {
        sessionStorage.setItem(`fixture-keychain:${args.scope}:${args.account}`, args.value); return { ok: true };
      }
      if (command.endsWith('check_availability')) return { available: false, status: 'model_not_ready', supportsSpanish: false };
      if (command.endsWith('share_list') || command.endsWith('documents_list')) return { ok: true, items: [] };
      if (command.endsWith('check_voice')) return { available: !state.voiceNeedsAssets, status: state.voiceNeedsAssets ? 'assets_required' : 'available', assetsInstalled: !state.voiceNeedsAssets, microphonePermission: 'granted', recording: false };
      if (command.endsWith('prepare_voice')) { state.voiceNeedsAssets = false; return { ok: true, available: true, status: 'available', assetsInstalled: true, microphonePermission: 'granted' }; }
      if (command.endsWith('start_voice')) return { ok: true, sessionId: '12345678-1234-1234-1234-123456789012', maxDurationSeconds: 90 };
      if (command.endsWith('stop_voice') && state.holdTranscript) await new Promise(resolve => state.finishTranscript = resolve);
      if (command.endsWith('stop_voice')) return { ok: true, sessionId: args.sessionId, source: 'apple-speech-analyzer', locale: 'es-MX', durationSeconds: 2, text: 'Revisa la evidencia.', segments: [{ text: 'Revisa la evidencia.', startSeconds: 0, endSeconds: 2 }] };
      if (command.endsWith('crypto_hash_begin')) { state.hashBytes = []; return { ok: true, id: '11111111-1111-4111-8111-111111111111' }; }
      if (command.endsWith('crypto_hash_update')) { state.hashBytes.push(...Uint8Array.from(atob(args.data), c => c.charCodeAt(0))); return { ok: true }; }
      if (command.endsWith('crypto_hash_finish')) return { ok: true, hex: [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(state.hashBytes)))].map(n => n.toString(16).padStart(2, '0')).join('') };
      if (command.endsWith('session_upload_begin')) {
        state.uploadTarget = { paneId: args.paneId, sessionId: args.sessionId, name: args.name, size: args.size }; state.uploadBytes = [];
        return { ok: true, id: '22222222-2222-4222-8222-222222222222' };
      }
      if (command.endsWith('session_upload_write')) { state.uploadBytes.push(...Uint8Array.from(atob(args.data), c => c.charCodeAt(0))); return { ok: true, written: state.uploadBytes.length }; }
      if (command.endsWith('session_upload_send')) {
        const target = state.uploadTarget; state.uploadSending = true;
        if (state.holdUpload) await new Promise(resolve => state.finishUpload = resolve);
        return { ok: true, status: 200, body: JSON.stringify({ uploadId: 'u_abcdefghijklmnopqrstuv', name: target.name, size: target.size, mime: 'application/octet-stream', path: `uploads/u_abcdefghijklmnopqrstuv/${target.name}` }) };
      }
      if (command.endsWith('https_request')) {
        const body = args.body ? JSON.parse(args.body) : undefined;
        const reply = !body ? { available: true, sessions, approvals: [], policies: [], events: [] } : body.action === 'inspect' ? {
          sessionId: body.sessionId, instanceId: 'instance-1', status: 'idle', deliveries: [],
          messages: [{ id: body.before ? 'older' : 'new', role: 'assistant', content: [{ type: 'text', text: body.before ? 'Acuerdo anterior verificable.' : `Historial de ${body.sessionId}.` }], timestamp: '2026-10-28T12:00:00Z' }],
          history: { hasEarlier: !body.before, ...(body.before ? {} : { before: 'older-cursor' }) },
          metadata: { version: 1, model: { id: 'configured', name: 'Modelo configurado', provider: 'host' } },
          work: { version: 1, commands: [], agents: [], truncated: false },
        } : { ok: true };
        return { ok: true, status: 200, headers: {}, body: JSON.stringify(reply) };
      }
      return { ok: true };
    } };
  });
  await page.routeWebSocket('wss://sessions.fixture.example/ws', ws => {
    let seq = 0;
    ws.onMessage(raw => { const m = JSON.parse(String(raw));
      if (m.type === 'hello') ws.send(JSON.stringify({ type: 'ready', seq: ++seq, agentState: 'idle', conversationId: 'main' }));
      if (m.type === 'get_history') ws.send(JSON.stringify({ type: 'history', seq: ++seq, conversationId: 'main', messages: Array.from({ length: 100 }, (_, i) => ({ id: `main-${i}`, role: i % 2 ? 'assistant' : 'user', text: `Turno ${i}`, activities: [] })) }));
    });
  });
  await connectPhone(page);
}

async function connectPhone(page: Page) {
  await page.goto('/'); await page.locator('[data-panel="settings"]').click();
  await page.getByText('Conexión manual', { exact: true }).click();
  await page.locator('#url').fill('wss://sessions.fixture.example/ws'); await page.locator('#token').fill('fixture-only');
  await page.locator('#connection button[type="submit"]').click();
  await expect(page.locator('#status')).toContainText('Acceso guardado en Keychain');
}

test('the session composer is one readable surface with accessible actions', async ({ page }) => {
  test.slow(); await linkedPhone(page);
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Operaciones' }).click();
  const prompt = page.getByRole('textbox', { name: 'Continuar esta sesión' });
  await expect(prompt).toBeEnabled();
  for (const size of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    for (const scale of ['100%', '200%']) {
      await page.evaluate(value => { document.documentElement.style.fontSize = value; }, scale);
      await prompt.focus(); await expect(prompt).toBeFocused();
      const metrics = await page.locator('#panel-agents .agent-reply .composer').evaluate(form => {
        const input = form.querySelector('textarea')!, css = getComputedStyle(input), box = input.getBoundingClientRect();
        const controls = [...form.querySelectorAll<HTMLElement>('.composer-attach, button')].filter(el => el.getClientRects().length).map(el => el.getBoundingClientRect());
        const overlaps = controls.some(r => r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top);
        return { border: css.borderTopWidth, background: css.backgroundColor, textWidth: box.width,
          controls: controls.map(r => ({ width: r.width, height: r.height })), overlaps, bounds: form.getBoundingClientRect().toJSON(), viewport: { width: innerWidth, height: innerHeight } };
      });
      expect(metrics.border).toBe('0px'); expect(metrics.background).toBe('rgba(0, 0, 0, 0)');
      expect(metrics.textWidth).toBeGreaterThan(40); expect(metrics.overlaps).toBe(false);
      expect(metrics.controls.every(r => r.width >= 44 && r.height >= 44)).toBe(true);
      expect(metrics.bounds.left).toBeGreaterThanOrEqual(0); expect(metrics.bounds.right).toBeLessThanOrEqual(metrics.viewport.width);
      expect(metrics.bounds.bottom).toBeLessThanOrEqual(metrics.viewport.height + 1);
    }
  }
});

test('Capri restores the conversation reaction after leaving a working session', async ({ page }) => {
  test.slow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await linkedPhone(page);
  const artwork = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 420;
    canvas.getContext('2d')!.fillRect(60, 10, 120, 380);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  await page.locator('#art').setInputFiles({ name: 'synthetic-capri.png', mimeType: 'image/png', buffer: Buffer.from(artwork, 'base64') });
  const rig = page.locator('#rig-handle');
  await expect(rig).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  await page.locator('[data-panel="agents"]').click();
  await page.locator('.agent-session').filter({ hasText: 'Capri iOS' }).click();
  await expect(rig).toHaveAttribute('data-pose', 'look', { timeout: 15000 });
  const box = (await rig.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 - 15, box.y + box.height / 2, { steps: 3 });
  await expect(rig).toHaveAttribute('data-pose', 'flinch');
  await page.mouse.up();
  await expect(rig).toHaveAttribute('data-pose', 'look');
  await page.locator('[data-panel="settings"]').click();
  await expect(rig).toBeVisible();
  await expect(rig).not.toHaveAttribute('data-pose', 'look', { timeout: 15000 });
  await page.locator('[data-panel="agents"]').click();
  await expect(rig).toHaveAttribute('data-pose', 'look', { timeout: 15000 });
  await page.locator('[data-panel="chat"]').click();
  await expect(rig).toBeVisible();
  await expect(rig).not.toHaveAttribute('data-pose', 'look', { timeout: 15000 });
});


test('Capri keeps session and conversation text accessible across scrolling', async ({ page }) => {
  test.slow(); await page.emulateMedia({ reducedMotion: 'reduce' }); await linkedPhone(page);
  await page.locator('[data-panel="settings"]').click();
  const artwork = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 420;
    const context = canvas.getContext('2d')!; context.fillStyle = '#ff408e'; context.fillRect(60, 10, 120, 170);
    context.fillStyle = '#baff67'; context.fillRect(85, 180, 70, 220);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  await page.locator('#art').setInputFiles({ name: 'synthetic-capri.png', mimeType: 'image/png', buffer: Buffer.from(artwork, 'base64') });
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready', 'true', { timeout: 30000 });
  for (const viewport of [{width:390,height:844},{width:320,height:568},{width:844,height:390}]) {
    await page.setViewportSize(viewport);
    await page.locator('[data-panel="chat"]').click();
    await page.locator('[data-panel="agents"]').click();
    await expect(page.locator('.agent-session')).toHaveCount(2);
    const results = [];
    for (let i=0; i<20; i++) {
      if (i===10) await page.locator('#panel-agents').evaluate(el => { el.scrollTop = 180; });
      results.push(await page.evaluate(() => {
        const rig = document.querySelector<HTMLElement>('#rig-handle')!.getBoundingClientRect();
        const walker = document.createTreeWalker(document.querySelector('#panel-agents')!, NodeFilter.SHOW_TEXT);
        const overlaps: any[]=[]; const counts: any[]=[];
        while(walker.nextNode()) {
          const node=walker.currentNode, text=node.textContent?.trim(); if (!text || node.parentElement?.closest('[hidden]')) continue;
          const range=document.createRange(); range.selectNodeContents(node);
          for(const r of range.getClientRects()) {
            if (text.includes('sesion') || text.includes('sesión')) counts.push({text,x:r.x,y:r.y,w:r.width,h:r.height});
            if(r.width && r.height && r.left<rig.right && r.right>rig.left && r.top<rig.bottom && r.bottom>rig.top) overlaps.push({text,x:r.x,y:r.y,w:r.width,h:r.height});
          }
        }
        return {rig:{x:rig.x,y:rig.y,w:rig.width,h:rig.height}, docked:document.querySelector('#rig-handle')!.classList.contains('docked'), overlaps, counts};
      })); await page.waitForTimeout(100);
    }
    await test.info().attach(`geometry-${viewport.width}x${viewport.height}`, { body: JSON.stringify({ first: results[0], afterScroll: results[10] }), contentType: 'application/json' });
    expect(results.flatMap(r=>r.overlaps)).toEqual([]);
    if (viewport.width === 844) {
      await page.locator('#panel-agents').evaluate(el => { el.scrollTop = 0; }); await page.waitForTimeout(250);
      const rig = page.locator('#rig-handle');
      const start = await rig.boundingBox();
      await page.evaluate(() => {
        const root=document.querySelector<HTMLElement>('#laptop-root')!; const rig=document.querySelector<HTMLElement>('#rig-handle')!.getBoundingClientRect();
        const bounds=root.getBoundingClientRect(); root.style.position='relative'; root.style.minHeight='1200px';
        const marker=document.createElement('p'); marker.id='scroll-text-fixture'; marker.textContent='Contenido que debe permanecer legible';
        Object.assign(marker.style,{position:'absolute',margin:'0',left:`${rig.left-bounds.left}px`,top:`${rig.bottom+7-bounds.top}px`,width:'200px'});
        root.append(marker);
      });
      await page.waitForTimeout(250);
      const before=await rig.boundingBox();
      const textBefore=await page.locator('#scroll-text-fixture').boundingBox();
      expect(textBefore!.y).toBeGreaterThanOrEqual(before!.y+before!.height);
      await page.locator('#panel-agents').evaluate(el => { el.scrollTop=35; }); await page.waitForTimeout(250);
      const after=await rig.boundingBox(); const textAfter=await page.locator('#scroll-text-fixture').boundingBox();
      await test.info().attach('scroll-relocation', {body:JSON.stringify({start,before,after,textBefore,textAfter}),contentType:'application/json'});
      expect(textAfter!.y).toBeLessThan(textBefore!.y-20);
      const actualLines = await page.locator('#scroll-text-fixture').evaluate(el => {
        const range = document.createRange(); range.selectNodeContents(el);
        return [...range.getClientRects()].map(r => ({x:r.x,y:r.y,width:r.width,height:r.height}));
      });
      expect(actualLines.every(r => after!.x+after!.width <= r.x || after!.x >= r.x+r.width || after!.y+after!.height <= r.y || after!.y >= r.y+r.height)).toBe(true);
    }
  }
  for (const viewport of [{width:390,height:844},{width:320,height:568},{width:844,height:390}]) {
    await page.setViewportSize(viewport); await page.locator('[data-panel="chat"]').click();
    await expect(page.locator('.chat-card')).toHaveCount(100);
    await page.waitForTimeout(300);
    for (const position of ['top', 'bottom']) {
      await page.locator('#conversation-scroll').evaluate((el, position) => { el.scrollTop = position === 'top' ? 0 : el.scrollHeight; }, position);
      await page.waitForTimeout(250);
      const covered = await page.evaluate(() => {
        const rig = document.querySelector<HTMLElement>('#rig-handle')!; const rr=rig.getBoundingClientRect();
        const output: string[]=[];
        const overlap = (rect: DOMRect) => {
          const x=Math.max(rect.left,rr.left), y=Math.max(rect.top,rr.top), right=Math.min(rect.right,rr.right), bottom=Math.min(rect.bottom,rr.bottom);
          if(right<=x || bottom<=y || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return false;
          return Boolean(document.elementFromPoint((x+right)/2,(y+bottom)/2)?.closest('#rig-handle'));
        };
        const panel=document.querySelector('#panel-chat')!;
        const walker=document.createTreeWalker(panel,NodeFilter.SHOW_TEXT);
        while(walker.nextNode()) {
          const node=walker.currentNode, text=node.textContent?.trim(); if(!text || node.parentElement?.closest('[hidden]')) continue;
          const range=document.createRange(); range.selectNodeContents(node);
          if([...range.getClientRects()].some(overlap)) output.push(`text: ${text}`);
        }
        for(const element of panel.querySelectorAll('button,input,textarea,select,summary')) {
          if(element.closest('[hidden]')) continue;
          if([...element.getClientRects()].some(overlap)) output.push(`control: ${element.id || element.getAttribute('aria-label') || element.textContent?.trim()}`);
        }
        return output;
      });
      expect(covered, `${viewport.width}x${viewport.height} ${position}`).toEqual([]);
    }
  }

});

for (const motion of ['reduce','no-preference'] as const) test(`keyboard resize keeps Capri away from settings and session inputs (${motion})`, async ({ page }) => {
  await page.setViewportSize({ width: 568, height: 320 }); await page.emulateMedia({ reducedMotion: motion }); await linkedPhone(page);
  await page.locator('[data-panel="settings"]').click();
  const artwork = await page.evaluate(() => { const c=document.createElement('canvas');c.width=240;c.height=420;c.getContext('2d')!.fillRect(0,0,240,420);return c.toDataURL().split(',')[1]!; });
  await page.locator('#art').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:Buffer.from(artwork,'base64')});
  await expect(page.locator('#rig-handle')).toHaveAttribute('data-ready','true',{timeout:20000}); await page.evaluate(()=>document.documentElement.style.fontSize='200%');
  for (const panel of ['settings','agents'] as const) {
    if(panel==='agents'){await page.locator('[data-panel="agents"]').click();await page.locator('.agent-session').filter({hasText:'Operaciones'}).click();}
    else {const detail=page.locator('.settings-manual');if(!await detail.evaluate(el=>(el as HTMLDetailsElement).open))await detail.locator('summary').click();}
    const input=panel==='settings'?page.locator('#url'):page.getByRole('textbox',{name:'Continuar esta sesión'});await expect(input).toBeEnabled();await input.focus();await expect(input).toBeFocused();
    const values=await page.evaluate(async height=>{const v=window.visualViewport!;Object.defineProperties(v,{height:{configurable:true,value:height},pageTop:{configurable:true,value:0},scale:{configurable:true,value:1}});v.dispatchEvent(new Event('resize'));
      const take=()=>{const rig=document.querySelector<HTMLElement>('#rig-handle')!,a=rig.getBoundingClientRect(),b=document.activeElement!.getBoundingClientRect();return {overlap:a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom,visible:rig.offsetWidth>0&&getComputedStyle(rig).visibility==='visible'&&getComputedStyle(rig).opacity!=='0'};};const values=[take()];for(let i=0;i<20;i++){await new Promise<void>(r=>requestAnimationFrame(()=>r()));values.push(take());}return values;},180);
    expect(values.some(value=>value.overlap),panel).toBe(false);expect(values.every(value=>value.visible),panel).toBe(true);
    await input.blur();await page.evaluate(()=>{const v=window.visualViewport!;Object.defineProperty(v,'height',{configurable:true,value:window.innerHeight});v.dispatchEvent(new Event('resize'));});await expect(page.locator('#rig-handle')).toBeVisible();
  }
});
