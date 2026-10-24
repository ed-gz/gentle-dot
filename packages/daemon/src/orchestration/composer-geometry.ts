import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { type TerminalMoodController, terminalProcessTree } from "../terminal-mood.ts";
import type { CompanionContextSnapshot } from "./companion-context.ts";
import { type EditorGeometry, parseEditorGeometry } from "./editor-geometry.ts";
import { record } from "./herdr.ts";
import { type HerdrLayout, readHerdrLayout } from "./herdr-layout.ts";
export interface ComposerTarget {
	x: number;
	y: number;
	width: number;
	height: number;
	kind: "editor" | "cursor";
	verified: true;
	observedAt: string;
}
/** Exact numeric transform of Kitty's real viewport. Never infer padding, borders or mux origin. */
export function projectComposer(
	raw: unknown,
	windows: unknown,
	active: unknown,
	kittyPid: number,
	shared: boolean,
	editor?: EditorGeometry,
	now = Date.now(),
	herdr?: HerdrLayout,
): ComposerTarget | null {
	if (
		!record(raw) ||
		raw.active !== true ||
		raw.focused !== true ||
		!Array.isArray(windows) ||
		!record(active)
	)
		return null;
	const matches = windows
		.filter(record)
		.filter((w) => w.pid === kittyPid && w.mapped === true && w.hidden !== true);
	if (matches.length !== 1) return null;
	const w = matches[0];
	if (!w) return null;
	if (w.address !== active.address || w.pid !== active.pid || !Array.isArray(w.at) || !Array.isArray(w.size))
		return null;
	const [x, y] = w.at,
		[width, height] = w.size;
	if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
	const fields = [
		"viewportWidth",
		"viewportHeight",
		"cellWidth",
		"cellHeight",
		"columns",
		"rows",
		"left",
		"top",
		"cursorX",
		"cursorY",
	] as const;
	if (
		!fields.every((k) => Number.isInteger(raw[k]) && (raw[k] as number) >= 0 && (raw[k] as number) <= 50000)
	)
		return null;
	const g = raw as Record<(typeof fields)[number], number>;
	if (
		!g.viewportWidth ||
		!g.viewportHeight ||
		!g.cellWidth ||
		!g.cellHeight ||
		!g.columns ||
		!g.rows ||
		g.left + g.columns * g.cellWidth > g.viewportWidth ||
		g.top + g.rows * g.cellHeight > g.viewportHeight
	)
		return null;
	const sx = width / g.viewportWidth,
		sy = height / g.viewportHeight;
	if (Math.abs(sx - sy) > 0.02 || sx < 0.25 || sx > 4) return null;
	const measured = parseEditorGeometry(editor, now);
	const directEditor =
		!shared && measured && measured.columns === g.columns && measured.rows === g.rows
			? measured.rect
			: undefined;
	const reportAge = herdr ? now - Date.parse(herdr.observedAt) : NaN;
	const herdrEditor =
		herdr &&
		measured &&
		reportAge >= -500 &&
		reportAge <= 2500 &&
		herdr.columns === g.columns &&
		herdr.rows === g.rows &&
		measured.columns === herdr.innerRect.width &&
		measured.rows === herdr.innerRect.height
			? { ...measured.rect, x: herdr.innerRect.x + measured.rect.x, y: herdr.innerRect.y + measured.rect.y }
			: undefined;
	const realEditor = directEditor ?? herdrEditor;
	if (!realEditor && (raw.cursorVisible !== true || g.cursorX >= g.columns || g.cursorY >= g.rows))
		return null;
	const r = realEditor ?? { x: g.cursorX, y: g.cursorY, width: 1, height: 1 };
	return {
		x: x + (g.left + r.x * g.cellWidth) * sx,
		y: y + (g.top + r.y * g.cellHeight) * sy,
		width: r.width * g.cellWidth * sx,
		height: r.height * g.cellHeight * sy,
		kind: realEditor ? "editor" : "cursor",
		verified: true,
		observedAt: new Date(now).toISOString(),
	};
}
const hypr = (kind: "clients" | "activewindow"): Promise<unknown> =>
	new Promise((resolve, reject) =>
		execFile("hyprctl", ["-j", kind], { timeout: 700, maxBuffer: 1024 * 1024 }, (error, stdout) => {
			if (error) reject(error);
			else
				try {
					resolve(JSON.parse(stdout));
				} catch (e) {
					reject(e);
				}
		}),
	);
