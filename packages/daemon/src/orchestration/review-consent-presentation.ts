import type { LiveReviewConsent } from "./review-consent.ts";

export interface ReviewPresentationAuthority {
	toolCallId: string;
	sessionId: string;
	consentBinding: string;
	expiresAt?: number;
	isPending(): boolean;
	answer(answer: "granted" | "declined" | "host-session"): Promise<boolean>;
}

/** Cooperative shim used only by the fingerprint-verified Gentle Shell installer.
 * Provider callbacks retain candidate/session/repository/epoch checks and consume
 * the original consent binding. No source parsing or simulated terminal input. */
export function reviewConsentPresentation(
	ui: object,
	consent: LiveReviewConsent["consent"],
	authority: ReviewPresentationAuthority | undefined,
	hostSessionChoice: LiveReviewConsent["hostSessionChoice"],
) {
	const receiver = Reflect.get(ui, Symbol.for("gentle-pi.review-consent.bridge/v1")) as
		| ((request: LiveReviewConsent) => (() => void) | undefined)
		| undefined;
	let closeLocal: (() => void) | undefined;
	let withdraw: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let live = false;
	let remoteStarted = false;
	let localSettled = false;
	let remoteResult: Promise<boolean> | undefined;
	const detach = () => { live = false; withdraw?.(); withdraw = undefined; };
	return {
		attach(done: (selection: undefined) => void) {
			closeLocal = () => done(undefined);
			if (!authority || typeof receiver !== "function" || !authority.isPending()) return;
			live = true;
			const request: LiveReviewConsent = Object.freeze({
				toolCallId: authority.toolCallId, sessionId: authority.sessionId,
				consentBinding: authority.consentBinding,
				...(authority.expiresAt === undefined ? {} : { expiresAt: authority.expiresAt }),
				consent: structuredClone(consent),
				...(hostSessionChoice ? { hostSessionChoice: { ...hostSessionChoice } } : {}),
				detach,
				async respond(input: Parameters<LiveReviewConsent["respond"]>[0]) {
					if (!input || Object.keys(input).length !== 2 ||
						Object.keys(input).some(key => key !== "consentBinding" && key !== "answer") ||
						input.consentBinding !== authority.consentBinding ||
						!["granted", "declined", ...(hostSessionChoice ? ["host-session"] : [])].includes(input.answer) ||
						!live || remoteStarted || localSettled ||
						(authority.expiresAt !== undefined && Date.now() >= authority.expiresAt) || !authority.isPending()) return false;
					remoteStarted = true;
					detach();
					// Assign before invoking user callbacks, so synchronous throws also
					// resolve the same one-shot operation and close the original dialog.
					remoteResult = Promise.resolve().then(() => authority.answer(input.answer));
					try { return await remoteResult; }
					finally { closeLocal?.(); }
				},
			});
			withdraw = receiver(request);
			if (!withdraw) live = false;
			else if (authority.expiresAt !== undefined) timer = setTimeout(() => { detach(); closeLocal?.(); }, Math.max(1, authority.expiresAt - Date.now()));
		},
		local(action: () => void) {
			if (remoteStarted || localSettled) return;
			localSettled = true;
			detach();
			action();
		},
		async finish<T>(selection: T): Promise<T | undefined> {
			if (remoteStarted) { await remoteResult; return undefined; }
			return selection;
		},
		dispose() { detach(); if (timer) clearTimeout(timer); },
	};
}
