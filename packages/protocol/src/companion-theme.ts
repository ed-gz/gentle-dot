/** Presentation only: a theme cannot add tools, authority, accounts or network access. */
export interface CompanionThemeManifest {
	version: 1;
	id: string;
	name: string;
	description: string;
	defaultEnabled: false;
	personaId?: string;
	style?: string;
	animationSheets: readonly { manifest: string; image: string }[];
	staticSheets: readonly { manifest: string; image: string }[];
}

/** Coarse local UI events. Draft and message contents never belong in this contract. */
export type CompanionActivityKind =
	| "rest"
	| "greeting"
	| "typing"
	| "reading"
	| "response"
	| "sending"
	| "submitted"
	| "queued"
	| "failed";

/** Stable built-in preference IDs; appearance and agent identity are independent. */
export type CompanionMode = "gentle" | "capri";
export const DEFAULT_COMPANION_MODE: CompanionMode = "gentle";
export function isCompanionMode(value: unknown): value is CompanionMode {
	return value === "gentle" || value === "capri";
}