/** Queried only by an authorized local context consumer; one focused target, bounded cadence. */
export class ComposerGeometry {
	private cache?: { key: string; at: number; target: ComposerTarget | null };
	private pending?: Promise<ComposerTarget | null>;
	private candidateCache?: { key: string; at: number; pids: Set<number> };
	private readonly terminal: Pick<TerminalMoodController, "geometry">;
	private readonly bindings: () => {
		paneId: string;
		sessionId: string;
		pid: number;
		herdrSocketPath?: string;
	}[];
	private readonly observe: (paneId: string | undefined) => void;
	constructor(
		terminal: Pick<TerminalMoodController, "geometry">,
		bindings: () => { paneId: string; sessionId: string; pid: number; herdrSocketPath?: string }[] = () => [],
		observe: (paneId: string | undefined) => void = () => {},
	) {
		this.terminal = terminal;
		this.bindings = bindings;
		this.observe = observe;
	}
	async enrich(
		snapshot: CompanionContextSnapshot,
		authorize: () => boolean,
	): Promise<CompanionContextSnapshot> {
		if (snapshot.stale || !authorize()) return snapshot;
		let active: unknown;
		try {
			active = await hypr("activewindow");
		} catch {
			this.observe(undefined);
			return snapshot;
		}
		if (!record(active) || !Number.isInteger(active.pid)) {
			this.observe(undefined);
			return snapshot;
		}
		const activePid = Number(active.pid);
		try {
			if (readFileSync(`/proc/${activePid}/comm`, "utf8").trim() !== "kitty") {
				this.observe(undefined);
				return snapshot;
			}
		} catch {
			this.observe(undefined);
			return snapshot;
		}
		const bindings = this.bindings();
		const candidateKey = `${activePid}:${bindings.map((b) => `${b.pid}:${b.paneId}:${b.sessionId}`).join("|")}`;
		if (
			!this.candidateCache ||
			this.candidateCache.key !== candidateKey ||
			Date.now() - this.candidateCache.at >= 1000
		) {
			const pids = new Set<number>();
			for (const binding of bindings) {
				try {
					if (terminalProcessTree(binding.pid).kittyPid === activePid) pids.add(binding.pid);
				} catch {
					/* A closed peer is not a candidate. */
				}
			}
			// This cache selects candidates only. TerminalMoodController revalidates every
			// process identity, session binding and Kitty window before its fixed read-only bridge.
			this.candidateCache = { key: candidateKey, at: Date.now(), pids };
		}
		const candidates = bindings.filter((b) => this.candidateCache?.pids.has(b.pid));
		let herdrReport: HerdrLayout | undefined;
		const herdrSession = snapshot.sessions.find(
			(s) => s.provider === "herdr" && s.focused === true && s.visible === true && s.sessionId,
		);
		if (herdrSession) {
			const binding = bindings.find(
				(b) => b.paneId === herdrSession.paneId && b.sessionId === herdrSession.sessionId,
			);
			if (binding?.herdrSocketPath)
				herdrReport = await readHerdrLayout(Number(activePid), binding.paneId, binding.herdrSocketPath);
			if (herdrReport && binding && !candidates.includes(binding)) candidates.push(binding);
		}
		const session = snapshot.sessions.find(
			(s) =>
				s.sessionId &&
				candidates.some((b) => b.paneId === s.paneId && b.sessionId === s.sessionId) &&
				(s.provider !== "herdr" || (s.focused === true && s.visible === true)) &&
				["idle", "typing", "submitted", "working"].includes(s.activity.phase),
		);
		this.observe(session?.paneId);
		if (!session?.sessionId) return snapshot;
		const sessionId = session.sessionId;
		const key = `${activePid}:${active.address}:${session.paneId}:${sessionId}`;
		if (!this.cache || this.cache.key !== key || Date.now() - this.cache.at >= 1000) {
			if (this.pending) return snapshot;
			const read = async () => {
				try {
					const measured = await this.terminal.geometry(session.paneId, sessionId, authorize, herdrReport);
					const [clients, currentActive] = await Promise.all([hypr("clients"), hypr("activewindow")]);
					return authorize()
						? projectComposer(
								measured.geometry,
								clients,
								currentActive,
								measured.kittyPid,
								measured.sharedWindow,
								session.activity.geometry,
								Date.now(),
								herdrReport,
							)
						: null;
				} catch {
					return null;
				}
			};
			this.pending = read();
			try {
				this.cache = { key, at: Date.now(), target: await this.pending };
			} finally {
				this.pending = undefined;
			}
		}
		if (!authorize()) return snapshot;
		const target = this.cache?.key === key ? this.cache.target : null;
		return {
			...snapshot,
			capabilities: { ...snapshot.capabilities, geometry: !!target },
			sessions: snapshot.sessions.map((s) =>
				s === session
					? {
							...s,
							focused: target ? true : s.focused,
							visible: target ? true : s.visible,
							targets: { ...s.targets, composer: target },
						}
					: target
						? { ...s, focused: false }
						: s,
			),
		};
	}
}
