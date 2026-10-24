import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LiveReviewConsent } from "../src/orchestration/review-consent.ts";
import { afterEach, expect, it, vi } from "vitest";
import { isNativeReviewSource, reviewConsentDetails } from "../src/orchestration/review-consent.ts";

const gentle = dirname(createRequire(import.meta.url).resolve("gentle-pi/package.json"));
const { connectReviewConsentBridge, presentReviewConsentUi } = await import(join(gentle, "lib/review-consent-ui.ts")) as {
	connectReviewConsentBridge(ui: object, receive: (request: LiveReviewConsent) => (() => void) | undefined): () => void;
	presentReviewConsentUi(context: ExtensionContext, consent: unknown, authority: {
		toolCallId: string; sessionId: string; consentBinding: string; expiresAt: number;
		isPending(): boolean; answer(answer: "granted" | "declined"): Promise<boolean>;
	}): Promise<unknown>;
};
const { decodeReviewConsentV3 } = await import(join(gentle, "lib/review-integration-v2.ts")) as {
	decodeReviewConsentV3(raw: Record<string, unknown>, agent: string): LiveReviewConsent["consent"];
};
const raw = JSON.parse(readFileSync(join(gentle, "tests/fixtures/devbinary/consent-v3.captured.json"), "utf8"));
raw.agent = "pi";
const consent = decodeReviewConsentV3(raw, "pi");

afterEach(() => vi.useRealTimers());

function bridge() {
	let request: LiveReviewConsent | undefined;
	let localDone: (selection: unknown) => void = () => {};
	let pending = true;
	const withdraw = vi.fn();
	const answer = vi.fn(async () => true);
	const ui = {
		custom(factory: (...args: any[]) => unknown) {
			return new Promise(resolve => {
				localDone = resolve;
				factory({ terminal: { rows: 30 }, requestRender() {} }, {}, undefined, resolve);
			});
		},
	};
	const disconnect = connectReviewConsentBridge(ui, value => { request = value; return withdraw; });
	const shown = presentReviewConsentUi({ mode: "tui", ui } as unknown as ExtensionContext, consent, {
		toolCallId: "tool", sessionId: "session", consentBinding: "opaque-original-binding",
		expiresAt: Date.now() + 600_000, isPending: () => pending, answer,
	});
	return { get request() { return request!; }, shown, answer, withdraw, disconnect,
		stale() { pending = false; }, close() { localDone(undefined); disconnect(); } };
}

it("exposes the pinned provider-owned live consent subscription, not a generic custom UI resolver", () => {
	expect(connectReviewConsentBridge).toBeTypeOf("function");
});

it("verifies the actual installed patched provider and refuses other first-party tools as review sources", () => {
	expect(isNativeReviewSource(join(gentle, "extensions/gentle-ai.ts"))).toBe(true);
	expect(isNativeReviewSource(join(gentle, "extensions/ask-user-choice.ts"))).toBe(false);
	expect(isNativeReviewSource(undefined)).toBe(false);
});

it("projects the entire original provider body and only its original two ordered choices", () => {
	const h = bridge();
	try {
		const details = reviewConsentDetails(h.request);
		expect(JSON.parse(String(details?.message))).toEqual(consent.raw);
		expect(details?.options).toEqual(consent.choices.map(choice => ({ id: choice.answer, label: `${choice.label}\nEffect: ${choice.effect}` })));
		expect(JSON.stringify(details)).not.toContain(h.request.consentBinding);
	} finally { h.close(); }
});

it.each([
	["forged binding", { consentBinding: "forged", answer: "granted" }],
	["third action", { consentBinding: "opaque-original-binding", answer: "host-session" }],
	["extra action", { consentBinding: "opaque-original-binding", answer: "granted", hostSession: true }],
	["missing binding", { answer: "granted" }],
	["missing answer", { consentBinding: "opaque-original-binding" }],
	["null", null],
])("rejects %s without invoking the provider callback or withdrawing a valid request", async (_name, input) => {
	const h = bridge();
	try {
		expect(await h.request.respond(input as Parameters<LiveReviewConsent["respond"]>[0])).toBe(false);
		expect(h.answer).not.toHaveBeenCalled();
		expect(h.withdraw).not.toHaveBeenCalled();
	} finally { h.close(); }
});

it("rechecks pending state before response, without invoking native authority for stale state", async () => {
	const h = bridge();
	try {
		h.stale();
		expect(await h.request.respond({ consentBinding: h.request.consentBinding, answer: "granted" })).toBe(false);
		expect(h.answer).not.toHaveBeenCalled();
	} finally { h.close(); }
});

it("expiry withdraws and safely closes local UI without granting or declining", async () => {
	vi.useFakeTimers();
	const h = bridge();
	await vi.advanceTimersByTimeAsync(600_001);
	await expect(h.shown).resolves.toBeUndefined();
	expect(h.withdraw).toHaveBeenCalledOnce();
	expect(h.answer).not.toHaveBeenCalled();
	expect(await h.request.respond({ consentBinding: h.request.consentBinding, answer: "granted" })).toBe(false);
	h.disconnect();
});

it("disconnect only withdraws remote access, never turning cancellation into a provider decline", async () => {
	const h = bridge();
	try {
		h.request.detach();
		expect(await h.request.respond({ consentBinding: h.request.consentBinding, answer: "declined" })).toBe(false);
		expect(h.answer).not.toHaveBeenCalled();
		expect(h.withdraw).toHaveBeenCalledOnce();
	} finally { h.close(); }
});

it("an acknowledgment waits for the native callback and a racing duplicate never invokes it twice", async () => {
	const h = bridge();
	let finish: (accepted: boolean) => void = () => {};
	h.answer.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
	try {
		let acknowledged = false;
		const first = h.request.respond({ consentBinding: h.request.consentBinding, answer: "granted" }).then(value => { acknowledged = value; return value; });
		expect(await h.request.respond({ consentBinding: h.request.consentBinding, answer: "declined" })).toBe(false);
		expect(acknowledged).toBe(false);
		expect(h.answer).toHaveBeenCalledOnce();
		finish(true);
		await expect(first).resolves.toBe(true);
		await expect(h.shown).resolves.toBeUndefined();
	} finally { h.close(); }
});
