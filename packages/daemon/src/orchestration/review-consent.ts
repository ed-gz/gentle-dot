import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/** Version-pinned provider contract. The capability and opaque binding never leave this process. */
export interface LiveReviewConsent {
	readonly toolCallId: string;
	readonly sessionId: string;
	readonly consentBinding: string;
	/** Absent for deadline-free Shell consent; finite for the bundled 4.0.0 provider. */
	readonly expiresAt?: number;
	readonly consent: {
		schema: string;
		agent: string;
		headline: string;
		raw: Record<string, unknown>;
		choices: readonly { answer: string; label: string; effect: string }[];
	};
	/** Host-owned standing grant, offered only by the verified three-choice provider. */
	readonly hostSessionChoice?: { label: string; effect: string; ownership: string };
	respond(input: { consentBinding: string; answer: "granted" | "declined" | "host-session" }): Promise<boolean>;
	detach(): void;
}

// Filled from the durable gentle-pi@4.0.0 patch, not from model/event metadata.
const PROVIDER_SHA256 = "c68a70a8c2cfe2841e8dbdf031cd6767746c185f1b624d1f75915257c3fe6109";
// Produced only by scripts/orchestration/install-review-bridge.mjs after checking
// all three installed source hashes. Supports the explicit host-session choice.
const SHELL_PROVIDER_SHA256 = [
	"e441c29b193a9a2d0b890ab9fa5024790c5a8146037068110f68a7464ab4f105", // 4.3.0, deadline-free bridge
	"48bfb8e2e81fbd182eaf83e67f969c4839c075ff5f3a7baa6ad7bbf72d95ea66", // 4.5.0, deadline-free bridge
];
export function isNativeReviewSource(path: unknown): boolean {
	if (typeof path !== "string") return false;
	try {
		const source = statSync(path);
		if (!source.isFile() || source.size > 1024 * 1024) return false;
		return [PROVIDER_SHA256, ...SHELL_PROVIDER_SHA256].includes(createHash("sha256").update(readFileSync(path)).digest("hex"));
	} catch {
		return false;
	}
}

/** Pi extension module roots differ; the provider deliberately publishes on the shared UI object. */
export function connectReviewConsent(
	ui: object,
	receive: (request: LiveReviewConsent) => (() => void) | undefined,
): () => void {
	const key = Symbol.for("gentle-pi.review-consent.bridge/v1");
	if (Reflect.get(ui, key)) throw new Error("Review consent bridge already owned");
	Object.defineProperty(ui, key, { value: receive, configurable: true });
	return () => {
		if (Reflect.get(ui, key) === receive) Reflect.deleteProperty(ui, key);
	};
}

export function reviewConsentDetails(request: LiveReviewConsent): Record<string, unknown> | undefined {
	const consent = request.consent;
	if (
		consent?.schema !== "gentle-ai.review-integration.consent/v3" ||
		consent.agent !== "pi" ||
		typeof consent.headline !== "string" ||
		!consent.raw ||
		consent.choices?.length !== 2 ||
		consent.choices[0]?.answer !== "granted" ||
		consent.choices[1]?.answer !== "declined" ||
		consent.choices.some((choice) => typeof choice.label !== "string" || typeof choice.effect !== "string") ||
		(request.hostSessionChoice !== undefined && (
			typeof request.hostSessionChoice.label !== "string" || !request.hostSessionChoice.label ||
			typeof request.hostSessionChoice.effect !== "string" || !request.hostSessionChoice.effect ||
			typeof request.hostSessionChoice.ownership !== "string" || !request.hostSessionChoice.ownership
		)) ||
		(request.expiresAt !== undefined && (
			!Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now()
		)) ||
		typeof request.respond !== "function" ||
		typeof request.detach !== "function"
	)
		return;
	return {
		kind: "select",
		title: consent.headline,
		// The complete original envelope is shown, including commands, target, evidence and effects.
		message: JSON.stringify(consent.raw, null, 2) + (request.hostSessionChoice ? `\n\nHost session permission:\n${request.hostSessionChoice.ownership}` : ""),
		options: [...consent.choices.map((choice) => ({
			id: choice.answer,
			label: `${choice.label}\nEffect: ${choice.effect}`,
		})), ...(request.hostSessionChoice ? [{
			id: "host-session",
			label: `${request.hostSessionChoice.label}\nEffect: ${request.hostSessionChoice.effect}`,
		}] : [])],
	};
}
