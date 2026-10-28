import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isNativeReviewSource } from "../src/orchestration/review-consent.ts";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveReviewConsent } from "../src/orchestration/review-consent.ts";

const virtualSources = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs", async importOriginal => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return { ...fs,
		statSync: (path: string) => virtualSources.has(String(path))
			? { isFile: () => true, size: Buffer.byteLength(virtualSources.get(String(path))!) }
			: fs.statSync(path),
		readFileSync: (path: string, ...args: any[]) =>
		virtualSources.has(String(path)) ? virtualSources.get(String(path)) : (fs.readFileSync as any)(path, ...args) };
});
afterEach(() => virtualSources.clear());

// Read committed upstream bytes only: never load or alter installed bridge backups.
const upstream = process.env.GENTLE_DOT_SHELL_REVIEW_GIT_SOURCE;
const reviewFiles = ["extensions/gentle-ai.ts", "lib/review-consent-ui.ts", "lib/review-consent-component.ts"];
it.skipIf(!upstream).each(["v4.3.0", "HEAD"])("prepares deadline-free %s sources and rejects any unknown hash without changes", async revision => {
	const directory = "/virtual-gentle-shell";
	for (const file of [...reviewFiles, "extensions/gentle-shell.ts"]) {
		virtualSources.set(join(directory, file), execFileSync("git", ["-C", upstream!, "show", `${revision}:${file}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
	}
	const before = new Map(virtualSources);
	const { prepareReviewBridge } = await import(resolve("scripts/orchestration/install-review-bridge.mjs"));
	const generated = prepareReviewBridge(directory);
	const original = virtualSources.get(join(directory, reviewFiles[0]!))!;
	const provider = generated[reviewFiles[0]!];
	const [prefix, suffix] = original.split("await presentReviewConsentUi(ctx, eligiblePending.consent);");
	const injection = provider.slice(prefix!.length, provider.length - suffix!.length);
	expect(injection).not.toMatch(/reviewConsentNow|expiresAt/);
	expect(provider).toContain("consentBinding: eligiblePending.id");
	expect(provider).toContain("reviewSessionPermissionEpoch(current) !== initialEpoch");
	expect(generated[reviewFiles[1]!]).toContain("bridge.attach(done)");
	expect(virtualSources).toEqual(before);
	for (const file of reviewFiles) {
		virtualSources.set(join(directory, file), before.get(join(directory, file)) + "\n// unknown bytes\n");
		const tampered = new Map(virtualSources);
		expect(() => prepareReviewBridge(directory)).toThrow(/Unsupported Gentle Shell source/);
		expect(virtualSources).toEqual(tampered);
		virtualSources.set(join(directory, file), before.get(join(directory, file))!);
	}
	const path = join(directory, reviewFiles[0]!);
	expect(isNativeReviewSource(path)).toBe(false); // Pristine source has no cooperative bridge.
	virtualSources.set(path, provider);
	expect(isNativeReviewSource(path), `prepared provider SHA-256: ${createHash("sha256").update(provider).digest("hex")}`).toBe(true);
});

it.skipIf(!upstream)("accepts current upstream editor bytes and rejects unknown bytes", async () => {
	const directory = "/virtual-gentle-shell";
	const path = join(directory, "extensions/gentle-shell.ts");
	const source = execFileSync("git", ["-C", upstream!, "show", "HEAD:extensions/gentle-shell.ts"], { encoding: "utf8" });
	virtualSources.set(path, source);
	const { prepareEditorActivityBridge } = await import(resolve("scripts/orchestration/install-editor-activity-bridge.mjs"));
	expect(source.split("\t\t\t\tprompt = created;")).toHaveLength(2);
	expect(prepareEditorActivityBridge(directory)["extensions/gentle-shell.ts"]).toContain("installEditorActivityBridge(prompt, pi.events, ctx.sessionManager.getSessionId());");
	expect(virtualSources.get(path)).toBe(source);
	virtualSources.set(path, source + "\n// unknown bytes\n");
	expect(() => prepareEditorActivityBridge(directory)).toThrow(/Unsupported Gentle Shell editor source/);
	expect(virtualSources.get(path)).toBe(source + "\n// unknown bytes\n");
});

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
