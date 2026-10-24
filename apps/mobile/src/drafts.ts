import { registerPlugin } from "@capacitor/core";

export interface MobileDraftSnapshot {
	text: string;
	revision: string;
}
export interface MobileDraftResult extends MobileDraftSnapshot {
	applied: boolean;
}
interface NativeDraftStore {
	readDraft(options: { scope: string }): Promise<MobileDraftSnapshot>;
	saveDraft(options: { scope: string; text: string; expectedRevision: string }): Promise<MobileDraftResult>;
}
const store = registerPlugin<NativeDraftStore>("GentleMobile");
function validateScope(scope: string) {
	if (!scope || scope.length > 4096) throw new Error("Identidad de borrador no válida.");
}
export async function readMobileDraft(scope: string): Promise<MobileDraftSnapshot> {
	validateScope(scope);
	return store.readDraft({ scope });
}
export async function saveMobileDraft(
	scope: string,
	text: string,
	expectedRevision: string,
): Promise<MobileDraftResult> {
	validateScope(scope);
	if (new TextEncoder().encode(text).byteLength > 64 * 1024)
		throw new Error("El borrador supera el límite local de 64 KiB.");
	return store.saveDraft({ scope, text, expectedRevision });
}
