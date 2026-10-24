import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { object, projectSessionWork, SessionActivity, type SessionWork } from "./activity.ts";
import { sessionWakeIdentity } from "./transcript.ts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const owner = (uid: number) => !process.getuid || uid === process.getuid();
const MAX_TRANSCRIPT = 8 * 1024 * 1024;
interface TranscriptRecords {
	signature: string;
	records: Map<string, Record<string, unknown>>;
	truncated: boolean;
}
const transcriptCache = new Map<string, TranscriptRecords>();
interface WakeLocation {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	scanOffset: number;
	location?: { offset: number; length: number };
}
const wakeLocations = new Map<string, WakeLocation>();
const signatureOf = (info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) =>
	[info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");

/** Lookup only the tiny persisted wake identity outside the bounded chat tail. Positive cache
 * entries re-read their exact owned line on append; no stale text is trusted from the cache.
 * Missing identities are scanned incrementally with fixed memory, byte and time budgets.
 */
function readWakeIdentity(
	path: string,
	sessionId: string,
	expectedSignature: string,
): Record<string, unknown> | undefined {
	const info = checkedStat(path, MAX_TRANSCRIPT, true);
	if (signatureOf(info) !== expectedSignature) return;
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || signatureOf(opened) !== expectedSignature || realpathSync(path) !== path) return;
		const key = JSON.stringify([path, sessionId]);
		const prior = wakeLocations.get(key);
		const parseIdentity = (bytes: Buffer) => {
			if (bytes.length > 4096 || !bytes.includes('"gentle-agents.wake-identity"')) return;
			try {
				const value: unknown = JSON.parse(bytes.toString("utf8"));
				if (object(value) && sessionWakeIdentity(sessionId, value)) return value;
			} catch {
				/* Not a complete, owned identity record. */
			}
		};
		const stable = () => signatureOf(fstatSync(fd)) === expectedSignature;
		const sameFile = prior?.dev === opened.dev && prior.ino === opened.ino;
		if (sameFile && prior.location) {
			const { offset, length } = prior.location;
			if (offset > 0 && length <= 4096 && offset + length < opened.size) {
				const bytes = Buffer.alloc(length + 2);
				if (
					readSync(fd, bytes, 0, bytes.length, offset - 1) === bytes.length &&
					bytes[0] === 10 &&
					bytes.at(-1) === 10
				) {
					const identity = parseIdentity(bytes.subarray(1, -1));
					if (identity && stable()) return identity;
				}
			}
		}
		// On append resume after the last complete scanned line. Rewrites/truncation restart.
		const unchanged =
			sameFile &&
			opened.size === prior.size &&
			opened.mtimeMs === prior.mtimeMs &&
			opened.ctimeMs === prior.ctimeMs;
		const resume = sameFile && !prior.location && (opened.size > prior.size || unchanged);
		if (
			sameFile &&
			!prior.location &&
			opened.size === prior.size &&
			opened.mtimeMs === prior.mtimeMs &&
			opened.ctimeMs === prior.ctimeMs &&
			prior.scanOffset >= opened.size
		)
			return;
		let position = resume ? prior.scanOffset : 0;
		let lineStart = position;
		let fragments: Buffer[] = [];
		let lineLength = 0;
		let scanned = 0;
		const chunk = Buffer.alloc(128 * 1024);
		const started = performance.now();
		const next: WakeLocation = {
			dev: opened.dev,
			ino: opened.ino,
			size: opened.size,
			mtimeMs: opened.mtimeMs,
			ctimeMs: opened.ctimeMs,
			scanOffset: position,
		};
		let found: Record<string, unknown> | undefined;
		while (position < opened.size && scanned < 64 * 1024 * 1024 && performance.now() - started < 100) {
			const count = readSync(fd, chunk, 0, Math.min(chunk.length, opened.size - position), position);
			if (!count) break;
			let start = 0;
			while (start < count) {
				const newline = chunk.indexOf(10, start);
				const end = newline >= 0 && newline < count ? newline : count;
				lineLength += end - start;
				if (lineLength <= 4096) fragments.push(Buffer.from(chunk.subarray(start, end)));
				else fragments = [];
				if (end === count) break;
				if (lineLength <= 4096) found = parseIdentity(Buffer.concat(fragments, lineLength));
				next.scanOffset = position + end + 1;
				if (found) {
					next.location = { offset: lineStart, length: lineLength };
					break;
				}
				lineStart = next.scanOffset;
				fragments = [];
				lineLength = 0;
				start = end + 1;
			}
			if (found) break;
			position += count;
			scanned += count;
		}
		if (!stable()) return;
		if (wakeLocations.size >= 16) wakeLocations.clear();
		wakeLocations.set(key, next);
		return found;
	} finally {
		closeSync(fd);
	}
}

