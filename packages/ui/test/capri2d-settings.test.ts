import { createElement } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const native=vi.hoisted(()=>({invoke:vi.fn(),listen:vi.fn().mockResolvedValue(()=>{})}));
vi.mock('@tauri-apps/api/core',()=>({invoke:native.invoke,isTauri:()=>true}));
vi.mock('@tauri-apps/api/event',()=>({listen:native.listen}));
import { useDesktopCompanion } from '../src/useDesktopCompanion.ts';
import { DesktopCompanionSettings } from '../src/components/DesktopCompanionSettings.tsx';
import { DEFAULT_DESKTOP_COMPANION } from '../src/desktop-companion.ts';
afterEach(()=>vi.clearAllMocks());
it('the actual selector forwards controls.change renderMode through desktop_companion_set and restores its acknowledged mode',async()=>{
 let saved={...DEFAULT_DESKTOP_COMPANION,available:true,enabled:true,visible:true,renderMode:'3d'};
 native.invoke.mockImplementation(async(name:string,args?:{patch?:{renderMode?:string}})=>{
  if(name==='desktop_companion_set')saved={...saved,...args?.patch};
  return saved;
 });
 function Settings(){return createElement(DesktopCompanionSettings,{controls:useDesktopCompanion(true)});}
 const view=render(createElement(Settings));await act(async()=>{});
 expect(screen.getByRole('combobox',{name:'Vista de Capri'})).toHaveValue('3d');
 await act(async()=>{fireEvent.change(screen.getByRole('combobox',{name:'Vista de Capri'}),{target:{value:'2d'}});});
 expect(native.invoke).toHaveBeenCalledWith('desktop_companion_set',{patch:{renderMode:'2d'}});
 expect(saved.renderMode).toBe('2d');view.unmount();
 render(createElement(Settings));await act(async()=>{});
 expect(screen.getByRole('combobox',{name:'Vista de Capri'})).toHaveValue('2d');
});
