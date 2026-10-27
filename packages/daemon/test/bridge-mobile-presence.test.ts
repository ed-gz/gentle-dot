import type { ServerPayload } from "@gentle-dot/protocol";
import { expect, it, vi } from "vitest";
import { DotBridge } from "../src/bridge.ts";
import { MobilePresence } from "../src/mobile-presence.ts";
import type { AgentSupervisor } from "../src/supervisor.ts";

it("preserves desktop toasts and phone data, bypasses questions/permissions, and releases only to the paired phone", () => {
 let now = 100_000;
 const gate = new MobilePresence(() => now, (key, batch) => bridge.releaseMobileSummary(key, batch));
 const supervisor = {state: "ready", busy: false, onEvent: vi.fn()} as unknown as AgentSupervisor;
 const bridge = new DotBridge(supervisor, {dataDir: "/unused", mobilePresence: gate});
 const desktop: ServerPayload[] = [], phone: Array<ServerPayload & {mobileNotificationSuppressed?: boolean}> = [], other: ServerPayload[] = [];
 bridge.attach({send: payload => desktop.push(payload)});
 gate.configure("phone", true); gate.configure("other", false);
 bridge.attach({mobileKey: "phone", send: payload => phone.push(payload)});
 bridge.attach({mobileKey: "other", send: payload => other.push(payload)});
 gate.sample(false); now += 2000; gate.sample(false);
 desktop.length=0; phone.length=0; other.length=0;
 bridge.notifySession({type:"toast", level:"info", notificationId:"finished", notificationEvent:"agentCompleted", title:"Sesión", message:"Lista"});
 expect(desktop[0]).not.toHaveProperty("mobileNotificationSuppressed");
 expect(other[0]).not.toHaveProperty("mobileNotificationSuppressed");
 expect(phone[0]).toMatchObject({type:"toast", message:"Lista", mobileNotificationSuppressed:true});
 for(const event of ["permission", "agentAttention"] as const) {
  bridge.notifySession({type:"toast",level:"warning",notificationId:event,notificationEvent:event,message:"Responde"});
  expect(phone.at(-1)).not.toHaveProperty("mobileNotificationSuppressed");
 }
 gate.sample(true); now+=2000; gate.sample(true);
 expect(phone.at(-1)).toMatchObject({type:"toast", notificationBatch:{summaries:["Sesión: Lista"], dropped:0}});
 expect(desktop).toHaveLength(3);expect(other).toHaveLength(3);
 expect(gate.suppressed("phone", "finished")).toBe(true); // polling cannot replay a held event
});
