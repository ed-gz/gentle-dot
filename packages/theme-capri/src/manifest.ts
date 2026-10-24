import type { CompanionThemeManifest } from "@gentle-dot/protocol";
import manifest from "../manifest.json" with { type: "json" };

/** Bundled artwork is available offline, but activation is an explicit local preference. */
export const CAPRI_THEME: CompanionThemeManifest = { ...manifest, version: 1, defaultEnabled: false };
