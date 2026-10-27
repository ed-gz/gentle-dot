import { createElement } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), draw: vi.fn(), inputRectangles:vi.fn(), dispose: vi.fn(), fxBurst:vi.fn(),fxCue:vi.fn(),fxDraw:vi.fn(),fxClear:vi.fn() }));
vi.mock("../src/capri2d/fx.ts",()=>({RigFx:class{cutins={};burst=mocks.fxBurst;cue=mocks.fxCue;draw=mocks.fxDraw;clear=mocks.fxClear;}}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../src/capri2d/engine.ts", async original => ({
 ...await original<typeof import("../src/capri2d/engine.ts")>(),
 createEngine: () => ({ draw: mocks.draw, inputRectangles:mocks.inputRectangles, dispose: mocks.dispose }),
}));
import { Capri2D } from "../src/capri2d/Capri2D.tsx";
let nextFrame: FrameRequestCallback;
beforeEach(() => {
 vi.clearAllMocks();
 mocks.invoke.mockResolvedValue(new ArrayBuffer(4));
 mocks.draw.mockReturnValue(Array(816).fill(1));
 mocks.inputRectangles.mockReturnValue([[10,20,1,1]]);
 vi.stubGlobal("Image", class { naturalWidth=240; naturalHeight=420; src=""; decode=vi.fn().mockResolvedValue(undefined); });
 vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { nextFrame=callback; return 7; }));
 vi.stubGlobal("cancelAnimationFrame", vi.fn());
 vi.spyOn(document,"hidden","get").mockReturnValue(false);
 vi.spyOn(URL,"createObjectURL").mockReturnValue("blob:local");
 vi.spyOn(URL,"revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("loads local artwork and publishes/deduplicates its alpha; hides and disposes", async () => {
 const onActive=vi.fn(), onMask=vi.fn();
 const props={ enabled:true, visible:true, reduced:false, onActive, onMask };
 const view=render(createElement(Capri2D,props));
 await act(async () => {});
 expect(mocks.invoke).toHaveBeenCalledWith("capri2d_asset",{name:"capri-full.png"});
 for(const name of ['cutin-grin.png','cutin-laugh.png','cutin-eyes.png']) expect(mocks.invoke).toHaveBeenCalledWith('capri2d_asset',{name});
 expect(onActive).toHaveBeenCalledWith(true);
 expect(onMask).toHaveBeenCalledTimes(1);
 expect(onMask).toHaveBeenLastCalledWith(Array(816).fill(1),[[10,20,1,1]]);
 act(()=>nextFrame(2000));
 expect(onMask).toHaveBeenCalledTimes(1);
 view.rerender(createElement(Capri2D,{...props,visible:false}));
 const calls=mocks.draw.mock.calls.length;
 act(()=>nextFrame(2100));
 expect(mocks.draw).toHaveBeenCalledTimes(calls);
 view.unmount();
 expect(mocks.dispose).toHaveBeenCalledOnce();
 expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
 expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local");
 expect(onActive).toHaveBeenLastCalledWith(false);
});
it("keeps reduced motion static", async () => {
 const view=render(createElement(Capri2D,{enabled:true,visible:true,reduced:true,onActive:vi.fn(),onMask:vi.fn()}));
 await act(async()=>{});
 act(()=>nextFrame(3000)); act(()=>nextFrame(4000));
 expect(mocks.draw).toHaveBeenCalledOnce();
 expect(mocks.fxCue).not.toHaveBeenCalled();expect(mocks.fxDraw).not.toHaveBeenCalled();
 view.unmount();
});
it('dispatches crossed victory cues to the second canvas and consumes hidden episodes',async()=>{
 vi.spyOn(performance,'now').mockReturnValue(0);
 const props={enabled:true,visible:true,reduced:false,onActive:vi.fn(),onMask:vi.fn(),intent:{outcome:{kind:'done' as const,at:1}}};
 const view=render(createElement(Capri2D,props));await act(async()=>{});
 act(()=>nextFrame(300));
 expect(mocks.fxCue.mock.calls.map(call=>call[0])).toEqual(['gather','launch','peak']);
 view.rerender(createElement(Capri2D,{...props,visible:false}));
 act(()=>nextFrame(400));const cleared=mocks.fxClear.mock.calls.length;
 act(()=>nextFrame(500));expect(mocks.fxClear).toHaveBeenCalledTimes(cleared);
 mocks.fxCue.mockClear();view.rerender(createElement(Capri2D,props));act(()=>nextFrame(600));
 expect(mocks.fxCue).not.toHaveBeenCalled();view.unmount();
});
it('rebuilds GPU resources after context restoration without fetching the texture again',async()=>{
 const log=vi.spyOn(console,'warn').mockImplementation(()=>{});
 const props={enabled:true,visible:true,reduced:false,onActive:vi.fn(),onMask:vi.fn()};
 const view=render(createElement(Capri2D,props));await act(async()=>{});
 const canvas=view.container.querySelector('[data-capri2d]')!;
 act(()=>canvas.dispatchEvent(new Event('webglcontextlost',{cancelable:true})));
 expect(props.onActive).toHaveBeenLastCalledWith(false);
 act(()=>canvas.dispatchEvent(new Event('webglcontextrestored')));
 expect(props.onActive).toHaveBeenLastCalledWith(true);
 expect(props.onMask).toHaveBeenCalledTimes(2); // unchanged body must republish after input deactivation
 expect(mocks.invoke.mock.calls.filter(call=>call[1]?.name==='capri-full.png')).toHaveLength(1);
 view.unmount();expect(mocks.dispose).toHaveBeenCalledTimes(2);log.mockRestore();
});
it("missing local artwork falls back and logs once across remounts", async () => {
 mocks.invoke.mockRejectedValue(new Error("missing"));
 const log=vi.spyOn(console,"warn").mockImplementation(()=>{});
 const props={enabled:true,visible:true,reduced:false,onActive:vi.fn(),onMask:vi.fn()};
 const first=render(createElement(Capri2D,props)); await act(async()=>{}); first.unmount();
 const second=render(createElement(Capri2D,props)); await act(async()=>{}); second.unmount();
 expect(log).toHaveBeenCalledOnce(); expect(props.onActive).not.toHaveBeenCalledWith(true);
 expect(mocks.draw).not.toHaveBeenCalled();
});
it('uses the local many-eyes chip and keeps only the procedural sleep body',async()=>{
 const props={enabled:true,visible:true,reduced:false,onActive:vi.fn(),onMask:vi.fn()};
 const view=render(createElement(Capri2D,props));await act(async()=>{});
 expect(view.container.querySelector('[data-capri-biochip]')).toBeNull();
 view.rerender(createElement(Capri2D,{...props,possessing:true}));act(()=>nextFrame(200));
 expect(mocks.fxBurst).toHaveBeenLastCalledWith(200,false);
 expect(props.onMask).toHaveBeenLastCalledWith(Array(816).fill(1),[]);
 expect(view.container.querySelector('[data-capri-biochip]')).toHaveStyle({width:'36px',height:'36px'});
 await act(async()=>{});
 expect(mocks.invoke).toHaveBeenCalledWith('capri2d_asset',{name:'face-many.png'});
 expect(view.container.querySelector('[data-capri-biochip] img')).toHaveAttribute('src');
 expect(view.container.querySelector('[data-capri-biochip] svg')).toBeNull();
 view.rerender(createElement(Capri2D,props));act(()=>nextFrame(400));
 expect(mocks.fxBurst).toHaveBeenLastCalledWith(400,true);
 expect(props.onMask).toHaveBeenLastCalledWith(Array(816).fill(1),[[10,20,1,1]]);
 view.rerender(createElement(Capri2D,{...props,sleepingPerched:true}));act(()=>nextFrame(600));
 expect(view.container.querySelector('[data-capri-sleep-face]')).toBeNull();
 expect(view.container.querySelector('[data-capri2d]')).toHaveStyle({opacity:'1'});
 act(()=>nextFrame(21600));
 expect(mocks.draw.mock.calls.at(-1)![0].mask).toBe(1);
 expect(props.onMask).toHaveBeenLastCalledWith(Array(816).fill(1),[[10,20,1,1]]);
 view.unmount();
});
