# Keep the attachment clip inside the composer

The verified defect is a mobile clip hit area extending 3px beyond the composer's left border. Removing the shared negative left margin restores reserved layout space without changing upload, send, or voice logic. The originally reported overlap with message text was **not reproduced** in Chromium; this correction must not be described as proof of that separate symptom.

## Evidence and review path

1. Review `.composer-attach` in `packages/ui/src/styles.css`: the only production change removes `margin-left: -8px`.
2. Review `packages/ui/test/fixtures/composer-attachments.tsx`: real Composer, attachment hook, shared styles, orchestration/navigation overrides, and conditional Android styles. It reproduces the `mobile-shell → chat.chat-web.chat-mobile → chat-composer` ancestry; uploads and agent replies are deterministic stand-ins, not real transport.
3. Run the isolated browser suite using `.cache/chat-attachments-and-usage/composer/playwright.config.ts`. Do not use the root daemon fixture for this isolated check.

| Observation | Result before correction |
| --- | --- |
| Context-faithful Chromium run | Four cases passed existing interaction/non-overlap checks |
| Mobile 320px and 375px | Clip left 7px, composer left 10px: 3px boundary overflow |
| Added mobile containment assertions | Two mobile failures; two desktop passes (parent job-12, exit 1) |
| Text and clip hit testing | Textarea hit resolved to TEXTAREA; clip hit remained active |
| Message-text overlap | Not reproduced at 320/375px mobile or 375/1280px desktop |

The mobile composer has 4px padding and a 1px border. The inherited −8px clip margin placed its left edge at `10 + 1 + 4 − 8 = 7px`. No evidence required hiding, disabling, or resizing the clip.

## Regression checks and limits

The browser suite logs actual rectangles and captures multiline/chip screenshots under the composer cache. It checks clip/form containment on mobile, clip/text and send/text non-intersection, text hit testing, editable multiline input, Shift+Enter without sending, visible file-picker interaction, attachment chips/removal, sending attachments, Stop, and plain Enter sending. It exercises mobile widths 320/375px and desktop widths 375/1280px with reduced motion.

Production behavior is unchanged: no Composer TypeScript, transport, validation, consent, or send contract changes. A functional old/current differential and CLI differential are not applicable to this CSS-only change; the observed pre-fix browser containment failures provide the layout comparison. Existing functional tests remain intact.

After removing the margin, parent job-13 passed all four browser cases: mobile clip left became 15px inside the form's 10px left border, with no clip/text overlap. The focused Vitest command exceeded the worker's approved 30s foreground bound without results; no focused pass is claimed. Parent integrated job-14 reported typecheck failure because the original React fixture lived under the Node-only E2E project, plus five unrelated-to-layout UI integration failures.

The fixture now lives in the owning UI project's existing `test` include, which supplies React JSX, DOM libraries, Vite CSS types, and local dependency resolution. Only its location, relative imports, and the isolated server entry changed; browser assertions and production CSS are unchanged by this validation correction. No compiler configuration, strictness, or exclusions were changed. Parent post-relocation typecheck, full regression suite, and browser validation remain pending. Physical Android/WebView behavior and the originally reported message-text overlay remain unverified.
