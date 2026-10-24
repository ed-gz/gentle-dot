import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectComposer } from "../src/orchestration/composer-geometry.ts";
import { measureEditor, parseEditorGeometry } from "../src/orchestration/editor-geometry.ts";
import { parseHerdrLayout, readHerdrLayout } from "../src/orchestration/herdr-layout.ts";

const now = Date.parse("2026-10-23T18:00:00Z");
const editorGeometry = {
	version: 1 as const,
	columns: 100,
	rows: 30,
	rect: { x: 0, y: 25, width: 100, height: 3 },
	observedAt: new Date(now).toISOString(),
};
const geometry = {
	viewportWidth: 1200,
	viewportHeight: 700,
	cellWidth: 11,
	cellHeight: 20,
	columns: 100,
	rows: 30,
	left: 30,
	top: 40,
	cursorX: 4,
	cursorY: 26,
	cursorVisible: true,
	active: true,
	focused: true,
};
const window = { pid: 42, address: "0xabc", mapped: true, hidden: false, at: [1920, 37], size: [960, 560] };
const active = { pid: 42, address: "0xabc" };
describe("measured compositor targets", () => {
	it("projects the exact editor without assuming centered padding", () => {
		expect(projectComposer(geometry, [window], active, 42, false, editorGeometry, now)).toEqual({
			x: 1944,
			y: 469,
			width: 880,
			height: 48,
			kind: "editor",
			verified: true,
			observedAt: new Date(now).toISOString(),
		});
	});
	it("calls a mux cursor a cursor, never an editor", () => {
		expect(projectComposer(geometry, [window], active, 42, true, editorGeometry, now)).toMatchObject({
			x: 1979.2,
			y: 485,
			width: 8.8,
			height: 16,
			kind: "cursor",
		});
		expect(
			projectComposer({ ...geometry, cursorVisible: false }, [window], active, 42, true, editorGeometry, now),
		).toBeNull();
	});
	it("rejects stale, hidden, resized, ambiguous or unfocused evidence", () => {
		expect(
			projectComposer(geometry, [window], { ...active, address: "0xother" }, 42, false, editorGeometry, now),
		).toBeNull();
		expect(projectComposer(geometry, [window, window], active, 42, false, editorGeometry, now)).toBeNull();
		expect(
			projectComposer({ ...geometry, focused: false }, [window], active, 42, false, editorGeometry, now),
		).toBeNull();
		expect(
			projectComposer(geometry, [{ ...window, size: [800, 560] }], active, 42, false, editorGeometry, now),
		).toBeNull();
		expect(projectComposer(geometry, [window], active, 42, false, editorGeometry, now + 4000)?.kind).toBe(
			"cursor",
		);
	});
	it("reads only numeric layout metadata and excludes overlays/clipped editor", () => {
		const editor: Record<string, unknown> = { renderedVisibleLineCount: 1 };
		Object.defineProperty(editor, "getText", {
			get() {
				throw Error("draft accessed");
			},
		});
		const rect = { x: 0, y: 25, width: 100, height: 6 };
		const box = { component: editor, rect, clip: { x: 0, y: 0, width: 100, height: 31 }, children: [] };
		Object.defineProperty(box, "lines", {
			get() {
				throw Error("rendered text accessed");
			},
		});
		const tui = {
			mode: "fullscreen",
			currentLayout: { width: 100, height: 31, root: box },
			terminal: { columns: 100, rows: 31 },
			hasOverlay: () => false,
		};
		editor.tui = tui;
		expect(measureEditor(editor, now)?.rect).toEqual({ ...rect, height: 3 });
		tui.hasOverlay = () => true;
		expect(measureEditor(editor, now)).toBeUndefined();
		tui.hasOverlay = () => false;
		box.clip.height = 26;
		expect(measureEditor(editor, now)).toBeUndefined();
	});
	it("resolves Pi's real cached Container layout and rejects stale child identities", () => {
		const editor: Record<string, unknown> = { renderedVisibleLineCount: 1 };
		const container = {
			children: [editor],
			mouseLayout: { width: 100, children: [{ component: editor, height: 3 }] },
		};
		editor.tui = {
			mode: "fullscreen",
			terminal: { columns: 100, rows: 30 },
			hasOverlay: () => false,
			currentLayout: {
				width: 100,
				height: 30,
				root: {
					component: container,
					rect: { x: 0, y: 25, width: 100, height: 3 },
					clip: { x: 0, y: 0, width: 100, height: 30 },
					lineOffset: 0,
					children: [],
				},
			},
		};
		expect(measureEditor(editor, now)?.rect).toEqual({ x: 0, y: 25, width: 100, height: 3 });
		container.children = [{}];
		expect(measureEditor(editor, now)).toBeUndefined();
	});

	it("rejects cell geometry outside the exact terminal frame", () => {
		expect(parseEditorGeometry({ ...editorGeometry, columns: 99 }, now)).toBeUndefined();
		expect(parseEditorGeometry(editorGeometry, now + 3001)).toBeUndefined();
	});
});

