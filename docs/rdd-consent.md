# Answer a pending RDD review request in Dot

Dot relays the choices exposed by a verified live Gentle Pi RDD review provider. The bundled provider exposes the **two original candidate choices**. A separately installed, fingerprint-verified Gentle Shell bridge can also expose its explicit **session-and-repository permission**. The request appears in its owning conversation or the configurable request popup. A review choice does not by itself authorize a verdict, commit, push, PR or release.

## Quick path

1. In **Ajustes**, choose **Dentro de cada conversación** or **Ventana emergente con respuestas**.
2. Read the complete provider envelope. Dot preserves its headline, reason, value, risk evidence, candidate identity, projection, counts, choice effects, exact invocations, and off-path note/command.
3. Select one displayed choice and press **Enviar**. Candidate responses are `granted` or `declined`; the verified Shell bridge may additionally offer `host-session` with its original scope and effect. Dot waits for the live provider callback to confirm delivery.

Closing the popup does not answer anything. **Cancelar** on the request withdraws remote access without granting or declining; the original terminal dialog remains usable. Provider expiry safely closes its pending control without sending either answer.

## Permission boundaries

| Action | Ownership and effect |
|---|---|
| Original first choice (`granted`) | Provider-owned; applies only to this frozen candidate. |
| Original second choice (`declined`) | Provider-owned; preserves the provider's exact decline effect. Not an automatic fallback on dismissal or error. |
| **Review and allow this session** (`host-session`) | Pi-host-owned. Available remotely only when the separately verified Shell bridge supplies this exact option, scope and effect. Absent from the bundled two-choice provider; a client cannot invent it. |
| Off-path command | Displayed verbatim as provider content, never executed by the card. |
| Publication/delivery | Not authorized by this UI or by a review outcome. Ordinary repository policy still applies. |

The remote snapshot never carries the opaque consent binding or an executable callback. The extension retains both in process. It binds access to the verified first-party implementation, active tool call, live session, process instance, request ID, original candidate envelope, expiry, and provider pending registry. Forged, mixed, stale or duplicate answers cannot invoke native authority. A `host-session` answer is rejected unless the verified provider offered it for that request. A native callback failure is not an accepted UI click; ambiguous outcomes are not retried by Dot.

Disconnecting, stopping, shutting down, replacing the session, or dismissing local consent never supplies an implicit grant or decline. Connection loss after an explicit answer was already dispatched can leave an unknown native outcome: Dot does not roll it back, retry it, or claim acknowledgment. Host-session permission remains governed by Gentle Pi's own lifecycle, including session/repository identity and revocation. Do not infer review authority from model text, a tool-result envelope, rendered terminal text, or an arbitrary `ui.custom` dialog.

## Bundled dependency and optional Shell bridge

The bundled two-choice path carries `patches/gentle-pi@4.0.0.patch`, registered in `pnpm-workspace.yaml` and hashed in `pnpm-lock.yaml`. A frozen workspace installation applies it; editing an installed dependency directly is not the implementation.

The patch adds an explicit typed in-process consent capability at the existing provider-owned UI/registry boundary. It invokes the existing exact `answer-consent` callback and does not change default local consent behavior or introduce a generic custom-dialog responder. The shared UI-object capability supports Pi's separate extension module roots; arbitrary event-bus notifications do not create consent requests.

Packaged Dot runtimes use **npm**, not the workspace's pnpm patch mechanism. `buildRuntime` therefore also emits:

- the committed versioned patch;
- an integrity descriptor containing the two patched source files and original/patched SHA-256 values;
- `apply-review-consent-patch.mjs`, wired into the generated runtime manifest's `postinstall`.

The installer validates the provider version and all source files before writing. It accepts only pristine pinned source or the already-patched source, applies the exact content, and is idempotent. Unsupported versions, modified source, or patch-integrity mismatches fail closed. Builds also reject installed provider bytes that do not match the reviewed pinned implementation. Do not bypass the generated root postinstall when preparing a runtime; a script-disabled install alone is not an RDD-compatible packaged runtime.

## Compatibility and verification limits

- Bundled envelope: Gentle Pi **4.0.0**, patched first-party `gentle_review`, Pi TUI, consent schema **v3** with `agent: pi`.
- Optional Shell variant: `scripts/orchestration/install-review-bridge.mjs` checks the exact three source hashes before installing the cooperative bridge. This variant can supply `hostSessionChoice`; matching a tool name or version label alone is insufficient. See [installation and safe session loading](agent-questions.md#compatibilidad-del-puente-con-gentle-shell). Unsupported source bytes remain local-only.
- Oversize or unsupported payloads stay in the original terminal UI; generic questions, questionnaires, editors, and selects keep their existing behavior.
- Tests use the real installed patched provider factory and Pi/Dot runner, isolated pending state/candidate views, a fake native subprocess transport, and a model stream fixture. They never invoke real native review authority.
- Runtime tests execute the generated installation hook against pristine provider source bytes, verify its result and idempotency, and reject incompatible source/version. This is not a complete release/native-binary installation test.
- The noncommitted differential probe compares pristine versus patched default local selections, formatting, inspect/assess, and local permission revocation by exact exit/stdout/stderr.
- The mobile browser fixture covers complete content, original answer values, owning-session inline presentation, popup dismissal/reopening/focus, and narrow/landscape layouts. It is **not** an installed APK, physical-phone notification, or Android background-delivery test.

## Review path

Review the dependency patch first, then `packages/daemon/src/orchestration/review-consent.ts` and the narrow `dot-session.ts` integration. For the optional three-choice Shell path, also review `review-consent-presentation.ts`, `scripts/orchestration/install-review-bridge.mjs` and `packages/daemon/test/review-bridge-install.integration.test.ts`. Check the generated runtime installation hook separately: pnpm workspace success cannot substitute for npm runtime patch application. Finally, review the real-runner negative cases and shared inline/popup fixture. No native RDD verdict or publication approval is asserted by this implementation work.
