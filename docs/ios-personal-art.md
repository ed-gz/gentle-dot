# Personal Capri artwork in the iPhone installation

The first installed shell had the 2D engine but no bundled PNG. Its startup only read IndexedDB, so a new installation displayed an empty placeholder until someone imported artwork. The personal build now carries the exact desktop `capri-full.png` (240 × 420, 73,947 bytes, SHA-256 `7df28bdd6a264307d3a25bafaf12c2bba308d5aecd2dc03dcc9b176109f21aeb`). It uses the existing `createEngine`, director and effects; it does not substitute sprites or generated character art.

`loadPackagedArtwork()` reads only app-relative files, validates manifest, length, PNG dimensions and SHA-256, and returns the original Blob. WebCrypto has a native CryptoKit fallback for WKWebView. The UI prefers a saved personal override and otherwise uses the packaged image. Removing an override restores the package default. An invalid declared image is an error; a generic source build with no manifest returns `undefined` and must not claim that Capri is loaded. No IndexedDB write or network access is needed for the default character.

## Private build provenance

The source repository is public. GitHub permits signed-in users with repository read access to download its Actions artifacts, so public Actions output is unsuitable for the personal image. The companion `ed-gz/capri-ios-personal` repository is private. Only build workflow code is committed there. The PNG is a private release asset, outside Git history. [GitHub artifact access](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts?tool=webui)

The source-controlled `.github/workflows/ios-personal.yml` template runs only in a private repository, checks out an exact 40-character source commit from `ed-gz/gentle-dot`, and downloads a fixed release asset ID with the job's existing ephemeral `github.token`. `personal-art.mjs` independently verifies repository privacy, asset metadata, SHA-256, PNG CRCs and decoded size before staging `apps/ios/public/personal-art/`. That directory is ignored by Git. A generic IPA build refuses any staged personal-art directory unless the personal SHA-256 gate is enabled; it does not delete the image. No new credential or artwork bytes are printed.

Preparation is idempotent and does **not** dispatch a build:

```sh
node apps/ios/scripts/prepare-personal-build.mjs ed-gz/capri-ios-personal \
  .cache/ios-download/capri-full.png \
  7df28bdd6a264307d3a25bafaf12c2bba308d5aecd2dc03dcc9b176109f21aeb
```

The provisioned private asset ID is `684027866`. After the integrated source has been committed, pushed and reviewed, dispatch `ios-personal.yml` in that private repository with `source_sha`, `artwork_asset_id`, and `artwork_sha256`. This is separate from the generic public workflow. Private Actions uses the account's included runner allowance; this design does not purchase infrastructure or increase a spending limit.

## Checks and remaining device evidence

`CAPRI_PERSONAL_ART_SHA256` makes the build fail if either the staged input or production Vite output lacks the exact PNG/manifest. XcodeGen additionally copies the same folder into the application resources. `verify-ipa.py --personal-art-sha256 SHA` checks that resource's bytes and manifest inside both the initial and finally sealed IPA, in addition to the existing native frameworks and Share Extension checks. Folder references and the resources build phase use XcodeGen's documented configuration. [XcodeGen source configuration](https://github.com/yonaskolb/XcodeGen/blob/master/Docs/ProjectSpec.md#target-source)

Ten dedicated Node tests exercise first-run loading without IndexedDB, byte preservation, missing/corrupt assets, size/path checks, cancellation, secure hash injection, private-download rejection, deterministic PNG validation, idempotent Xcode resources, accidental generic build rejection, and actual ZIP verification. Generic packaging fixtures remain independent of a private job's environment. These checks do not replace building the new IPA or observing the character on the iPhone after installation.

Vite also embeds a small build stamp from the actual checkout's `git rev-parse HEAD`, validates it against the private workflow's `CAPRI_SOURCE_SHA`, records whether there are local changes, and includes the verified artwork fingerprint. `build-info.ts` exports the read-only information and `buildLabel()` for Settings. It deliberately does not use `GITHUB_SHA`, which identifies the companion workflow repository during a private build. Two additional tests check source identity, dirty state, mismatches and the human-readable label.
