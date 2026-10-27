import {act,render,renderHook} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import {CapriIntro} from '../src/capri2d/CapriIntro.tsx';
import {usePossession} from '../src/capri2d/usePossession.ts';
import type {RoamFeed} from '../src/capri2d/roam.ts';
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,invoke:vi.fn()}));
const native=vi.mocked(invoke);
beforeEach(()=>{vi.useFakeTimers();vi.spyOn(Math,'random').mockReturnValue(0);native.mockReset();native.mockResolvedValue({possessionActive:true});vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()}));});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();delete window.__CAPRI_INTRO__;});
it('reuses the verified transparent intro slot for a bounded cracked border and face, never buttons',()=>{
 window.__CAPRI_INTRO__={ready:false,possession:true,target:{x:0,y:0,width:1000,height:700}};
 const {container}=render(<CapriIntro/>);expect(container).toBeEmptyDOMElement();
 act(()=>{window.__CAPRI_INTRO__!.ready=true;window.__CAPRI_INTRO__!.started=performance.now();window.dispatchEvent(new Event('capri-intro-ready'));});
 expect(container.querySelector('[data-capri-possession]')).not.toBeNull();
 expect(container.querySelector('polygon')).toHaveAttribute('stroke','#ff65ad');
 expect(container.querySelectorAll('ellipse')).toHaveLength(2);
 expect(container.querySelector('button,input,a')).toBeNull();
 act(()=>vi.advanceTimersByTime(6200));expect(container).toBeEmptyDOMElement();
});
it('has no possession flash in reduced motion',()=>{
 vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
 window.__CAPRI_INTRO__={ready:true,possession:true,started:performance.now(),target:{x:0,y:0,width:1000,height:700}};
 expect(render(<CapriIntro/>).container).toBeEmptyDOMElement();
});
it('feeds native only a start intent, reverts on question, and closes on unmount',async()=>{
 const source:{current:{feed?:RoamFeed;received:number}}={current:{feed:{laptop:{x:0,y:0,width:1536,height:864},region:{x:20,y:40,width:1300,height:760},herdr:true,x:1100,y:40,width:144,height:204},received:Date.now()}};
 const {result,rerender,unmount}=renderHook(({question})=>usePossession(true,true,{perched:true,question},source),{initialProps:{question:false}});
 await act(async()=>{});
 await act(async()=>{vi.advanceTimersByTime(250);});expect(result.current).toBe(true);
 expect(native).toHaveBeenLastCalledWith('desktop_companion_interaction',{active:false,possession:{start:true,connected:true,blocked:false,reduced:false}});
 rerender({question:true});await act(async()=>{vi.advanceTimersByTime(250);});expect(result.current).toBe(false);
 unmount();expect(native).toHaveBeenLastCalledWith('desktop_companion_interaction',{active:false,possession:{start:false,connected:false,blocked:true,reduced:true}});
});
