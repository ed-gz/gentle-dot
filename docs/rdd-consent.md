# Answer a pending RDD review request in Dot

Dot can relay the **two original provider choices** for a live Gentle Pi RDD review request. The request appears inside its owning agent conversation or in the existing configurable request popup. This authorizes only the provider action for that exact candidate—not a verdict, commit, push, PR, release, or later review.

## Quick path

1. In **Ajustes**, choose **Dentro de cada conversación** or **Ventana emergente con respuestas**.
2. Read the complete provider envelope. Dot preserves its headline, reason, value, risk evidence, candidate identity, projection, counts, choice effects, exact invocations, and off-path note/command.
3. Select one original choice and press **Enviar**. The opaque response is exactly `granted` or `declined`; Dot waits for the live provider callback to confirm delivery.

Closing the popup does not answer anything. **Cancelar** on the request withdraws remote access without granting or declining; the original terminal dialog remains usable. Provider expiry safely closes its pending control without sending either answer.

## Permission boundaries

| Action | Ownership and effect |
|---|---|
| Original first choice (`granted`) | Provider-owned; applies only to this frozen candidate. |
| Original second choice (`declined`) | Provider-owned; preserves the provider's exact decline effect. Not an automatic fallback on dismissal or error. |
| **Review and allow this session** | Pi-host-owned, terminal only. It is not included among Dot's remote options and cannot be minted by a remote request. |
| Off-path command | Displayed verbatim as provider content, never executed by the card. |
| Publication/delivery | Not authorized by this UI or by a review outcome. Ordinary repository policy still applies. |

The remote snapshot never carries the opaque consent binding or an executable callback. The extension retains both in process. It binds access to the verified first-party implementation, active tool call, live session, process instance, request ID, original candidate envelope, expiry, and provider pending registry. Forged, mixed, stale, duplicate, or third-action answers cannot invoke native authority. A native callback failure is not an accepted UI click; ambiguous outcomes are not retried by Dot.

Disconnecting, stopping, shutting down, replacing the session, or dismissing local consent never supplies an implicit grant or decline. Connection loss after an explicit answer was already dispatched can leave an unknown native outcome: Dot does not roll it back, retry it, or claim acknowledgment. Local-only host permission remains governed by Gentle Pi's own lifecycle. Do not infer review authority from model text, a tool-result envelope, rendered terminal text, or an arbitrary `ui.custom` dialog.

## Pinned dependency and packaged runtime

This repository carries `patches/gentle-pi@4.0.0.patch`, registered in `pnpm-workspace.yaml` and hashed in `pnpm-lock.yaml`. A frozen workspace installation applies it; editing an installed dependency directly is not the implementation.

The patch adds an explicit typed in-process consent capability at the existing provider-owned UI/registry boundary. It invokes the existing exact `answer-consent` callback and does not change default local consent behavior or introduce a generic custom-dialog responder. The shared UI-object capability supports Pi's separate extension module roots; arbitrary event-bus notifications do not create consent requests.

Packaged Dot runtimes use **npm**, not the workspace's pnpm patch mechanism. `buildRuntime` therefore also emits:

- the committed versioned patch;
- an integrity descriptor containing the two patched source files and original/patched SHA-256 values;
- `apply-review-consent-patch.mjs`, wired into the generated runtime manifest's `postinstall`.

The installer validates the provider version and all source files before writing. It accepts only pristine pinned source or the already-patched source, applies the exact content, and is idempotent. Unsupported versions, modified source, or patch-integrity mismatches fail closed. Builds also reject installed provider bytes that do not match the reviewed pinned implementation. Do not bypass the generated root postinstall when preparing a runtime; a script-disabled install alone is not an RDD-compatible packaged runtime.

## Compatibility and verification limits

- Supported envelope: Gentle Pi **4.0.0**, patched first-party `gentle_review`, Pi TUI, consent schema **v3** with `agent: pi`. Other versions or sources remain local-only.
- Oversize or unsupported payloads stay in the original terminal UI; generic questions, questionnaires, editors, and selects keep their existing behavior.
- Tests use the real installed patched provider factory and Pi/Dot runner, isolated pending state/candidate views, a fake native subprocess transport, and a model stream fixture. They never invoke real native review authority.
- Runtime tests execute the generated installation hook against pristine provider source bytes, verify its result and idempotency, and reject incompatible source/version. This is not a complete release/native-binary installation test.
- The noncommitted differential probe compares pristine versus patched default local selections, formatting, inspect/assess, and local permission revocation by exact exit/stdout/stderr.
- The mobile browser fixture covers complete content, original answer values, owning-session inline presentation, popup dismissal/reopening/focus, and narrow/landscape layouts. It is **not** an installed APK, physical-phone notification, or Android background-delivery test.

## Review path

Review the dependency patch first, then `packages/daemon/src/orchestration/review-consent.ts` and the narrow `dot-session.ts` integration. Check the generated runtime installation hook separately: pnpm workspace success cannot substitute for npm runtime patch application. Finally, review the real-runner negative cases and shared inline/popup fixture. No native RDD verdict or publication approval is asserted by this implementation work.
