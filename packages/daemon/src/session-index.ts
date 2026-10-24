import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

const CHUNK_BYTES = 64 * 1024;
// A single attachment can occupy a large JSONL record; never retain the whole session.
const MAX_RECORD_BYTES = 72 * 1024 * 1024;
const CACHED_FILES = 8;

type RecordSpan = { start: number; end: number; entry: Record<string, unknown> };
export type TurnSpan = { start: number; role: "user" | "assistant" };
export type SessionIndex = {
	identity: string;
	mtimeMs: number;
	size: number;
	/** Last complete line, so a partially written record is retried on the next read. */
	offset: number;
	turns: TurnSpan[];
};
const indexes = new Map<string, SessionIndex>();

/** Stream JSONL in fixed chunks. A malformed/torn record never hides its neighbours. */
export function* sessionRecords(
	file: string,
	start = 0,
	end = statSync(file).size,
	onBoundary?: (offset: number) => void,
): Generator<RecordSpan> {
	const fd = openSync(file, "r");
	let offset = start;
	let lineStart = start;
	let parts: Buffer[] = [];
	let length = 0;
	let oversized = false;
	try {
		while (offset < end) {
			const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - offset));
			const count = readSync(fd, buffer, 0, buffer.length, offset);
			if (!count) break;
			let begin = 0;
			for (let i = 0; i < count; i++) {
				if (buffer[i] !== 10) continue;
				const part = buffer.subarray(begin, i);
				length += part.length;
				if (!oversized && length <= MAX_RECORD_BYTES) {
					parts.push(part);
					try {
						const entry: unknown = JSON.parse(Buffer.concat(parts, length).toString("utf8"));
						if (entry && typeof entry === "object" && !Array.isArray(entry))
							yield { start: lineStart, end: offset + i + 1, entry: entry as Record<string, unknown> };
					} catch {
						// The next complete line is still independently readable.
					}
				}
				parts = [];
				length = 0;
				oversized = false;
				begin = i + 1;
				lineStart = offset + begin;
			}
			if (begin < count && !oversized) {
				const part = buffer.subarray(begin, count);
				length += part.length;
				if (length > MAX_RECORD_BYTES) {
					oversized = true;
					parts = [];
				} else parts.push(part);
			}
			offset += count;
			onBoundary?.(lineStart);
		}
	} finally {
		closeSync(fd);
	}
}

/** Only offsets and roles are cached; images, tool results and full chat text are released. */
export function sessionIndex(file: string): SessionIndex {
	const stat = statSync(file);
	const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
	let index = indexes.get(file);
	if (
		!index ||
		index.identity !== identity ||
		stat.size < index.size ||
		(stat.size === index.size && stat.mtimeMs !== index.mtimeMs)
	) {
		index = { identity, size: 0, mtimeMs: 0, offset: 0, turns: [] };
	}
	if (stat.size > index.offset) {
		for (const { start, end, entry } of sessionRecords(file, index.offset, stat.size, (offset) => {
			if (index) index.offset = offset;
		})) {
			index.offset = end;
			if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
			const role = (entry.message as { role?: unknown }).role;
			if (role === "user" || (role === "assistant" && index.turns.at(-1)?.role !== "assistant"))
				index.turns.push({ start, role });
		}
	}
	index.size = stat.size;
	index.mtimeMs = stat.mtimeMs;
	indexes.delete(file);
	indexes.set(file, index);
	if (indexes.size > CACHED_FILES) indexes.delete(indexes.keys().next().value as string);
	return index;
}

/** Selected turn records, including tool results needed to reconstruct screenshot delivery. */
export function readTurnMessages(file: string, start: number, end: number): unknown[] {
	if (!existsSync(file)) return [];
	const index = sessionIndex(file);
	const from = index.turns[start]?.start;
	if (from === undefined || end <= start) return [];
	const to = index.turns[end]?.start ?? index.offset;
	const result: unknown[] = [];
	for (const { entry } of sessionRecords(file, from, to))
		if (entry.type === "message" && entry.message) result.push(entry.message);
	return result;
}
