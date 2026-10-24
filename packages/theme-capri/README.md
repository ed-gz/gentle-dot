# Optional Capri theme

Gentle Dot supplies the assistant, conversations, permissions, notifications, device connections and companion rendering. This package supplies Eduardo Garza's Capri appearance: colors, sprites, scene selection and an optional conversational persona.

The theme is bundled so it works offline. It is off on a fresh installation. Existing installations keep their saved `gentle-dot-companion-v1` appearance, position, movement and visibility preferences. Appearance can be selected without a connected agent; conversational persona is a separate setting, confirmed by the agent before it is shown as active.

## Contents

- `manifest.json`: portable inventory for web and native renderers; all paths are relative to this package.
- `src/assets/`: production transparent PNG atlases and measured frame manifests.
- `src/art.ts`, `src/animation.ts`: stable pose/action mappings used by the renderer.
- `src/scenes.ts`: contextual visual choices; no message text or credentials.
- `src/style.css`: scoped colors and companion presentation.
- `src/persona.ts`: optional name and conversational style. It does not replace operational rules or enable tools.
- `provenance/`, `NOTICE.md`: generation records and character provenance.

The UI keeps small compatibility exports at its former `capri-art.ts`, `capri-animation.ts` and `capri-scenes.ts` paths. New integrations should consume this package and the neutral `CompanionThemeManifest` contract from `@gentle-dot/protocol`. Android can copy files enumerated by the manifest into its packaged assets without creating a second artwork source.

No account IDs, tokens, pairing information, session data or downloaded reference screenshots belong in this package. Adding another theme should not require changing assistant permissions, message delivery or notification acknowledgement logic.
