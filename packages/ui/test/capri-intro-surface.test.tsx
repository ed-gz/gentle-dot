import { StrictMode } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { CapriIntro } from '../src/capri2d/CapriIntro.tsx';
import { useIntro } from '../src/capri2d/useIntro.ts';
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,invoke:vi.fn()}));
vi.mock('../src/components/CapriCompanion.tsx',()=>({CapriSprite:()=> <span data-testid="body"/>}));
vi.mock('../src/capri-faces/CapriFaceSprite.tsx',()=>({CapriFaceSprite:({action}:{action:string})=> <span data-testid="head" data-action={action}/>}));
const native=vi.mocked(invoke);
beforeEach(()=>{
 vi.useFakeTimers();
 native.mockReset();native.mockImplementation(((command:string,args?:unknown)=> command==='capri2d_asset'&&!!args&&typeof (args as {name?:string}).name==='string' ? Promise.resolve([...new TextEncoder().encode((args as {name:string}).name)]) : Promise.resolve({introActive:true})) as typeof native);
 vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();delete window.__CAPRI_INTRO__;delete document.documentElement.dataset.capriIntro;});

describe('temporary intro surface',()=>{
 it('stays empty until native placement is verified and never creates input controls',()=>{
  window.__CAPRI_INTRO__={ready:false,target:{x:900,y:500,width:144,height:204}};
  const {container}=render(<CapriIntro/>);
  expect(container).toBeEmptyDOMElement();
  act(()=>{window.__CAPRI_INTRO__!.ready=true;window.__CAPRI_INTRO__!.started=performance.now();window.dispatchEvent(new Event('capri-intro-ready'));});
  act(()=>vi.advanceTimersByTime(50));
  expect(container.querySelector('[data-beat="crackle"]')).not.toBeNull();
  expect(container.querySelector('button,a,input')).toBeNull();
 });
 it('types her name, waves, shows full-screen scenes and unfolds at the supplied laptop-local spot',async()=>{
  window.__CAPRI_INTRO__={ready:true,started:performance.now(),target:{x:900,y:500,width:144,height:204}};
  const {container}=render(<CapriIntro/>);
  await act(async()=>{vi.advanceTimersByTime(3300);});expect(container.querySelector('.capri-intro-tag span')).toHaveTextContent('CAPRI');
  await act(async()=>{vi.advanceTimersByTime(450);});expect(container.querySelector('[data-beat="wave"]')).not.toBeNull();
  await act(async()=>{vi.advanceTimersByTime(1500);});expect(container.querySelector('img.capri-intro-scene')).not.toBeNull();expect(container.querySelectorAll('.capri-intro-shard')).toHaveLength(0);
  await act(async()=>{vi.advanceTimersByTime(2100);});expect(container.querySelector('.capri-intro-unfold')).toBeNull();
  await act(async()=>{vi.advanceTimersByTime(800);});expect(container).toBeEmptyDOMElement();
 });
 it('reduced motion and document occlusion never leave a flashing surface',()=>{
  vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  window.__CAPRI_INTRO__={ready:true,started:performance.now(),target:{x:0,y:0,width:144,height:204}};
  const {container}=render(<CapriIntro/>);
  act(()=>vi.advanceTimersByTime(100));expect(container).toBeEmptyDOMElement();
 });
});
describe('dot-owned intro heartbeat',()=>{
 it('does not consume the latch during the StrictMode mount probe',async()=>{
  renderHook(()=>useIntro(true,true,false,false),{wrapper:({children})=><StrictMode>{children}</StrictMode>});
  expect(native).not.toHaveBeenCalled();
  await act(async()=>{vi.advanceTimersByTime(0);});
  expect(native).toHaveBeenCalledTimes(1);
  expect(native).toHaveBeenLastCalledWith('desktop_companion_interaction',{active:false,intro:{connected:true,blocked:false,reduced:false,skip:false}});
 });
 it('sends guards, skips without opening chat, and aborts on disconnect',async()=>{
  const {result,rerender}=renderHook(({connected,blocked,reduced})=>useIntro(true,connected,blocked,reduced),{initialProps:{connected:true,blocked:false,reduced:false}});
  await act(async()=>{vi.advanceTimersByTime(0);});expect(result.current).toBe(true);
  expect(native).toHaveBeenCalledWith('desktop_companion_interaction',{active:false,intro:{connected:true,blocked:false,reduced:false,skip:false}});
  const click=vi.fn();window.addEventListener('click',click);
  native.mockResolvedValue({introActive:false});
  fireEvent.pointerDown(window);fireEvent.click(window);await act(async()=>{});
  expect(click).not.toHaveBeenCalled();expect(result.current).toBe(false);
  rerender({connected:false,blocked:true,reduced:false});await act(async()=>{});
  expect(native).toHaveBeenLastCalledWith('desktop_companion_interaction',{active:false,intro:{connected:false,blocked:true,reduced:true,skip:true}});
  window.removeEventListener('click',click);
 });
 it('does nothing while disabled and stops all heartbeats after the bounded startup interval',async()=>{
  const {rerender,unmount}=renderHook(({enabled})=>useIntro(enabled,true,false,false),{initialProps:{enabled:false}});
  expect(native).not.toHaveBeenCalled();rerender({enabled:true});await act(async()=>{vi.advanceTimersByTime(0);});
  for(let i=0;i<44;i++)await act(async()=>{vi.advanceTimersByTime(250);});
  const calls=native.mock.calls.length;
  await act(async()=>{vi.advanceTimersByTime(5000);});expect(native).toHaveBeenCalledTimes(calls);
  unmount();
 });
});
