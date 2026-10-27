import { expect, it } from "vitest";
import { initialState, reduce } from "../src/store.ts";

it("keeps mobile reply content while suppressing only its presence-gated notice", () => {
 const message = {type:"message_done" as const, seq:1, messageId:"m1", text:"Respuesta completa", mobileNotificationSuppressed:true};
 const next = reduce(initialState, {type:"server",message});
 expect(next.messages.at(-1)?.text).toBe("Respuesta completa");
 expect(next.notices).toHaveLength(0);
});
it("suppresses gated mobile toasts but keeps ordinary desktop toasts and actionable notices", () => {
 const toast = {type:"toast" as const, seq:1, level:"info" as const, message:"Lista", notificationEvent:"agentCompleted" as const, notificationId:"a", mobileNotificationSuppressed:true};
 expect(reduce(initialState,{type:"server",message:toast}).notices).toHaveLength(0);
 const ordinary = {...toast,mobileNotificationSuppressed:false};
 expect(reduce(initialState,{type:"server",message:ordinary}).notices).toHaveLength(1);
 const permission = {...toast, notificationEvent:"permission" as const};
 expect(reduce(initialState,{type:"server",message:permission}).notices).toHaveLength(1);
});
