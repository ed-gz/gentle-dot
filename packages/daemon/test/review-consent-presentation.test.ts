import { afterEach, expect, it, vi } from "vitest";
import { connectReviewConsent, reviewConsentDetails, type LiveReviewConsent } from "../src/orchestration/review-consent.ts";
import { reviewConsentPresentation } from "../src/orchestration/review-consent-presentation.ts";

afterEach(() => vi.useRealTimers());

function setup(offerSession = true) {
	const ui = {};
	let request: LiveReviewConsent | undefined;
	let pending = true;
	const close = vi.fn();
	const withdraw = vi.fn();
	const grant = vi.fn(async () => true);
	const decline = vi.fn(async () => true);
	const session = vi.fn(async () => true);
	const disconnect = connectReviewConsent(ui, value => { request = value; return withdraw; });
	const presentation = reviewConsentPresentation(ui, {
		schema: "gentle-ai.review-integration.consent/v3", agent: "pi", headline: "Review this candidate",
		raw: { target: "frozen-candidate", command: "review start" },
		choices: [{ answer: "granted", label: "Review once", effect: "Only this candidate" }, { answer: "declined", label: "Decline", effect: "Do not review this candidate" }],
	}, {
		toolCallId: "tool", sessionId: "session", consentBinding: "opaque-binding", expiresAt: Date.now() + 60_000,
		isPending: () => pending,
		answer: async answer => answer === "granted" ? grant() : answer === "declined" ? decline() : session(),
	}, offerSession ? {
		label: "Review and allow this session", effect: "Allows later reviews in this session and repository; revoke anytime.",
		ownership: "Host-owned permission for this exact Pi session and canonical Git repository. No verdict, acknowledgement or delivery authority.",
	} : undefined);
	presentation.attach(close);
	if (!request) throw new Error("No remote review request");
	return { request, presentation, grant, decline, session, close, withdraw,
		stale: () => { pending = false; }, dispose: () => { presentation.dispose(); disconnect(); } };
}

it.each(["granted", "declined", "host-session"] as const)("dispatches only the explicit %s review choice and consumes it once", async answer => {
	const h = setup();
	try {
		expect(await h.request.respond({ consentBinding: "opaque-binding", answer })).toBe(true);
		expect(h.grant).toHaveBeenCalledTimes(answer === "granted" ? 1 : 0);
		expect(h.decline).toHaveBeenCalledTimes(answer === "declined" ? 1 : 0);
		expect(h.session).toHaveBeenCalledTimes(answer === "host-session" ? 1 : 0);
		expect(await h.request.respond({ consentBinding: "opaque-binding", answer })).toBe(false);
		expect(h.close).toHaveBeenCalledExactlyOnceWith(undefined);
		expect(await h.presentation.finish({ kind: "host-session" })).toBeUndefined();
	} finally { h.dispose(); }
});

it("projects the broad grant with its complete original effect and ownership", () => {
	const h = setup();
	try {
		const details = reviewConsentDetails(h.request);
		expect(details?.options).toEqual([
			{ id: "granted", label: "Review once\nEffect: Only this candidate" },
			{ id: "declined", label: "Decline\nEffect: Do not review this candidate" },
			{ id: "host-session", label: "Review and allow this session\nEffect: Allows later reviews in this session and repository; revoke anytime." },
		]);
		expect(details?.message).toContain(h.request.hostSessionChoice?.ownership);
		expect(details?.message).toContain("frozen-candidate");
		expect(JSON.stringify(details)).not.toContain("opaque-binding");
	} finally { h.dispose(); }
});

it("refuses a session grant when the provider did not offer it", async () => {
	const h = setup(false);
	try {
		expect(await h.request.respond({ consentBinding: "opaque-binding", answer: "host-session" })).toBe(false);
		expect(h.session).not.toHaveBeenCalled();
		expect(reviewConsentDetails(h.request)?.options).toHaveLength(2);
	} finally { h.dispose(); }
});

it.each(["stale", "local", "expired", "binding"])("rejects %s consent without granting anything", async reason => {
	vi.useFakeTimers();
	const h = setup();
	try {
		if (reason === "stale") h.stale();
		if (reason === "local") h.presentation.local(() => {});
		if (reason === "expired") vi.advanceTimersByTime(60_001);
		expect(await h.request.respond({ consentBinding: reason === "binding" ? "wrong" : "opaque-binding", answer: "host-session" })).toBe(false);
		expect(h.session).not.toHaveBeenCalled();
		expect(h.grant).not.toHaveBeenCalled();
	} finally { h.dispose(); }
});

it("waits for provider acknowledgement before completing and prevents a competing local choice", async () => {
	const h = setup();
	let acknowledge: (value: boolean) => void = () => {};
	h.session.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
	try {
		const response = h.request.respond({ consentBinding: "opaque-binding", answer: "host-session" });
		await Promise.resolve();
		expect(h.close).not.toHaveBeenCalled();
		const local = vi.fn(); h.presentation.local(local);
		expect(local).not.toHaveBeenCalled();
		acknowledge(false);
		expect(await response).toBe(false);
		expect(h.close).toHaveBeenCalledOnce();
	} finally { h.dispose(); }
});