function checkedStat(path: string, maxBytes: number, tail = false) {
	if (!isAbsolute(path) || resolve(path) !== path) throw new Error("unsafe path");
	for (let candidate = path; ; candidate = dirname(candidate)) {
		const stat = lstatSync(candidate);
		if (stat.isSymbolicLink()) throw new Error("symlink");
		if (dirname(candidate) === candidate) break;
	}
	const stat = lstatSync(path);
	if (
		!stat.isFile() ||
		stat.nlink !== 1 ||
		!owner(stat.uid) ||
		(stat.size > maxBytes && !tail) ||
		(stat.mode & 0o022) !== 0
	)
		throw new Error("unsafe file");
	return stat;
}

/** Read only owned regular files; neither path components nor the final descriptor may be links. */
function readOwned(path: string, maxBytes: number, tail = false): Buffer {
	const before = checkedStat(path, maxBytes, tail);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = fstatSync(fd);
		if (
			!opened.isFile() ||
			before.dev !== opened.dev ||
			before.ino !== opened.ino ||
			(opened.size > maxBytes && !tail) ||
			realpathSync(path) !== path
		)
			throw new Error("changed file");
		const readRange = (start: number, size: number) => {
			const bytes = Buffer.alloc(size);
			let offset = 0;
			while (offset < bytes.length) {
				const count = readSync(fd, bytes, offset, Math.min(64 * 1024, bytes.length - offset), start + offset);
				if (!count) throw new Error("incomplete file");
				offset += count;
			}
			return bytes;
		};
		let bytes: Buffer;
		if (opened.size > maxBytes) {
			const head = readRange(0, Math.min(16 * 1024, opened.size));
			const headerEnd = head.indexOf(10);
			if (headerEnd < 0) throw new Error("oversized header");
			const suffix = readRange(opened.size - maxBytes, maxBytes);
			const firstLine = suffix.indexOf(10);
			if (firstLine < 0) throw new Error("oversized transcript entry");
			bytes = Buffer.concat([head.subarray(0, headerEnd + 1), suffix.subarray(firstLine + 1)]);
		} else bytes = readRange(0, opened.size);
		const after = fstatSync(fd);
		if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs)
			throw new Error("changed file");
		return bytes;
	} finally {
		closeSync(fd);
	}
}

/** Gentle Pi's published presence is display evidence, never permission or a control channel. */
export function readLiveAgents(profile: string | undefined, sessionId: string, now = Date.now()): unknown[] {
	if (!profile || !isAbsolute(profile)) return [];
	try {
		const directory = join(profile, "gentle-agents", "presence");
		const stat = lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink() || !owner(stat.uid) || (stat.mode & 0o077) !== 0)
			return [];
		const sessionHash = hash(sessionId);
		const candidates: Array<{ name: string; header: Record<string, unknown> }> = [];
		const entries = readdirSync(directory, { withFileTypes: true });
		if (entries.length > 256) return [];
		for (const entry of entries) {
			if (
				!entry.isFile() ||
				!entry.name.startsWith(`${sessionHash}.`) ||
				!entry.name.endsWith(".header.json")
			)
				continue;
			const header: unknown = JSON.parse(readOwned(join(directory, entry.name), 16 * 1024).toString("utf8"));
			if (
				!object(header) ||
				header.schema !== 1 ||
				header.sessionHash !== sessionHash ||
				typeof header.incarnation !== "string" ||
				!/^[a-f0-9-]{36}$/.test(header.incarnation) ||
				entry.name !== `${sessionHash}.${header.incarnation}.header.json` ||
				typeof header.heartbeat !== "number" ||
				header.heartbeat > now ||
				now - header.heartbeat > 15_000 ||
				!Number.isSafeInteger(header.generation) ||
				typeof header.digest !== "string" ||
				!/^[a-f0-9]{64}$/.test(header.digest) ||
				header.unavailable !== null
			)
				continue;
			candidates.push({ name: entry.name, header });
		}
		// Two incarnations advertising the same session cannot be distinguished safely from a manifest.
		if (candidates.length !== 1) return [];
		const selected = candidates[0];
		if (!selected) return [];
		const bytes = readOwned(
			join(directory, selected.name.replace(/header\.json$/, "activity.json")),
			2 * 1024 * 1024,
		);
		if (hash(bytes) !== selected.header.digest) return [];
		const body: unknown = JSON.parse(bytes.toString("utf8"));
		if (
			!object(body) ||
			body.schema !== 1 ||
			body.sessionHash !== sessionHash ||
			body.incarnation !== selected.header.incarnation ||
			body.generation !== selected.header.generation ||
			!object(body.activity) ||
			!Array.isArray(body.activity.tasks)
		)
			return [];
		return body.activity.tasks
			.flatMap((item) => (object(item) && object(item.summary) ? [item.summary] : []))
			.filter((summary) => ["queued", "running", "waiting"].includes(String(summary.status)))
			.slice(0, 21);
	} catch {
		return [];
	}
}

export interface BoundWorkIdentity {
	sessionId: string;
	sessionFile?: string;
	cwd?: string;
}

