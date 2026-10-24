import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bridge = join(root, "packages/daemon/src/orchestration/review-consent-presentation.ts");
const hash = source => createHash("sha256").update(source).digest("hex");
const originals = {
    "extensions/gentle-ai.ts": "5de93fd099932e2d81391827685685765926ef0a20cc0fbb83ad3522b60b25f6",
    "lib/review-consent-ui.ts": "7b8e6475ada8fd18617628a2b54c10b023b10450bd2a7f43c5b2e939bde07669",
    "lib/review-consent-component.ts": "f33dc5c4c2cb923b35b88e3a54d15774139efc8250e4cef08afe6f5f990516de",
};

function once(source, before, after) {
    if (source.split(before).length !== 2) throw new Error("The verified review source no longer matches the bridge insertion point.");
    return source.replace(before, after);
}

/** Pure preparation: validates all source hashes before constructing any file changes. */
export function prepareReviewBridge(directory) {
    const sources = {};
    for (const [relative, expected] of Object.entries(originals)) {
        const source = readFileSync(join(directory, relative), "utf8");
        if (hash(source) !== expected) throw new Error(`Unsupported Gentle Shell source: ${relative}. Nothing was changed.`);
        sources[relative] = source;
    }
    if (!existsSync(bridge)) throw new Error("The Gentle Dot review bridge is unavailable.");
    const provider = once(sources["extensions/gentle-ai.ts"],
        "await presentReviewConsentUi(ctx, eligiblePending.consent);",
        `await presentReviewConsentUi(ctx, eligiblePending.consent, {
                                toolCallId: _toolCallId,
                                sessionId: reviewSessionManagerAndId(ctx)?.sessionId ?? "",
                                consentBinding: eligiblePending.id,
                                expiresAt: eligiblePending.expiresAt,
                                isPending: () => !signal?.aborted &&
                                    pendingReviewConsentSessionKey(ctx, pendingReviewConsentFallbackKey) === sessionKey &&
                                    pendingReviewConsentRegistry.resolve(eligiblePending.id)?.pending === eligiblePending &&
                                    eligiblePending.expiresAt > reviewConsentNow() &&
                                    reviewSessionManagerAndId(ctx)?.sessionId === initialIdentity.sessionId,
                                answer: async (answer) => {
                                    const current = await capturePermissionIdentity(ctx, permissionWorkspaceRoot);
                                    if (signal?.aborted || current === undefined ||
                                        !sameReviewSessionIdentity(initialIdentity, current) ||
                                        reviewSessionPermissionEpoch(current) !== initialEpoch ||
                                        pendingReviewConsentRegistry.resolve(eligiblePending.id)?.pending !== eligiblePending ||
                                        eligiblePending.expiresAt <= reviewConsentNow()) return false;
                                    const sessionGrant = answer === "host-session";
                                    details = await answerPendingConsent(sessionGrant ? "granted" : answer);
                                    if (sessionGrant) {
                                        if (!completedGrantedReviewConsent(details) || !grantReviewSessionPermission(current, initialEpoch)) return false;
                                        setReviewSessionPermissionStatus(ctx, true);
                                        try { ctx.ui.notify("Reviews are allowed for this Pi session and this Git repository.", "info"); } catch { /* Nonblocking indication only. */ }
                                        return true;
                                    }
                                    return answer === "granted" ? completedGrantedReviewConsent(details)
                                        : details.outcome === "consent-declined-this-candidate";
                                },
                            });`);
    let ui = `import { reviewConsentPresentation, type ReviewPresentationAuthority } from ${JSON.stringify(bridge)};\n${sources["lib/review-consent-ui.ts"]}`;
    ui = once(ui, "consent: ReviewConsentEnvelope,\n): Promise", "consent: ReviewConsentEnvelope,\n\tauthority?: ReviewPresentationAuthority,\n): Promise");
    ui = once(ui, "const model = formatReviewConsentUi(consent);\n\ttry {", `const model = formatReviewConsentUi(consent);
    const bridge = reviewConsentPresentation(context.ui, consent, authority, {
        label: model.content.actions[2].label, effect: model.content.actions[2].effect,
        ownership: model.content.ownership,
    });
    try {`);
    ui = once(ui, "return await context.ui.custom<ReviewConsentUiSelection | undefined>", "const selection = await context.ui.custom<ReviewConsentUiSelection | undefined>");
    ui = once(ui, "const component = new ReviewConsentComponent({", "bridge.attach(done);\n\t\t\t\tconst component = new ReviewConsentComponent({");
    ui = once(ui, 'onSelect: (index) => done(index === 0 ? { kind: "provider", answer: "granted" }', 'onSelect: (index) => bridge.local(() => done(index === 0 ? { kind: "provider", answer: "granted" }');
    ui = once(ui, ': { kind: "host-session" }),', ': { kind: "host-session" })),');
    ui = once(ui, 'onCancel: () => done(undefined),', 'onCancel: () => bridge.local(() => done(undefined)),');
    ui = once(ui, '\t\t\t});\n\t\t}\n\t\tconst selected', '\t\t\t});\n\t\t\treturn await bridge.finish(selection);\n\t\t}\n\t\tconst selected');
    ui = once(ui, '\t} catch {\n\t\treturn undefined;\n\t}\n}', '\t} catch {\n\t\treturn undefined;\n\t} finally { bridge.dispose(); }\n}');
    return { "extensions/gentle-ai.ts": provider, "lib/review-consent-ui.ts": ui };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const directory = args.find(value => !value.startsWith("--"));
    if (!directory || args.some(value => value.startsWith("--") && !["--check", "--apply"].includes(value))) {
        throw new Error("Usage: node scripts/orchestration/install-review-bridge.mjs <gentle-pi-directory> [--check|--apply]. Default: check only.");
    }
    const prepared = prepareReviewBridge(resolve(directory));
    for (const [relative, source] of Object.entries(prepared)) console.log(`${relative}: prepared SHA-256 ${hash(source)}`);
    if (args.includes("--apply")) {
        // Validate all targets once more before the first write; retain originals for recovery.
        prepareReviewBridge(resolve(directory));
        for (const [relative, source] of Object.entries(prepared)) {
            const path = join(resolve(directory), relative);
            const backup = `${path}.before-gentle-dot-review-bridge`;
            if (existsSync(backup)) throw new Error(`Backup already exists: ${backup}. Refusing to replace it.`);
        }
        for (const [relative, source] of Object.entries(prepared)) {
            const path = join(resolve(directory), relative);
            copyFileSync(path, `${path}.before-gentle-dot-review-bridge`);
            writeFileSync(`${path}.gentle-dot-pending`, source, { flag: "wx" });
            renameSync(`${path}.gentle-dot-pending`, path);
        }
        console.log("Review bridge installed. Existing sessions keep their loaded code; reload only when no question is pending.");
    } else console.log("Verified preparation only. No Gentle Shell files or running sessions were changed.");
}
