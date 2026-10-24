# Send files to an exact agent session

Agent-session attachments use Dot’s authenticated upload endpoint and upload limits, then deliver real bytes to the bound Pi runner. Images become structured image content when the selected model supports images. Uploaded audio is an ordinary file, **not** recording, transcription, or native audio understanding.

## Quick path

1. Open **Sesiones**, select a connected session, and tap the **clip icon** in the shared Dot composer.
2. Select documents, images, or audio files. Add optional text and send, or send attachments alone.
3. The adapter saves files in a new private `.dot-attachments-*` directory inside that session’s working directory. The request submitted to the Pi SDK includes their real filenames, types, sizes, and paths. Supported images up to Dot’s 3,750,000-byte image ceiling also arrive as actual image content.

The shared composer omits the clip when the destination cannot accept attachments. Prompt-capable text-only sessions still offer dictation through Dot's existing voice input. Native Android speech produces editable text and always requires manual Send in an agent session; it is not an uploaded audio message or a new recording backend. Agent input never sends Dot chat/abort/TTS actions or changes Dot's send-on-stop preference. Upload failures retain a removable file error. Cancellation or navigation before dispatch does not send a prompt; cancellation cannot retract a prompt already accepted by Pi.

## Capability map

Display providers are not model capabilities. HERDR, Orca, and terminal sessions may advertise attachments **only through the updated, bound, managed Pi adapter**. No attachment capability is inferred from a display provider’s name, metadata peer, or text-prompt support.

| Destination | Behavior |
|---|---|
| Updated managed Pi, text-capable model, active `read` tool | Ordinary file/document attachments; optional user text |
| Same adapter, model declares image input | Native image content up to Dot’s image ceiling |
| Image above native image ceiling | Explicit file-only fallback, matching Dot; prompt tells the model it must read the path |
| Model without image input | Image submission rejected explicitly before destination materialization or ref consumption |
| Audio upload | Ordinary file path/document semantics; upload MIME sniffing generally yields `application/octet-stream` |
| Legacy adapter, text-only remote API, unbound pane, or no active `read` tool | Explicit unsupported-attachment rejection; existing text prompts still work |
| VPS mode without local session control | Agent attachments unavailable; ordinary Dot uploads unchanged |

A file path makes bytes available to tools; it does not promise the model can decode every binary document or audio format. This feature does not add API-level audio support to any provider.

## Risk item 2 — authentication and uploads

- `POST /upload` retains Bearer authentication, Origin restrictions, streaming validation, sniffed MIME, safe filenames, and Dot’s shared limits: 10 files, 25 MiB per file, 50 MiB per message.
- Agent uploads add `X-Agent-Pane` and `X-Agent-Session`. The daemon verifies the live destination and native capability before storing upload bytes.
- Agent batches have a nonpublic owner hash binding the authenticating device token, pane, session, and adapter instance. Cross-device/session joins, ordinary-Dot/agent joins, and ownership mismatches are rejected.
- Browser prompt bodies contain only existing typed `{ uploadId, name }` references. Client paths, URLs, and extra reference fields are rejected; nothing fetches a URL.
- Only in-memory UploadStore records resolve references. Agent reads reject followed file links and changed size/nonregular files. Native delivery contains bounded base64 bytes, not a client-supplied source path.
- Ordinary Dot records remain unscoped and retain their existing resolution behavior. Agent expiry checks do not invalidate legacy ordinary-Dot records.

## Risk item 4 — session lifecycle and replay

- Dispatch preserves existing source authorization, pane serialization, exact session/instance request and acknowledgement checks, RDD consent, pending-question, and shutdown guards.
- File-state ownership is keyed only by client epoch and pane/session. Availability, operation errors and hiding the view do not remount the same owner's composer; ready files and the draft survive rejected submissions and same-owner navigation.
- Capture and pre-dispatch cancellation use separate lifetime checks. Dictation is input-only; pending native results and microphone permission promises are invalidated on view/client/session/disconnect/unmount, not document visibility (Android Speech Activity temporarily hides the main activity).
- A matching accepted acknowledgement clears the mounted owner's submitted files and draft even if the view became hidden or disconnected. Rejection retains them for retry without another upload. An acknowledgement from an old client/pane/session cannot clear a new owner's state.
- Navigation can abort in-flight work before dispatch; disconnect/cancel state is checked again at that boundary. A synchronous submit lock prevents duplicate submissions.
- Capabilities are rechecked before dispatch and inside the runner. Native validation of the complete envelope happens before destination directories/files are created. Attachment IPC rechecks device/HTTP authorization after its byte payload drains and before sending the final line delimiter; an interrupted or revoked transfer cannot dispatch an unterminated payload.
- Native delivery IDs and per-file tokens deduplicate a lost acknowledgement and reject reordered/partial replay. Rejected dispatches do not consume upload refs; only an exact accepted acknowledgement consumes them. An ambiguous network error is never automatically retried.
- Native replay tracking is bounded to 100,000 file tokens per adapter lifecycle and fails closed rather than evicting replay protection. Session replacement gets a new instance/ownership identity.
- Materialization uses exclusive private directories and files under the canonical live session cwd. There is no global-directory fallback. Successful files remain available to the session, like ordinary Dot files.

### Acknowledgement boundary

An exact accepted native acknowledgement confirms submission to Pi's SDK with the matching session and delivery IDs. The SDK's `sendUserMessage()` API is fire-and-forget: this acknowledgement is **not** durable queue/transcript acceptance, provider success, or proof that a model processed the files.

Asynchronous SDK preflight, authentication, compaction, or input-hook failures can occur after acknowledgement. In that case private destination copies may remain and the upload references may already have been consumed. This feature does not claim atomic rollback or reference retention for every downstream SDK failure. Ambiguous outcomes are not retried automatically; they require an explicit user retry.

### Bounded local transport

Only attachment prompts may exceed the prior 128 KiB local-request envelope. Their absolute encoded ceiling is `ceil(50 MiB / 3) * 4 + 128 KiB`; decoded count, per-file size, aggregate size, canonical base64, name, MIME, and field shape are independently validated. Other local operations retain the 128 KiB envelope check. Socket buffering accumulates bounded chunks rather than repeatedly copying the growing message. This is a local private-socket protocol, not an unauthenticated HTTP bytes endpoint.

## Verification and limits

`packages/daemon/test/agent-attachments.integration.test.ts` runs the actual installed Pi session/extension/queue/provider-stream path with isolated fixture state. Authenticated HTTP uploads deliver `photo.jpg`, `report.txt`, and `voice.wav` into the exact native session cwd; assertions compare saved bytes and verify actual image content in the model request. It also exercises attachment-only payloads above the former 128 KiB envelope, literal text prompts, ownership, replay, malformed refs, capability rejection, and disconnects.

The provider stream is an offline deterministic fixture: **no live model, network credentials, transcription, native audio understanding, Android device approval, or native review approval was exercised**. Existing RDD handlers and runtime patch/install integrity hooks are not modified by this feature.

`e2e/mobile-agent-attachments.mobile.ts` exercises the mobile shell’s visible session navigation, real file chooser, upload request, attachment-only submit, and portrait/landscape layout against an explicit HTTP fixture. It complements, but does not replace, the actual Pi runtime integration test.

A noncommitted public differential probe lives in `.cache/chat-attachments-and-usage/agents/`. It compares captured pre-edit sources with the implementation: ordinary authenticated upload HTTP status/body, plain-text native prompts, and ordinary audio-file prompt effects are identical after normalizing only random upload/workspace identifiers. No git-history test is added.
