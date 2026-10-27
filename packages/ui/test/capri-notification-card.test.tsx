import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CapriNotificationCard, notificationCardSize, useNotificationAvatar } from "../src/capri3d/CapriNotificationCard.tsx";

vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
import { invoke } from "@tauri-apps/api/core";

it.each([
 ["Hay una pregunta en velosport-odoo.", undefined, false, "compact"],
 ["Hay una pregunta en velosport-odoo.", "  ", false, "compact"],
 ["", undefined, false, "compact"],
 ["x".repeat(40), undefined, false, "compact"],
 ["x".repeat(41), undefined, false, "medium"],
 ["  La sesión terminó  ", "  ", false, "compact"],
 ["Aviso", "x", false, "medium"],
 ["x".repeat(160), undefined, false, "medium"],
 ["x".repeat(161), undefined, false, "full"],
 ["Aviso", "x".repeat(155), false, "medium"],
 ["Aviso", "x".repeat(156), false, "full"],
 ["OK", undefined, true, "full"],
 ["OK", "x".repeat(200), true, "full"],
] as const)("sizes summary/body at the tier boundaries (%s, %s, %s)", (summary, body, prominent, size) => {
 expect(notificationCardSize(summary, body, prominent)).toBe(size);
});

it.each([
 ["La sesión terminó", undefined, false, "compact"],
 ["La sesión terminó con cambios listos para revisar", undefined, false, "medium"],
 ["Aviso", "Detalle largo ".repeat(30), false, "full"],
 ["¿Aprobar?", undefined, true, "full"],
 ["¿Cuál?", undefined, true, "full"],
] as const)("renders a text-proportional size for %s", (summary, body, prominent, size) => {
 render(<CapriNotificationCard summary={summary} body={body} prominent={prominent}>{summary}{body}</CapriNotificationCard>);
 expect(screen.getByRole("status").getAttribute("data-size")).toBe(size);
});

it("does not inflate the compact question with the base fixed height", () => {
 const text='Hay una pregunta en velosport-odoo.';
 const css=readFileSync(`${process.cwd()}/packages/ui/src/capri3d/notification-card.css`,'utf8');
 const style=document.createElement('style');style.textContent=css;document.head.append(style);
 try {
  render(<CapriNotificationCard summary={text}>{text}</CapriNotificationCard>);
  const card=screen.getByRole('status');
  expect(card).toHaveAttribute('data-size','compact');
  expect(getComputedStyle(card).height).toBe('auto');
  expect(getComputedStyle(card).minHeight).toBe('56px');
 } finally { style.remove(); }
});

it("keeps compact acknowledgement and reduced-motion semantics", () => {
 render(<CapriNotificationCard summary="La sesión terminó" reduced onAcknowledge={()=>{}}>La sesión terminó</CapriNotificationCard>);
 expect(screen.getByRole("status").getAttribute("data-size")).toBe("compact");
 expect(screen.getByRole("status").getAttribute("data-reduced-motion")).toBe("true");
 expect(screen.getByRole("button", {name:"Entendido"})).toBeTruthy();
});

it("renders the comic identity without artwork, subtitle or fresh chip", () => {
 render(<CapriNotificationCard summary="Mensaje recibido">Mensaje recibido</CapriNotificationCard>);
 expect(screen.getByText("CAPRI")).toBeTruthy();
 expect(screen.queryByText("SISTEMA")).toBeNull();
 expect(screen.queryByText('NUEVO')).toBeNull();
 expect(screen.queryByRole("img")).toBeNull();
 expect(screen.queryByRole("button", {name:"Entendido"})).toBeNull();
});
it("renders optional avatar and falls back on a broken image", () => {
 render(<CapriNotificationCard avatar="blob:personal" summary="Mensaje">Mensaje</CapriNotificationCard>);
 fireEvent.error(screen.getByRole("img", {name:"Capri"}));
 expect(screen.queryByRole("img")).toBeNull();
 expect(screen.getByText("Mensaje")).toBeTruthy();
});
it("offers acknowledgement only when explicitly answerable", () => {
 const acknowledge=vi.fn();
 render(<CapriNotificationCard summary="Mensaje" onAcknowledge={acknowledge}>Mensaje</CapriNotificationCard>);
 fireEvent.click(screen.getByRole("button", {name:"Entendido"}));
 expect(acknowledge).toHaveBeenCalledOnce();
});
it("does not render dismissed cards or old fresh chips", () => {
 const {rerender}=render(<CapriNotificationCard summary="Mensaje">Mensaje</CapriNotificationCard>);
 expect(screen.queryByText('NUEVO')).toBeNull();
 rerender(<CapriNotificationCard summary="Mensaje" dismissed>Mensaje</CapriNotificationCard>);
 expect(screen.queryByText("Mensaje")).toBeNull();
 expect(screen.queryByText('NUEVO')).toBeNull();
});

it("loads only allowlisted personal art and revokes its object URL on unmount", async()=>{
 vi.mocked(invoke).mockResolvedValueOnce([1,2,3]);
 const create=vi.spyOn(URL,"createObjectURL").mockReturnValue("blob:local-art");
 const revoke=vi.spyOn(URL,"revokeObjectURL").mockImplementation(()=>{});
 const {result,unmount}=renderHook(()=>useNotificationAvatar());
 await waitFor(()=>expect(result.current).toBe("blob:local-art"));
 expect(invoke).toHaveBeenLastCalledWith("capri2d_asset",{name:"capri-full.png"});
 unmount();expect(revoke).toHaveBeenCalledWith("blob:local-art");
 create.mockRestore();revoke.mockRestore();
});
it("missing art is graceful and late replies after unmount do not allocate URLs", async()=>{
 vi.mocked(invoke).mockRejectedValueOnce(new Error("No personal art"));
 const missing=renderHook(()=>useNotificationAvatar());
 await act(async()=>{});
 expect(missing.result.current).toBeUndefined();missing.unmount();
 let resolve!:(bytes:number[])=>void;
 vi.mocked(invoke).mockReturnValueOnce(new Promise<number[]>(done=>{resolve=done;}));
 const create=vi.spyOn(URL,"createObjectURL");
 const late=renderHook(()=>useNotificationAvatar());late.unmount();
 await act(async()=>{resolve([1]);});
 expect(create).not.toHaveBeenCalled();create.mockRestore();
});
