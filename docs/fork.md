# Eduardo Garza's Gentle Dot fork

This repository keeps Gentle Dot as the application and Capri as an included, optional personalization. Upstream code and its MIT notice are retained. The upstream repository is `Gentleman-Programming/gentle-dot`; this fork is `ed-gz/gentle-dot`.

## Boundaries

| Location | Responsibility |
| --- | --- |
| `packages/protocol` | Shared messages and neutral companion presentation contracts. Themes grant no permissions. |
| `packages/daemon` | Agent, memory, connectors, session delivery and authorization. The existing computer remains the runtime. |
| `packages/ui` | Chat, settings, notification handling, companion presentation and device preferences. Compatibility entry points preserve existing imports. |
| `packages/theme-capri` | Capri artwork, animation manifests, scenes, colors, optional persona and generation provenance. |
| `apps/desktop` | Native desktop windows, system integration and local approval boundaries. |
| `apps/mobile` | Android connection, notifications, native floating companion and compact chat activity. |

Capri is disabled by default. Existing Capri users keep their appearance and persona during migration. Appearance is local to each device and can change while disconnected; the agent's persona changes only after its current runtime confirms it. The additional persona control is inside the conversation settings, not a required setup step. Sprites are already bundled: using the theme makes no image generation requests.

The theme does not change tool permissions, send messages, connect accounts or create sessions. See [`packages/theme-capri/NOTICE.md`](../packages/theme-capri/NOTICE.md) for artwork provenance and character notices. The software license does not grant ownership of Cyberpunk: Edgerunners characters or marks.

## Preserved compatibility

The Android application ID, Tauri identifier, local data directories, pairing scheme and existing preference keys remain unchanged. Updating the appearance does not erase conversations or session identities. Keep the existing Android signing certificate when building an update for an installed phone.

The first fork commit imports the previous local Android/Linux work as a historical baseline. Subsequent work units isolate theme extraction and Android presence, with their tests and documentation. This baseline is larger than a normal review unit because it preserves already developed work; it is not represented as a new small upstream change.

## Connectivity

The mobile app still pairs with the user's computer over private Tailscale HTTPS. The local companion can draw and respond to touch without the computer. Chat inference, external session control and new computer-originated notifications require that computer to be online.

A separate cloud runtime, Cloud/Claude Bridge, cloud push provider and account migration are outside this revision. No server is provisioned, no cloud credentials are required, and no background service is presented as functioning independently of the computer.

## Keeping the fork clean

Use `origin` for `ed-gz/gentle-dot` and `upstream` for `Gentleman-Programming/gentle-dot`. Review upstream changes before merging them; do not overwrite the fork with a force push. The development copy is separate from the active desktop installation.

Include source, tests, production sprites, manifests and sanitized provenance. Exclude runtime data, connector/account credentials, signing keys, private deployment notes, generated WebViews, APKs and local caches. Build installers from a specific commit; attach them as release artifacts when publishing a release rather than adding them to Git history.

## Validation

Run the relevant UI/daemon tests and TypeScript build after changing theme or persona contracts. Android changes additionally require Gradle unit tests, lint and an APK build. A successful build does not establish physical-phone overlay behavior or battery consumption; permission, lock-screen, keyboard, rotation and process-recovery checks should be recorded separately on a device.
