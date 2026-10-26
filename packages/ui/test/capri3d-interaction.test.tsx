import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopCompanionControls } from "../src/desktop-companion.ts";
import type { ClipChoice } from "../src/capri3d/mapping.ts";
import { DesktopCompanionSurface } from "../src/components/DesktopCompanionSurface.tsx";
const observed = vi.hoisted(() => ({ choice: undefined as ClipChoice | undefined, handlers: new Map<string, (e: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn(async () => true) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => { observed.handlers.set(name, handler); return () => observed.handlers.delete(name); }) }));
vi.mock("../src/capri3d/native.ts", () => ({ usePreferred3D: () => true, readLocalAsset: vi.fn(), publish3DSurface: vi.fn(async () => {}) }));
vi.mock("../src/capri3d/Capri3D.tsx", async () => {
 const { useEffect } = await import("react");
 return { Capri3D: (props: { choice: ClipChoice; onActive(active: boolean): void }) => { observed.choice = props.choice; useEffect(() => { props.onActive(true); }, [props.onActive]); return null; } };
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); observed.handlers.clear(); });
const controls = (): DesktopCompanionControls => ({
 state: { enabled: true, visible: true, available: true, motion: true, appearances: true, paused: false, pinned: false, areas: [], monitors: [] },
 pending: false, change: vi.fn(), interact: vi.fn(async () => {}), recall: vi.fn(), hide: vi.fn(), menu: vi.fn(), move: vi.fn(),
});
it("holds through compositor completion, capture loss and cancellation until native release", async () => {
 vi.useFakeTimers();
 vi.stubGlobal("PointerEvent", class extends MouseEvent { pointerId = 1; isPrimary = true; });
 const drag = vi.fn(async () => {});
 render(<DesktopCompanionSurface controls={controls()} agentState="idle" connected toggle={vi.fn()} startDrag={drag} />);
 await act(async () => {});
 const button = screen.getByRole("button");
 fireEvent.pointerDown(button, { button: 0, clientX: 10, clientY: 10 });
 fireEvent.pointerMove(button, { clientX: 40, clientY: 10 });
 await act(async () => {}); expect(drag).toHaveBeenCalledOnce();
 fireEvent.lostPointerCapture(button); fireEvent.pointerCancel(button); fireEvent(window, new Event("blur"));
 expect(observed.choice).toMatchObject({ model: "roja.glb", procedural: "colgando" });
 act(() => observed.handlers.get("dot://capri3d-release")!({ payload: null }));
 expect(observed.choice?.model).toBe("roja.glb");
});
it("sleeps on the native signal despite work, then wakes and greets on unlock", async () => {
 vi.useFakeTimers();
 render(<DesktopCompanionSurface controls={controls()} agentState="working" connected toggle={vi.fn()} startDrag={vi.fn()} />);
 await act(async () => {});
 act(() => observed.handlers.get("dot://capri3d-absence")!({ payload: true }));
 expect(observed.choice?.model).toBe("roja_recostada_cerrados.glb");
 act(() => observed.handlers.get("dot://capri3d-absence")!({ payload: false }));
 expect(observed.choice?.model).toBe("roja_recostada_abiertos.glb");
 act(() => vi.advanceTimersByTime(900)); expect(observed.choice?.clip).toBe("Saludar_y_teletransportarse");
 act(() => vi.advanceTimersByTime(3000)); expect(observed.choice?.clip).toBe("Pensar");
});
