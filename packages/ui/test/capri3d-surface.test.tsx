import { act, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Capri3D } from "../src/capri3d/Capri3D.tsx";
import type { CapriRenderer, RendererFactory } from "../src/capri3d/renderer.ts";
import { DesktopCompanionSurface } from "../src/components/DesktopCompanionSurface.tsx";
import type { DesktopCompanionControls } from "../src/desktop-companion.ts";
vi.mock("../src/capri3d/native.ts", () => ({
 usePreferred3D: () => true,
 readLocalAsset: vi.fn(async () => { throw Error("No installed assets"); }),
 publish3DSurface: vi.fn(async () => {}),
}));
const idle = { state: "idle", animation: "idle", target: "stay" } as const;
it("keeps the existing clickable 2D sprite when 3D is preferred but not installed", async () => {
 const controls: DesktopCompanionControls = {
  state: { enabled: true, visible: true, motion: true, appearances: true, pinned: false, paused: false, available: true, areas: [], monitors: [] },
  pending: false, change: vi.fn(), interact: vi.fn(async () => {}), recall: vi.fn(), hide: vi.fn(), menu: vi.fn(), move: vi.fn(),
 };
 const view = render(<DesktopCompanionSurface controls={controls} agentState="idle" connected toggle={vi.fn()} startDrag={vi.fn()} />);
 await act(async () => {});
 expect(view.container.querySelector(".desktop-companion-surface")).toHaveAttribute("data-form", "2d");
 expect(view.container.querySelector(".capri-sprite")).not.toBeNull();
});
it("never creates WebGL when the asset is missing, leaving the 2D fallback active", async () => {
 const active = vi.fn(); const factory = vi.fn();
 render(<Capri3D enabled visible reduced={false} preferred behavior={idle} read={async () => { throw Error("missing"); }} factory={factory} onActive={active} onMask={vi.fn()} />);
 await waitFor(() => expect(active).toHaveBeenCalledWith(false));
 expect(factory).not.toHaveBeenCalled();
});
it("drives the renderer interface and stops it when hidden or reduced-motion", async () => {
 const renderer: CapriRenderer = { choose: vi.fn().mockResolvedValue(undefined), visibility: vi.fn(), dispose: vi.fn() };
 const factory: RendererFactory = vi.fn().mockResolvedValue(renderer);
 const read = vi.fn().mockResolvedValue(new ArrayBuffer(8)); const active = vi.fn(); const mask = vi.fn();
 const props = { enabled: true, visible: true, reduced: false, preferred: true, behavior: idle, read, factory, onActive: active, onMask: mask };
 const view = render(<Capri3D {...props} />);
 await waitFor(() => expect(active).toHaveBeenCalledWith(true));
 expect(renderer.choose).toHaveBeenCalledWith({ model: "roja.glb", clip: "Flotar_en_reposo" });
 view.rerender(<Capri3D {...props} visible={false} reduced />);
 expect(renderer.visibility).toHaveBeenLastCalledWith(false, true);
 view.unmount(); expect(renderer.dispose).toHaveBeenCalledOnce();
});
it("disposes a renderer that finishes mounting after unmount", async () => {
 let finish!: (value: CapriRenderer) => void;
 const renderer: CapriRenderer = { choose: vi.fn().mockResolvedValue(undefined), visibility: vi.fn(), dispose: vi.fn() };
 const factory = vi.fn(() => new Promise<CapriRenderer>(resolve => { finish = resolve; }));
 const view = render(<Capri3D enabled visible reduced={false} preferred behavior={idle} read={async () => new ArrayBuffer(8)} factory={factory} onActive={vi.fn()} onMask={vi.fn()} />);
 await waitFor(() => expect(factory).toHaveBeenCalledOnce());
 view.unmount(); await act(async () => finish(renderer));
 expect(renderer.dispose).toHaveBeenCalledOnce();
});
