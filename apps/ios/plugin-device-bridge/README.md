# Capri device bridge

Native iPhone services for the packaged Capri window. Credentials stay in Keychain;
requests and credentials are never logged by this plugin. Every Rust command takes
one `request` object, for example:

```ts
invoke('plugin:device-bridge|secret_get', {
  request: { scope: 'external-connections', account: connectionId }
});
```

All commands return `{ ok: boolean, error?: string, message?: string, ... }`.
Transport failures are generic and do not echo URLs, secrets or response bodies.
The native layer provides transport, storage and presentation. The conversation's
tool registry must still authorize each exact external mutation before invoking
transport. Grant `device-bridge:default` only to the packaged main window.

## Commands

| Command | Request | Successful extra fields |
| --- | --- | --- |
| `secret_get` | `scope, account` | `value?` (absent means not found) |
| `secret_set` | `scope, account, value` | `persisted: true` |
| `secret_delete` | `scope, account` | — |
| `pair_device` | `origin, code, deviceName` | `connection, persisted` |
| `unpair_device` | `origin, token?` | — |
| `https_request` | `url, method, headers, body?` | `status, body, headers` |
| `oauth_authorize` | `authorizationUrl, callbackScheme` | `callbackUrl` |
| `oauth_cancel` | `{}` | — |
| `open_external_url` | `url` (HTTPS, explicit account-setup UI only) | — |
| `registered_url_schemes` | `{}` | `schemes` (from this installed app's Info.plist) |
| `crypto_random` | `length` (1–64 bytes) | `data` (base64url, unpadded) |
| `crypto_sha256` | `data` (UTF-8 text, ≤2 MiB) | `hex` (lowercase SHA-256) |
| `crypto_hash_begin` | `{}` | `id` (ephemeral digest UUID) |
| `crypto_hash_update` | `id, data` (base64 chunk ≤256 KiB) | — |
| `crypto_hash_finish` | `id` | `hex` |
| `crypto_hash_cancel` | `id` | — |
| `export_begin` | `name, size, sha256` | `id` (private temporary file UUID) |
| `export_write` | `id, offset, data` (base64 chunk ≤256 KiB) | `written` (total bytes confirmed) |
| `export_present` | `id` | `exported, cancelled`, after the document picker delegate |
| `export_cancel` | `id` | — (idempotent cleanup/cancel) |
| `share_list` | `{}` | `items` (immutable manifests) |
| `share_read` | `id, fileId, offset, length` | `data` (standard base64) |
| `share_ack` | `id` | — |

Allowed Keychain scopes are `daemon-pairing`, `daemon-manual`, and
`external-connections`; values are at most 16 KiB UTF-8. The service name includes
the scope and exact account. Items use `WhenUnlockedThisDeviceOnly`, never sync to
iCloud, and updates preserve the old item if writing fails. Connector account IDs
are UUIDs. Paired daemon account IDs are canonical HTTPS Tailscale origins.

Pairing follows the existing daemon invitation contract and waits up to 150 seconds
for desktop approval. A successful redemption with a failed Keychain write returns
the credential in memory with `persisted: false`: save it again with
`persistPairing`; do not redeem the already used invitation again. Unpairing retains
the local credential unless the server confirms revocation (200 or 401). A manual
master token does not identify a paired mobile device.

HTTPS accepts GET/POST/PUT/PATCH/DELETE/HEAD to configurable HTTPS origins. It rejects
userinfo, fragments, common credential query parameters, unsafe headers, redirects,
request bodies over 2 MiB, and response streams over 2 MiB. Timeout is 30 seconds.
Responses must be UTF-8. Only content type, ETag, Retry-After, Link and selected rate
limit/request ID response headers cross the bridge. HTTP errors remain HTTP status
responses; only a transport failure has `ok: false`. The caller binds credentials
to the configured origin, handles provider semantics, and controls action approval.

`nativeSHA256Bytes` streams binary hashing through CryptoKit when WebCrypto is
unavailable in WKWebView. It passes 256 KiB chunks, never a complete base64-encoded
audio file. At most four incremental digest states exist; they accept up to 256 MiB
and expire after two idle minutes. Finish/cancel deletes the state. File bytes are
not retained by the hashing service. The existing `nativeSHA256Bytes` helper keeps
its 50 MiB caller limit; explicit file export uses the larger native bound.

## Native export

`exportNativeFile(blob, name, {signal?, expectedSHA256?})` in `file-export.ts`
hashes the immutable Blob in bounded chunks, then streams it to a private protected
file. Native code requires contiguous offsets, exact byte count and matching
SHA-256 before opening `UIDocumentPickerViewController(forExporting:asCopy:)`.
The user chooses the destination; there is no automatic activity/share sheet,
upload, destination bookmark or model tool. Files can be empty and at most 256 MiB.
Only one export can be active. Filenames cannot contain paths or control characters.

The helper resolves `{status:'exported',name,size,sha256}` only after
`documentPicker(_:didPickDocumentsAt:)` confirms the new copy. Cancellation resolves
`{status:'cancelled'}`; failures reject. Creating a temporary file and presenting a
picker are not success. A bridge error or missing confirmation never triggers a
second export. A concurrent cancellation cannot erase a success already confirmed
by the system. Export confirmation does not claim that a cloud provider has synced.

Temporary sources use `FileProtectionType.complete`, are excluded from backup and
removed after completion/cancellation. Incomplete transfers expire after 120 idle
seconds and are discarded on backgrounding. A visible document picker retains its
source while the user chooses a destination. Termination cleanup is best effort;
force-killed processes cannot run callbacks, so startup removes orphan sources.
The original work attachment or conversation archive remains in Capri.

Eight Node tests cover exact chunked bytes, cancellation, validation/size/hash,
missing acknowledgements, absent delegate confirmation, empty files and a success
racing cancellation. `exportFileName` provides a bounded safe suggestion for hidden,
Unicode or path-like attachment names while preserving the original stored name
and bytes. Tests simulate native replies. `check-native-sdk.sh` includes
the Swift exporter for the next Xcode build. Actual saving to local Files/iCloud,
provider errors, locking, cancellation and dismissal still need an installed iPhone.
UI consumers must await this helper; an HTML download remains a browser request,
not evidence of a native export.

References: [Apple export initializer](https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller/init(forexporting:ascopy:)),
[document picker completion](https://developer.apple.com/documentation/uikit/uidocumentpickerdelegate/documentpicker(_:didpickdocumentsat:)),
[document picker cancellation](https://developer.apple.com/documentation/uikit/uidocumentpickerdelegate/documentpickerwascancelled(_:)).

OAuth uses an ephemeral `ASWebAuthenticationSession`, one session at a time. Custom
callback schemes are accepted after syntax validation and rejection of common web
and executable schemes. The caller must validate the exact callback URL and state,
then exchange its PKCE verifier. `capri-auth` is registered by default. A Google iOS
client must be registered for the app's actual bundle identifier and its reverse
client ID callback scheme; configured schemes can be added to `CFBundleURLTypes`.
Connections in Codex do not authenticate this app.

The account setup UI can open a verified device-authorization URL with
`openExternalURL` and inspect the actual bundle callback schemes with
`registeredURLSchemes`. Navigation remains an explicit human UI action and is not
registered as a model tool. A requested OAuth callback that is absent from the
installed bundle must not be presented as configured successfully.

## Share Extension integration

After `cargo tauri ios init --ci`, run from `apps/ios`:

```sh
ruby scripts/configure-share-extension.rb
```

The script edits the generated XcodeGen spec idempotently and regenerates the
project. Run it before unsigned build signing overrides. `--spec-only` supports
configuration tests. `CAPRI_APP_GROUP` can override the default
`group.dev.gentledot.capri`; app and extension get the same entitlement and Info
property. Sources outside the generated tree remain the source of truth.

The extension receives local audio, text, photos and PDF files through
`NSItemProvider`. Text can accompany a Voice Memos recording as a separate transcript
file. It saves locally without opening the containing app or contacting a server.
Each import is an immutable schema-1 manifest with ID, creation time, title,
instructions, and file IDs/names/MIME types/sizes/SHA-256 hashes. Limits: 10 files,
25 MiB each, 50 MiB total, 100 pending imports. Files use data protection; a POSIX
lock coordinates processes; completed staging folders are atomically renamed.
Unpublished staging copies older than 24 hours can be reclaimed.

The app lists manifests, reads files in chunks up to 256 KiB, and saves the work and
attachments in one IndexedDB transaction. The native reader verifies the complete
file hash before serving the first chunk; JavaScript verifies again if WebCrypto
is available. `importSharedItem` invokes the supplied save callback with stable
`sourceId: share:<UUID>` and acknowledges only after that callback resolves. The
callback **must** deduplicate by source ID and resolve only on transaction commit.
If the app crashes after commit but before ACK, retry finds the same saved job.
If saving fails, the shared files remain. ACK is idempotent and is local import
confirmation, not host synchronization.

## Validation and remaining device evidence

`trusted-approvals.ts` is a separate human UI helper for the daemon's existing
`/api/mobile/approvals` and `/api/mobile/answer` routes. It returns immutable
snapshots, retains a private witness of their exact title/body/expiry/request ID,
and re-fetches immediately before answering. Changed content, expired requests or
changed host credentials invalidate the review. The original snapshot object must
remain in the review button's closure; a forged or reconstructed object is rejected.
A failed or ambiguous POST is not automatically retried. HTTP 403 explicitly
requires a paired device authorized by desktop; the master token is insufficient.
This helper must never be exposed as a model tool. A successful response confirms
the user's decision was received, not that the approved host operation succeeded.
The existing daemon broker keeps an active request's preview immutable and uses
unique request IDs; this client does not add a server-side fingerprint protocol.

Node tests cover invitation validation, per-host credentials, import schema/limits,
byte integrity, ACK ordering and stable retry IDs, and idempotent Xcode generation.
TypeScript and Rust check on Linux. These tests do not execute Security.framework,
ASWebAuthenticationSession, URLSession or the extension on an iPhone.

The new targets still require Xcode CI compilation. SideStore must sign and install
both targets with a working shared App Group. A successful unsigned build alone
does not prove this. If the group is unavailable, the extension and native listing
report it explicitly and the app can retain its existing Files import route.
Test Voice Memos sharing, audio plus transcript, lock/unlock, import interruption,
Keychain restoration, pairing/revocation, OAuth cancellation, and expiration of
the personal signature on the actual installed build.

Sources: [Apple extension shared-container guidance](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionScenarios.html),
[App Groups](https://developer.apple.com/documentation/xcode/configuring-app-groups),
[Keychain accessibility](https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly),
[web authentication sessions](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession),
[Tauri mobile plugins](https://v2.tauri.app/develop/plugins/develop-mobile/),
[XcodeGen specification](https://github.com/yonaskolb/XcodeGen/blob/master/Docs/ProjectSpec.md).
