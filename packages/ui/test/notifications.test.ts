// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { foregroundNotification } from "../src/notifications.ts";
import { COMPANION_KEY } from "../src/useCompanion.ts";
afterEach(() => localStorage.clear());
it("uses the existing companion mode for foreground branding without losing dialog copy", () => {
 const notice = { id: "ask", event: "agentAttention" as const, title: "Pregunta", body: "Review te pregunta: Which branch?" };
 expect(foregroundNotification(notice)).toMatchObject({title:"Gentle Dot", body:notice.body});
 localStorage.setItem(COMPANION_KEY, JSON.stringify({mode:"capri"}));
 expect(foregroundNotification(notice)).toMatchObject({title:"Capri", body:notice.body});
 localStorage.setItem(COMPANION_KEY, JSON.stringify({mode:"gentle"}));
 expect(foregroundNotification(notice).title).toBe("Gentle Dot");
});
