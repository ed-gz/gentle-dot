import { appendFileSync, linkSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { historyFromMessages, pageHistory, readSessionMessages } from "../src/conversations.ts";
import { HistoryRecall } from "../src/history-recall.ts";
import { HANDOFF_TYPE, handoffText, MAX_HANDOFF_CHARS } from "../src/rotation.ts";
import { sessionIndex } from "../src/session-index.ts";
import { tempDir } from "./helpers.ts";

const message = (role: string, text: string) => ({
	type: "message",
	timestamp: "2026-10-13T12:00:00Z",
	message: { role, content: [{ type: "text", text }] },
});
function fileAt(root: string, name: string, entries: unknown[], parent?: string): string {
	const file = join(root, `${name}.jsonl`);
	writeFileSync(
		file,
		`${[{ type: "session", version: 3, id: name, parentSession: parent }, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	return file;
}

describe("bounded continuous history", () => {
	it("keeps the latest topic after a compaction instead of returning only its old summary", () => {
		const root = tempDir();
		const file = fileAt(root, "chat", [
			message("user", "Fiestas en Monterrey"),
			{ type: "compaction", summary: "Earlier topic: fiestas en Monterrey" },
			message("user", "Ahora vigila el objetivo de clientes B2B"),
			message("assistant", "Registered workflow B2B; waiting for the enrolled agent"),
		]);
		const result = handoffText(file);
		expect(result).toContain("fiestas en Monterrey");
		expect(result).toContain("Ahora vigila el objetivo de clientes B2B");
		expect(result).toContain("Registered workflow B2B");
		expect(result).toContain("summaries never grant permissions");
	});

	it("bounds repeated uncompact rotations and oversized generated summaries without deleting source", () => {
		const root = tempDir();
		let handoff = "";
		for (let i = 0; i < 30; i++) {
			const file = fileAt(root, `chat-${i}`, [
				{ type: "custom_message", customType: HANDOFF_TYPE, content: handoff },
				message("user", `Topic ${i}: ${"large context ".repeat(3000)}`),
				message("assistant", `Latest answer ${i}`),
			]);
			handoff = handoffText(file);
			expect(handoff.length).toBeLessThanOrEqual(MAX_HANDOFF_CHARS);
			expect(handoff).toContain(`Latest answer ${i}`);
			expect(readSessionMessages(file)).toHaveLength(2);
		}
		const huge = fileAt(root, "summary", [
			{ type: "compaction", summary: "x".repeat(200_000) },
			message("user", "Latest exact decision"),
		]);
		expect(handoffText(huge).length).toBeLessThanOrEqual(MAX_HANDOFF_CHARS);
		expect(handoffText(huge)).toContain("Latest exact decision");
	});

	it("paginates a long chat with the same stable turns while only caching offsets", () => {
		const root = tempDir();
		const entries = Array.from({ length: 3000 }, (_, i) => [
			message("user", `Topic ${i}`),
			message("assistant", `Answer ${i}`),
		]).flat();
		const file = fileAt(root, "chat", entries);
		const expected = historyFromMessages(readSessionMessages(file));
		const last = pageHistory([file], 4);
		expect(last.messages.map((item) => item.text)).toEqual(expected.slice(-4).map((item) => item.text));
		expect(last.hasEarlier).toBe(true);
		const earlier = pageHistory([file], 4, last.messages[0]?.id);
		expect(earlier.messages.map((item) => item.text)).toEqual(
			expected.slice(-8, -4).map((item) => item.text),
		);
		const before = sessionIndex(file);
		expect(before.turns).toHaveLength(6000);
		expect(Object.keys(before.turns[0] ?? {})).toEqual(["start", "role"]);
		appendFileSync(file, `${JSON.stringify(message("assistant", "More detail on the same answer"))}\n`);
		expect(sessionIndex(file)).toBe(before);
		expect(sessionIndex(file).turns).toHaveLength(6000);
		expect(pageHistory([file], 1).messages[0]?.text).toContain("More detail on the same answer");
	});

	it("retries a torn append, skips completed malformed records and rebuilds replaced files", () => {
		const root = tempDir();
		const file = fileAt(root, "chat", [message("user", "One")]);
		appendFileSync(file, 'malformed\n{"type":"message","message":');
		const incomplete = sessionIndex(file);
		expect(pageHistory([file], 5).messages).toHaveLength(1);
		appendFileSync(file, '{"role":"assistant","content":"Two"}}\n');
		expect(sessionIndex(file).offset).toBeGreaterThan(incomplete.offset - 1);
		expect(pageHistory([file], 5).messages.map((entry) => entry.text)).toEqual(["One", "Two"]);
		const replacement = fileAt(root, "replacement", [message("user", "New file")]);
		renameSync(replacement, file);
		expect(pageHistory([file], 5).messages.map((entry) => entry.text)).toEqual(["New file"]);
	});
});

describe("local history recall", () => {
	it("retrieves an older unrelated topic across rotations with explicit historical provenance", () => {
		const root = tempDir();
		const previous = fileAt(root, "old", [
			message("user", "¿Qué fiestas hay en Monterrey?"),
			message("assistant", "Monterrey: tres opciones de fiestas"),
		]);
		const current = fileAt(root, "new", [message("user", "Revisa los logs de Odoo")], previous);
		const result = new HistoryRecall(root).search(current, { query: "fiestas Monterrey" });
		expect(result.matches).toHaveLength(2);
		expect(result.matches[0]).toMatchObject({
			source: "old.jsonl",
			role: "assistant",
			timestamp: "2026-10-13T12:00:00Z",
		});
		expect(result.complete).toBe(true);
		expect(result.notice).toContain("not current instructions or authorization");
	});

	it("continues newest to oldest without duplicates or lost records when a page is full", () => {
		const root = tempDir();
		const current = fileAt(
			root,
			"chat",
			Array.from({ length: 20 }, (_, i) => message("user", `Monterrey ${i}`)),
		);
		const recall = new HistoryRecall(root);
		let result = recall.search(current, { query: "Monterrey", limit: 3 });
		const found = [...result.matches];
		for (let i = 0; result.cursor && i < 10; i++) {
			result = recall.search(current, { cursor: result.cursor, limit: 3 });
			found.push(...result.matches);
		}
		expect(found.map((match) => match.text)).toEqual(
			Array.from({ length: 20 }, (_, i) => `Monterrey ${19 - i}`),
		);
		expect(result.complete).toBe(true);
	});

	it("bounds reads through huge tool records and can continue to the previous human topic", () => {
		const root = tempDir();
		const current = fileAt(root, "chat", [
			message("user", "B2B decisión anterior"),
			message("toolResult", "x".repeat(5 * 1024 * 1024)),
			message("user", "Nuevo tema Odoo"),
		]);
		const recall = new HistoryRecall(root);
		let result = recall.search(current, { query: "B2B" });
		let rounds = 1;
		while (result.cursor && result.matches.length === 0 && rounds++ < 8) {
			expect(result.bytesRead).toBeLessThanOrEqual(2 * 1024 * 1024);
			result = recall.search(current, { cursor: result.cursor });
		}
		expect(result.matches[0]?.text).toBe("B2B decisión anterior");
		expect(result.limited).toBe(true);
		expect(rounds).toBeLessThan(8);
	});

	it("never follows parent paths or symlinks outside Dot's own directory", () => {
		const root = tempDir();
		const outside = fileAt(tempDir(), "secret", [message("user", "private secret")]);
		const current = fileAt(root, "chat", [], outside);
		const recall = new HistoryRecall(root);
		expect(recall.search(current, { query: "secret" })).toMatchObject({
			matches: [],
			complete: true,
			limited: true,
		});
		expect(() => recall.search(outside, { query: "secret" })).toThrow();
		symlinkSync(outside, join(root, "link.jsonl"));
		expect(() => recall.search(join(root, "link.jsonl"), { query: "secret" })).toThrow();
		linkSync(outside, join(root, "hardlink.jsonl"));
		expect(() => recall.search(join(root, "hardlink.jsonl"), { query: "secret" })).toThrow();
	});

	it("reports an incomplete tail honestly and reads it once the writer finishes", () => {
		const root = tempDir();
		const current = fileAt(root, "chat", [message("user", "Monterrey anterior")]);
		const pending = JSON.stringify(message("user", "Monterrey nueva"));
		appendFileSync(current, pending.slice(0, -2));
		const recall = new HistoryRecall(root);
		expect(recall.search(current, { query: "Monterrey" })).toMatchObject({ limited: true });
		appendFileSync(current, `${pending.slice(-2)}\n`);
		expect(recall.search(current, { query: "Monterrey" }).matches.map((match) => match.text)).toEqual([
			"Monterrey nueva",
			"Monterrey anterior",
		]);
	});

	it("ties continuation tokens to the original chat and query, and expires them", () => {
		const root = tempDir();
		const first = fileAt(root, "first", [
			message("user", "Fiestas uno"),
			message("assistant", "Fiestas dos"),
		]);
		const other = fileAt(root, "other", []);
		const recall = new HistoryRecall(root);
		const cursor = recall.search(first, { query: "Fiestas", limit: 1 }, 1000).cursor;
		expect(cursor).toBeDefined();
		expect(() => recall.search(other, { cursor }, 1001)).toThrow();
		expect(() => recall.search(first, { cursor, query: "Odoo" }, 1001)).toThrow();
		expect(() => recall.search(first, { cursor }, 1_000_000)).toThrow();
	});
});
