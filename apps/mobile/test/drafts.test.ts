import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ readDraft: vi.fn(), saveDraft: vi.fn() }));
vi.mock("@capacitor/core", () => ({ registerPlugin: () => native }));

import { readMobileDraft, saveMobileDraft } from "../src/drafts.ts";

beforeEach(() => {
	vi.clearAllMocks();
	native.readDraft.mockResolvedValue({ text: "Saved", revision: "r1" });
	native.saveDraft.mockResolvedValue({ text: "Next", revision: "r2", applied: true });
});
it("delegates identity-scoped text to the shared native encrypted store", async () => {
	expect(await readMobileDraft("device/conversation")).toEqual({ text: "Saved", revision: "r1" });
	expect(native.readDraft).toHaveBeenCalledExactlyOnceWith({ scope: "device/conversation" });
	expect(await saveMobileDraft("device/conversation", "Next", "r1")).toEqual({
		text: "Next",
		revision: "r2",
		applied: true,
	});
	expect(native.saveDraft).toHaveBeenCalledExactlyOnceWith({
		scope: "device/conversation",
		text: "Next",
		expectedRevision: "r1",
	});
});
it("returns conflicts unchanged so a stale WebView cannot silently overwrite a newer draft", async () => {
	native.saveDraft.mockResolvedValueOnce({ text: "", revision: "sent-tombstone", applied: false });
	expect(await saveMobileDraft("scope", "Old text", "old-revision")).toEqual({
		text: "",
		revision: "sent-tombstone",
		applied: false,
	});
});
it("bounds multibyte text and rejects invalid scopes before crossing the native bridge", async () => {
	await expect(saveMobileDraft("scope", "🦋".repeat(20000), "r1")).rejects.toThrow("64 KiB");
	await expect(readMobileDraft("")).rejects.toThrow("Identidad");
	expect(native.saveDraft).not.toHaveBeenCalled();
	expect(native.readDraft).not.toHaveBeenCalled();
});
