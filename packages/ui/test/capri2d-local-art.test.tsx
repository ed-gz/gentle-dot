import {act,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {CapriIntro} from '../src/capri2d/CapriIntro.tsx';
const native=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke:native}));
vi.mock('../src/components/CapriCompanion.tsx',()=>({CapriSprite:()=>null}));
beforeEach(()=>{
 vi.useFakeTimers();native.mockImplementation((_command,{name})=>Promise.resolve([...new TextEncoder().encode(name)]));
 vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();delete window.__CAPRI_INTRO__;});
it('loads local intro drawings per beat and never a legacy atlas',async()=>{
 window.__CAPRI_INTRO__={ready:true,started:performance.now(),target:{x:0,y:0,width:144,height:204}};
 const view=render(<CapriIntro/>);await act(async()=>{});
 let elapsed=0;
 for(const [time,name] of [[1100,'intro-grab.webp'],[1800,'intro-smear.webp'],[2150,'intro-happy.webp'],[2600,'face-calm.png'],[2800,'intro-mouth1.webp'],[3100,'intro-mouth2.webp'],[3400,'intro-mouth3.webp'],[3600,'intro-wave1.webp'],[3900,'intro-wave2.webp'],[4200,'intro-wave3.webp'],[4400,'intro-grab.webp'],[4800,'intro-happy.webp'],[6200,'intro-smear.webp']] as const){
  await act(async()=>{vi.advanceTimersByTime(time-elapsed);});elapsed=time;
  const scene=name.startsWith('intro-');
  const img=view.container.querySelector(scene?'img.capri-intro-scene':'.capri-intro-head img');
  expect(img).not.toBeNull();
  expect(img).toHaveAttribute('src',`data:image/${name.endsWith('webp')?'webp':'png'};base64,${btoa(name)}`);
  expect(view.container.querySelectorAll('.capri-intro-scene')).toHaveLength(scene?1:0);
 }
 expect(view.container.querySelector('svg image')).toBeNull();view.unmount();
});
it('falls back to local calm/smug art for missing blink/hi drawings, never the atlas',async()=>{
 native.mockImplementation((_command,{name})=>name.startsWith('intro-mouth')?Promise.reject(new Error('missing')):Promise.resolve([...new TextEncoder().encode(name)]));
 window.__CAPRI_INTRO__={ready:true,started:performance.now(),target:{x:0,y:0,width:144,height:204}};
 const view=render(<CapriIntro/>);await act(async()=>{});
 await act(async()=>{vi.advanceTimersByTime(2850);});
 expect(view.container.querySelector('.capri-intro-head img')).toHaveAttribute('src',`data:image/png;base64,${btoa('face-smug.png')}`);
 view.unmount();
});
it('has no capri-faces imports in any capri2d source file',()=>{
 const root=`${process.cwd()}/packages/ui/src/capri2d/`;
 for(const file of readdirSync(root).filter(name=>/\.(ts|tsx)$/.test(name)))expect(readFileSync(root+file,'utf8')).not.toMatch(/(?:from\s*|import\s*)['"][^'"]*capri-faces/);
});
it('grants only local 2D art to the intro without widening dot motion grants',()=>{
 const config=JSON.parse(readFileSync(`${process.cwd()}/apps/desktop/src-tauri/capabilities/default.json`,'utf8'));
 const grants=config.capabilities.filter((entry:{windows:string[]})=>entry.windows.includes('capri-intro'));
 expect(grants).toHaveLength(1);expect(grants[0].windows).toEqual(['capri-intro']);expect(grants[0].permissions).toEqual(['allow-capri2d-asset']);
});
