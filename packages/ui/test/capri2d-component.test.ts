import { createElement } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), draw: vi.fn(), dispose: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../src/capri2d/engine.ts", async original => ({
 ...await original<typeof import("../src/capri2d/engine.ts")>(),
 createEngine: () => ({ draw: mocks.draw, dispose: mocks.dispose }),
}));
import { Capri2D } from "../src/capri2d/Capri2D.tsx";
let nextFrame: FrameRequestCallback;
beforeEach(() => {
 vi.clearAllMocks();
 mocks.invoke.mockResolvedValue(new ArrayBuffer(4));
 mocks.draw.mockReturnValue(Array(816).fill(1));
 vi.stubGlobal("Image", class { naturalWidth=240; naturalHeight=420; src=""; decode=vi.fn().mockResolvedValue(undefined); });
 vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { nextFrame=callback; return 7; }));
 vi.stubGlobal("cancelAnimationFrame", vi.fn());
 vi.spyOn(document,"hidden","get").mockReturnValue(false);
 vi.spyOn(URL,"createObjectURL").mockReturnValue("blob:local");
 vi.spyOn(URL,"revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("loads only the local cutout and publishes/deduplicates its alpha; hides and disposes", async () => {
 const onActive=vi.fn(), onMask=vi.fn();
 const props={ enabled:true, visible:true, reduced:false, onActive, onMask };
 const view=render(createElement(Capri2D,props));
 await act(async () => {});
 expect(mocks.invoke).toHaveBeenCalledWith("capri2d_asset",{name:"capri-full.png"});
 expect(onActive).toHaveBeenCalledWith(true);
 expect(onMask).toHaveBeenCalledTimes(1);
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
 view.unmount();
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
