import { afterEach, expect, it, vi } from "vitest";
import { connectReviewConsent, reviewConsentDetails, type LiveReviewConsent } from "../src/orchestration/review-consent.ts";
import { reviewConsentPresentation } from "../src/orchestration/review-consent-presentation.ts";

afterEach(() => vi.useRealTimers());

it("keeps deadline-free consent answerable without scheduling expiry", async () => {
	vi.useFakeTimers();
	const ui = {};
	let request: LiveReviewConsent | undefined;
	const withdraw = vi.fn();
	const close = vi.fn();
	const answer = vi.fn(async () => true);
	let pending = true;
	const disconnect = connectReviewConsent(ui, value => { request = value; return withdraw; });
	const presentation = reviewConsentPresentation(ui, {
		schema: "gentle-ai.review-integration.consent/v3", agent: "pi", headline: "Review",
		raw: { candidate: "frozen" }, choices: [
			{ answer: "granted", label: "Review once", effect: "This candidate" },
			{ answer: "declined", label: "Decline", effect: "No review" },
		],
	}, {
		toolCallId: "tool", sessionId: "session", consentBinding: "binding",
		isPending: () => pending, answer,
	}, undefined);
	try {
		presentation.attach(close);
		expect(request).toBeDefined();
		expect(request).not.toHaveProperty("expiresAt");
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
		expect(close).not.toHaveBeenCalled();
		expect(withdraw).not.toHaveBeenCalled();
		expect(reviewConsentDetails(request!)).toBeDefined();
		expect(await request!.respond({ consentBinding: "forged", answer: "granted" })).toBe(false);
		pending = false;
		expect(await request!.respond({ consentBinding: "binding", answer: "granted" })).toBe(false);
		expect(answer).not.toHaveBeenCalled();
		pending = true;
		expect(await request!.respond({ consentBinding: "binding", answer: "granted" })).toBe(true);
		expect(answer).toHaveBeenCalledExactlyOnceWith("granted");
		expect(close).toHaveBeenCalledExactlyOnceWith(undefined);
		expect(await request!.respond({ consentBinding: "binding", answer: "declined" })).toBe(false);
		for (const expiresAt of [Date.now() - 1, Date.now(), NaN, Infinity, -Infinity, null, "future"]) {
			expect(reviewConsentDetails({ ...request!, expiresAt } as LiveReviewConsent)).toBeUndefined();
		}
		expect(reviewConsentDetails({ ...request!, expiresAt: Date.now() + 1000 })).toBeDefined();
	} finally { presentation.dispose(); disconnect(); }
});
