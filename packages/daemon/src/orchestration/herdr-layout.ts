import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { join } from "node:path";
import { terminalProcessTree } from "../terminal-mood.ts";
import { type CellRect, cellRect } from "./editor-geometry.ts";
import { record } from "./herdr.ts";
import { processIdentity } from "./process-identity.ts";
export interface HerdrLayout {
	clientPid: number;
	processIdentity: string;
	kittyWindowId: number;
	herdrSocketPath: string;
	columns: number;
	rows: number;
	observedAt: string;
	innerRect: CellRect;
	paneId: string;
}
export function parseHerdrLayout(value: unknown, paneId: string, now = Date.now()): HerdrLayout | undefined {
	if (
		!record(value) ||
		value.version !== 1 ||
		value.available !== true ||
		value.overlayActive !== false ||
		value.outerFocused === false ||
		value.focusedPaneId !== paneId ||
		!Array.isArray(value.panes) ||
		value.panes.length > 128
	)
		return;
	const age = typeof value.observedAt === "string" ? now - Date.parse(value.observedAt) : NaN;
	if (
		!Number.isFinite(age) ||
		age < -500 ||
		age > 2500 ||
		!Number.isSafeInteger(value.revision) ||
		(value.revision as number) < 0
	)
		return;
	if (
		![value.clientPid, value.kittyWindowId, value.columns, value.rows].every(
			(v) => Number.isSafeInteger(v) && (v as number) > 0,
		) ||
		Number(value.columns) > 10000 ||
		Number(value.rows) > 10000 ||
		typeof value.processIdentity !== "string" ||
		typeof value.herdrSocketPath !== "string"
	)
		return;
	const panes = value.panes.filter(record).filter((p) => p.paneId === paneId);
	if (panes.length !== 1) return;
	const pane = panes[0];
	if (pane?.endpoint !== "local" || pane.scrollOffset !== 0) return;
	const innerRect = cellRect(pane.innerRect);
	if (
		!innerRect ||
		innerRect.x + innerRect.width > Number(value.columns) ||
		innerRect.y + innerRect.height > Number(value.rows)
	)
		return;
	return {
		clientPid: Number(value.clientPid),
		processIdentity: value.processIdentity,
		kittyWindowId: Number(value.kittyWindowId),
		herdrSocketPath: value.herdrSocketPath,
		columns: Number(value.columns),
		rows: Number(value.rows),
		observedAt: value.observedAt as string,
		innerRect,
		paneId,
	};
}
/** Optional client report: exact presented layout only, never screenshots or terminal contents. */
export async function readHerdrLayout(
	kittyPid: number,
	paneId: string,
	socketPath: string,
	host: { directory?: string; identity?: typeof processIdentity; tree?: typeof terminalProcessTree } = {},
): Promise<HerdrLayout | undefined> {
	const root = process.env.XDG_RUNTIME_DIR;
	if (!root && !host.directory) return;
	const dir = host.directory ?? join(root as string, "gentle-dot", "herdr-layout");
	try {
		const directory = lstatSync(dir),
			uid = process.getuid?.();
		if (
			!directory.isDirectory() ||
			directory.isSymbolicLink() ||
			directory.uid !== uid ||
			(directory.mode & 0o077) !== 0
		)
			return;
		const files = readdirSync(dir).filter((name) => /^[1-9]\d*\.json$/.test(name));
		if (files.length > 64) return;
		const matches: HerdrLayout[] = [];
		for (const file of files) {
			let fd: number | undefined;
			try {
				const path = join(dir, file);
				fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				const stat = fstatSync(fd);
				if (
					!stat.isFile() ||
					stat.isSymbolicLink() ||
					stat.uid !== uid ||
					(stat.mode & 0o077) !== 0 ||
					stat.size > 65536
				)
					continue;
				const report = parseHerdrLayout(JSON.parse(readFileSync(fd, "utf8")), paneId);
				if (
					!report ||
					file !== `${report.clientPid}.json` ||
					realpathSync(report.herdrSocketPath) !== realpathSync(socketPath)
				)
					continue;
				if ((await (host.identity ?? processIdentity)(report.clientPid)) !== report.processIdentity) continue;
				const tree = (host.tree ?? terminalProcessTree)(report.clientPid);
				if (
					tree.names[0] !== "herdr" ||
					tree.kittyPid !== kittyPid ||
					tree.windowId !== report.kittyWindowId ||
					!tree.pids.includes(kittyPid)
				)
					continue;
				matches.push(report);
			} catch {
				/* A dead client or malformed sibling does not invalidate other clients. */
			} finally {
				if (fd !== undefined) closeSync(fd);
			}
		}
		return matches.length === 1 ? matches[0] : undefined;
	} catch {
		return;
	}
}