describe("Herdr presented-frame bridge", () => {
	const report = {
		version: 1,
		clientPid: 91,
		processIdentity: "boot:1",
		kittyWindowId: 2,
		herdrSocketPath: "/run/user/1000/herdr.sock",
		columns: 130,
		rows: 40,
		observedAt: new Date(now).toISOString(),
		revision: 7,
		overlayActive: false,
		outerFocused: true,
		available: true,
		focusedPaneId: "w1:p1",
		panes: [
			{
				paneId: "w1:p1",
				endpoint: "local",
				scrollOffset: 0,
				innerRect: { x: 25, y: 5, width: 100, height: 30 },
			},
		],
	};
	it("keeps a valid report when a sibling is malformed, stale or its process has exited", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dot-layout-test-"));
		chmodSync(dir, 0o700);
		try {
			const socket = join(dir, "socket");
			writeFileSync(socket, "", { mode: 0o600 });
			const live = { ...report, herdrSocketPath: socket, observedAt: new Date().toISOString() };
			writeFileSync(join(dir, "91.json"), JSON.stringify(live), { mode: 0o600 });
			writeFileSync(join(dir, "92.json"), "malformed", { mode: 0o600 });
			writeFileSync(join(dir, "93.json"), JSON.stringify({ ...live, clientPid: 93 }), { mode: 0o600 });
			writeFileSync(
				join(dir, "94.json"),
				JSON.stringify({ ...live, clientPid: 94, observedAt: new Date(Date.now() - 9000).toISOString() }),
				{ mode: 0o600 },
			);
			const value = await readHerdrLayout(42, "w1:p1", socket, {
				directory: dir,
				identity: async (pid) => (pid === 91 ? "boot:1" : undefined),
				tree: () => ({ pids: [91, 42], names: ["herdr", "kitty"], kittyPid: 42, windowId: 2 }),
			});
			expect(value?.clientPid).toBe(91);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("uses published pane origin, never an inferred sidebar width", () => {
		const h = parseHerdrLayout(report, "w1:p1", now)!;
		expect(
			projectComposer(
				{ ...geometry, columns: 130, rows: 40, viewportWidth: 1500, viewportHeight: 900 },
				[{ ...window, size: [1200, 720] }],
				active,
				42,
				true,
				editorGeometry,
				now,
				h,
			),
		).toMatchObject({ kind: "editor", x: 2164, y: 549, width: 880, height: 48 });
	});
	it("rejects stale, overlaid, scrolled, remote, mismatched or unavailable frames", () => {
		for (const patch of [
			{ overlayActive: true },
			{ outerFocused: false },
			{ available: false },
			{ focusedPaneId: "w1:p2" },
			{ observedAt: new Date(now - 2501).toISOString() },
			{ panes: [{ ...report.panes[0], scrollOffset: 1 }] },
			{ panes: [{ ...report.panes[0], endpoint: "remote" }] },
			{ panes: [{ ...report.panes[0], innerRect: { x: 90, y: 5, width: 100, height: 30 } }] },
		])
			expect(parseHerdrLayout({ ...report, ...patch }, "w1:p1", now)).toBeUndefined();
	});
});
