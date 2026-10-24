// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
const plugin = vi.hoisted(() => ({
 addListener: vi.fn(async (_event: string, _listener: (event: unknown) => void) => ({remove: vi.fn()})),
 monitorState: vi.fn(async () => ({active:true})),
 notify: vi.fn(async () => {}),
 startMonitor: vi.fn(async () => {}),
}));
vi.mock("@capacitor/core", () => ({
 Capacitor: {isNativePlatform: () => true, getPlatform: () => "android"},
 registerPlugin: () => plugin, SystemBars: {setStyle: vi.fn(async () => {})}, SystemBarsStyle: {Light:"light", Dark:"dark"},
}));
import { ensureMonitor, MONITOR_OPT_OUT, setupNative } from "../src/native.ts";
afterEach(() => {delete window.__GENTLE_MOBILE__; localStorage.clear(); vi.clearAllMocks();});
it("forwards every known foreground event and owning identity without opaque payload fields", () => {
 setupNative();
 const receive = plugin.addListener.mock.calls[0]?.[1] as unknown as (event: unknown) => void;
 const listener = vi.fn(); window.addEventListener("gentledot-notification", listener);
 for (const event of ["dotReply", "dotError", "agentCompleted", "agentAttention", "agentError", "agentAvailable", "permission"]) {
  receive({id:event,title:"Aviso",body:"Texto público",event,session:{paneId:"p",sessionId:"s"},opaque:"must-not-forward"});
  expect((listener.mock.calls.at(-1)?.[0] as CustomEvent).detail).toEqual({id:event,title:"Aviso",body:"Texto público",event,session:{paneId:"p",sessionId:"s"}});
 }
 expect(listener).toHaveBeenCalledTimes(7);
 receive({id:"bad",title:"Aviso",body:"",event:"unknown"});
 receive({id:"bad",title:"Aviso",body:"",event:"permission",session:{paneId:4}});
 expect(listener).toHaveBeenCalledTimes(7);
 window.removeEventListener("gentledot-notification", listener);
});
it("keeps the active native monitor as the single owner of direct system notices", async () => {
 setupNative();
 const notice = {id:"direct",title:"Aviso",body:"Detalle",event:"agentCompleted" as const};
 await window.__GENTLE_MOBILE__?.notify?.(notice);
 expect(plugin.notify).not.toHaveBeenCalled();
 plugin.monitorState.mockResolvedValueOnce({active:false});
 await window.__GENTLE_MOBILE__?.notify?.(notice);
 expect(plugin.notify).toHaveBeenCalledExactlyOnceWith(notice);
});
it("starts background notices for a paired phone unless the person turned them off", async () => {
 const connection = {url:"https://pc.example", token:"t"};
 plugin.monitorState.mockResolvedValueOnce({active:false,status:"not_paired"} as never);
 expect(await ensureMonitor(connection)).toBe(true);
 expect(plugin.startMonitor).toHaveBeenCalledExactlyOnceWith(connection);
 for (const status of ["on","needs_permission"]) {
  plugin.startMonitor.mockClear();
  plugin.monitorState.mockResolvedValueOnce({active:status==="on",status} as never);
  expect(await ensureMonitor(connection)).toBe(false);
  expect(plugin.startMonitor).not.toHaveBeenCalled();
 }
 plugin.startMonitor.mockClear();
 localStorage.setItem(MONITOR_OPT_OUT, "1");
 plugin.monitorState.mockResolvedValueOnce({active:false,status:"not_paired"} as never);
 expect(await ensureMonitor(connection)).toBe(false);
 expect(plugin.startMonitor).not.toHaveBeenCalled();
});
