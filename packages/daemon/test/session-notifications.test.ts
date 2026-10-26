import { expect, it } from "vitest";
import type { OrchestrationEvent } from "../src/orchestration/index.ts";
import { sessionNotice } from "../src/session-notifications.ts";

const event: OrchestrationEvent = {
	id: "event-1",
	at: "2026-10-13T00:00:00Z",
	type: "completed",
	message: "Pi — very long session and project: available",
	assistantMessageId: "message",
};
it("separates completed output from availability and avoids leaking terminal labels into banners", () => {
	expect(sessionNotice({ ...event, resultChanged: true })).toMatchObject({
		notificationEvent: "agentCompleted",
		notificationId: "event-1",
	});
	expect(sessionNotice({ ...event, resultChanged: false })).toMatchObject({
		notificationEvent: "agentAvailable",
	});
	expect(sessionNotice({ ...event, assistantMessageId: undefined })).toMatchObject({
		notificationEvent: "agentAvailable",
	});
	expect(sessionNotice(event)?.message).not.toContain("Pi");
});
it("keeps actionable permissions distinct and drops automatic policy bookkeeping", () => {
	expect(sessionNotice({ ...event, type: "attention", requestId: "ask" })?.notificationEvent).toBe(
		"permission",
	);
	expect(sessionNotice({ ...event, type: "attention" })?.notificationEvent).toBe("agentAttention");
	expect(sessionNotice({ ...event, type: "disconnected" })?.notificationEvent).toBe("agentError");
	expect(sessionNotice({ ...event, type: "policy" })).toBeUndefined();
	expect(sessionNotice({ ...event, type: "disconnected", intentional: true })).toBeUndefined();
});

it("classifies dialog metadata without completion and uses a stable dialog identity", () => {
	const dialog = { ...event, type: "attention" as const, requestId: "ask-1", sessionId: "Review", dialogTitle: "Which branch?", dialogKind: "question" as const };
	const notice = sessionNotice(dialog);
	expect(notice).toMatchObject({ notificationEvent: "agentAttention", title: "Pregunta", message: "Review te pregunta: Which branch?" });
	expect(sessionNotice({ ...dialog, id: "retry" })?.notificationId).toBe(notice?.notificationId);
	expect(sessionNotice({ ...dialog, requestId: "ask-2" })?.notificationId).not.toBe(notice?.notificationId);
	expect(sessionNotice({ ...dialog, dialogKind: "permission", dialogTitle: "git push" })).toMatchObject({ notificationEvent: "permission", title: "Permiso", message: "Review pide permiso: git push" });
	expect(sessionNotice({ ...dialog, dialogKind: undefined })?.notificationEvent).toBe("permission");
	expect(sessionNotice({ ...dialog, paneId: "other" })?.notificationId).not.toBe(notice?.notificationId);
	expect(sessionNotice({ ...dialog, dialogTitle: "x".repeat(200) })?.message).toBe(`Review te pregunta: ${"x".repeat(160)}`);
	expect(sessionNotice({ ...dialog, type: "completed" })?.notificationEvent).toBe("agentCompleted");
});

it("preserves exact session identity so the phone can open it or keep a viewed reply silent", () => {
	expect(sessionNotice({ ...event, paneId: "w2F:p1", sessionId: "session-a" })).toMatchObject({
		session: { paneId: "w2F:p1", sessionId: "session-a" },
	});
	expect(sessionNotice(event)).not.toHaveProperty("session");
});
