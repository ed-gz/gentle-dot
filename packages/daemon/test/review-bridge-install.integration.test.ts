import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import type { LiveReviewConsent } from "../src/orchestration/review-consent.ts";

// An opt-in compatibility audit reads the installed source, prepares it in a
// temporary directory, and runs its real UI factory. No Shell source is written.
const installed = process.env.GENTLE_DOT_SHELL_REVIEW_SOURCE;
it.skipIf(!installed)("loads the prepared installed three-choice presenter and closes its native dialog after each exact answer", async () => {
	const installer = resolve("scripts/orchestration/install-review-bridge.mjs");
	const { prepareReviewBridge } = await import(installer) as {
		prepareReviewBridge(directory: string): Record<string, string>;
	};
	const generated = prepareReviewBridge(installed as string);
	const gentle = dirname(createRequire(import.meta.url).resolve("gentle-pi/package.json"));
	const scratch = resolve(".cache/review-bridge-validation");
	mkdirSync(scratch, { recursive: true });
	const temporary = mkdtempSync(join(scratch, "presenter-"));
	try {
		const ui = generated["lib/review-consent-ui.ts"]?.replace('"./review-consent-component.ts"', JSON.stringify(join(gentle, "lib/review-consent-component.ts")));
		if (!ui) throw new Error("Prepared UI missing");
		const module = join(temporary, "ui.ts");
		writeFileSync(module, ui);
		const { presentReviewConsentUi } = await import(module);
		const { decodeReviewConsentV3 } = await import(join(gentle, "lib/review-integration-v2.ts"));
		const raw = JSON.parse(readFileSync(join(gentle, "tests/fixtures/devbinary/consent-v3.captured.json"), "utf8"));
		raw.agent = "pi";
		const consent = decodeReviewConsentV3(raw, "pi");
		for (const answer of ["granted", "declined", "host-session"]) {
			let request: LiveReviewConsent | undefined;
			let closed = 0;
			const handled: string[] = [];
			const context = { mode: "tui", ui: {
				custom(factory: (...args: any[]) => unknown) {
					return new Promise(resolve => factory({ terminal: { rows: 40 }, requestRender() {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text }, undefined,
						(value: unknown) => { closed++; resolve(value); }));
				},
			} };
			Reflect.set(context.ui, Symbol.for("gentle-pi.review-consent.bridge/v1"), (value: LiveReviewConsent) => { request = value; return () => {}; });
			const shown = presentReviewConsentUi(context, consent, {
				toolCallId: "tool", sessionId: "session", consentBinding: "binding", expiresAt: Date.now() + 10_000,
				isPending: () => true, answer: async (value: string) => { handled.push(value); return true; },
			});
			expect(request?.hostSessionChoice?.ownership).toContain("exact Pi session");
			expect(await request?.respond({ consentBinding: "binding", answer: answer as "granted" | "declined" | "host-session" })).toBe(true);
			expect(await shown).toBeUndefined();
			expect(handled).toEqual([answer]);
			expect(closed).toBe(1);
		}
	} finally { rmSync(temporary, { recursive: true, force: true }); }
});
