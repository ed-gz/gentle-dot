import { createElement, useEffect } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_DESKTOP_COMPANION } from "../src/desktop-companion.ts";
import { DesktopCompanionSurface } from "../src/components/DesktopCompanionSurface.tsx";
vi.mock("../src/capri2d/Capri2D.tsx", () => ({ Capri2D: ({ onActive }: { onActive(active: boolean): void }) => {
 useEffect(() => { onActive(true); return () => onActive(false); }, [onActive]);
 return createElement("canvas", { "data-testid": "capri2d" });
} }));
vi.mock("../src/companion-sessions.ts", async original => ({
 ...await original<typeof import("../src/companion-sessions.ts")>(),
 useWorkingSession: (_info: unknown, enabled: boolean) => enabled ? { paneId: "pane", sessionId: "session", activity: {
  phase: "working", lastAction: { verb: "EDITE", subject: "engine.ts", at: new Date().toISOString() },
 } } : undefined,
}));
afterEach(() => vi.restoreAllMocks());
it("retains the T44a conversation ticker over the active 2D canvas", () => {
 vi.spyOn(document,"hidden","get").mockReturnValue(false);
 render(createElement(DesktopCompanionSurface, {
  controls: { state: { ...DEFAULT_DESKTOP_COMPANION, enabled:true,visible:true,available:true,renderMode:"2d" },
   pending:false, change:vi.fn(), interact:vi.fn().mockResolvedValue(undefined), recall:vi.fn(),hide:vi.fn(),menu:vi.fn(),move:vi.fn(),
  }, agentState:"working",connected:true,toggle:vi.fn(),startDrag:vi.fn(),
 }));
 expect(screen.getByTestId("capri2d")).toBeInTheDocument();
 expect(screen.getByText(/EDITE/)).toBeInTheDocument();
 expect(screen.getByText(/engine.ts/)).toBeInTheDocument();
});
it('uses the ported 2D outcome FX instead of stacking the old 3D placeholder FX',()=>{
 vi.spyOn(document,'hidden','get').mockReturnValue(false);
 const props={controls:{state:{...DEFAULT_DESKTOP_COMPANION,enabled:true,visible:true,available:true,renderMode:'2d' as const},pending:false,change:vi.fn(),interact:vi.fn().mockResolvedValue(undefined),recall:vi.fn(),hide:vi.fn(),menu:vi.fn(),move:vi.fn()},connected:true,toggle:vi.fn(),startDrag:vi.fn()};
 const view=render(createElement(DesktopCompanionSurface,{...props,agentState:'working'}));
 view.rerender(createElement(DesktopCompanionSurface,{...props,agentState:'idle'}));
 expect(view.container.querySelector('.capri3d-outcome')).toBeNull();
 expect(screen.getByText(/EDITE/)).toBeInTheDocument();
 view.rerender(createElement(DesktopCompanionSurface,{...props,agentState:'error'}));
 expect(view.container.querySelector('.capri3d-outcome')).toBeNull();
});