function withLiveAgents(work: SessionWork, path: string, sessionId: string, now: number): SessionWork {
	const profile = dirname(dirname(path)).endsWith("/sessions") ? dirname(dirname(dirname(path))) : undefined;
	const live = new SessionActivity().snapshot([], readLiveAgents(profile, sessionId, now), now);
	const agents = new Map(work.agents.map((agent) => [agent.id, agent]));
	for (const agent of live.agents) {
		agents.delete(agent.id);
		agents.set(agent.id, agent);
	}
	return {
		...work,
		capturedAt: new Date(now).toISOString(),
		agents: [...agents.values()].slice(-20),
		truncated: work.truncated || live.truncated || agents.size > 20,
	};
}

export interface BoundSessionEntries {
	entries: Record<string, unknown>[];
	allEntries: Record<string, unknown>[];
	truncated: boolean;
}

/** Owned transcript evidence, anchored by this live socket's selected branch, never the last file line. */
export function readBoundSessionEntries(
	identity: BoundWorkIdentity,
	page: Record<string, unknown>,
): BoundSessionEntries | undefined {
	if (page.sessionId !== identity.sessionId) return;
	const path = identity.sessionFile;
	if (!path?.endsWith(".jsonl") || !identity.cwd) return;
	try {
		const info = checkedStat(path, MAX_TRANSCRIPT, true);
		const signature = signatureOf(info);
		const cwd = realpathSync(identity.cwd);
		const key = JSON.stringify([path, identity.sessionId, cwd]);
		let cached = transcriptCache.get(key);
		if (cached?.signature !== signature) {
			const bytes = readOwned(path, MAX_TRANSCRIPT, true);
			const lines = bytes.toString("utf8").split("\n");
			const first = lines.shift();
			if (!first || first.length > 16_384) return;
			const header: unknown = JSON.parse(first);
			if (
				!object(header) ||
				header.type !== "session" ||
				header.id !== identity.sessionId ||
				typeof header.cwd !== "string" ||
				realpathSync(header.cwd) !== cwd
			)
				return;
			const records = new Map<string, Record<string, unknown>>();
			let truncated = info.size > MAX_TRANSCRIPT;
			for (const line of lines) {
				if (!line.trim()) continue;
				if (line.length > 1024 * 1024 || records.size >= 20_000) {
					truncated = true;
					continue;
				}
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch {
					truncated = true;
					continue;
				}
				if (object(value) && typeof value.id === "string" && value.id.length <= 256) {
					if (records.has(value.id)) return; // Ambiguous identity cannot classify messages.
					records.set(value.id, value);
				}
			}
			cached = { signature, records, truncated };
			transcriptCache.delete(key);
			transcriptCache.set(key, cached);
			while (transcriptCache.size > 4) {
				const oldest = transcriptCache.keys().next().value;
				if (oldest) transcriptCache.delete(oldest);
			}
		}
		const messages = Array.isArray(page.messages) ? page.messages.filter(object) : [];
		const anchor = messages.findLast(
			(message) => typeof message.id === "string" && cached.records.has(message.id),
		)?.id;
		if (typeof anchor !== "string") return;
		const branch: Record<string, unknown>[] = [];
		const visited = new Set<string>();
		let cursor: unknown = anchor;
		let truncated = cached.truncated;
		while (typeof cursor === "string" && branch.length < 2000) {
			if (visited.has(cursor)) return;
			visited.add(cursor);
			const entry = cached.records.get(cursor);
			if (!entry) {
				truncated = true;
				break;
			}
			branch.push(entry);
			cursor = entry.parentId;
		}
		truncated ||= typeof cursor === "string";
		let allEntries = [...cached.records.values()];
		if (
			info.size > MAX_TRANSCRIPT &&
			!allEntries.some((entry) => sessionWakeIdentity(identity.sessionId, entry))
		) {
			const wake = readWakeIdentity(path, identity.sessionId, signature);
			if (wake) allEntries = [...allEntries, wake];
		}
		return { entries: branch.reverse(), allEntries, truncated };
	} catch {
		return;
	}
}

/** Only call after a socket snapshot has been bound to the live process/session by Orchestrator. */
export function boundSessionWork(
	identity: BoundWorkIdentity,
	page: Record<string, unknown>,
	now = Date.now(),
): SessionWork {
	const messages = Array.isArray(page.messages) ? page.messages.filter(object) : [];
	if (page.sessionId !== identity.sessionId) return { ...projectSessionWork([], now), truncated: true };
	const transcript = readBoundSessionEntries(identity, page);
	if (transcript && identity.sessionFile) {
		const work = projectSessionWork(transcript.entries, now);
		work.truncated ||= transcript.truncated;
		return withLiveAgents(work, identity.sessionFile, identity.sessionId, now);
	}
	const work = projectSessionWork(
		messages.map((message) => ({ type: "message", id: message.id, message })),
		now,
	);
	if (identity.sessionFile && identity.cwd) work.truncated = true;
	return work;
}
