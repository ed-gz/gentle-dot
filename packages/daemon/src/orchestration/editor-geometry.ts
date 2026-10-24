/** Geometry only. No rendered rows, cursor text, draft, or key data is inspected. */
export interface CellRect {
	x: number;
	y: number;
	width: number;
	height: number;
}
export interface EditorGeometry {
	version: 1;
	columns: number;
	rows: number;
	rect: CellRect;
	observedAt: string;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
export function cellRect(value: unknown): CellRect | undefined {
	if (!object(value)) return;
	const { x, y, width, height } = value;
	if (
		![x, y, width, height].every(
			(v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10000,
		) ||
		!width ||
		!height
	)
		return;
	return { x, y, width, height } as CellRect;
}
export function parseEditorGeometry(value: unknown, now = Date.now()): EditorGeometry | undefined {
	if (!object(value) || value.version !== 1) return;
	const rect = cellRect(value.rect),
		columns = Number(value.columns),
		rows = Number(value.rows);
	const age = typeof value.observedAt === "string" ? now - Date.parse(value.observedAt) : NaN;
	if (
		!rect ||
		!Number.isInteger(columns) ||
		!Number.isInteger(rows) ||
		columns < 1 ||
		rows < 1 ||
		columns > 10000 ||
		rows > 10000 ||
		rect.x + rect.width > columns ||
		rect.y + rect.height > rows ||
		!Number.isFinite(age) ||
		age < -500 ||
		age > 3000
	)
		return;
	return { version: 1, columns, rows, rect, observedAt: value.observedAt as string };
}
/** Read only known Pi 1.2 layout metadata; unknown/hidden/overlaid layouts fail closed. */
export function measureEditor(editor: unknown, now = Date.now()): EditorGeometry | undefined {
	if (!object(editor) || !object(editor.tui)) return;
	const tui = editor.tui;
	if (
		tui.mode !== "fullscreen" ||
		!object(tui.currentLayout) ||
		!object(tui.terminal) ||
		typeof tui.hasOverlay !== "function" ||
		tui.hasOverlay.call(tui)
	)
		return;
	const frame = tui.currentLayout;
	if (frame.width !== tui.terminal.columns || frame.height !== tui.terminal.rows) return;
	const pending: unknown[] = [frame.root],
		seen = new Set<unknown>();
	let found: CellRect | undefined;
	while (pending.length && seen.size < 1024) {
		const box = pending.pop();
		if (!object(box) || seen.has(box)) continue;
		seen.add(box);
		if (box.component === editor) {
			if (found) return;
			const rect = cellRect(box.rect),
				clip = cellRect(box.clip);
			if (
				!rect ||
				!clip ||
				rect.x < clip.x ||
				rect.y < clip.y ||
				rect.x + rect.width > clip.x + clip.width ||
				rect.y + rect.height > clip.y + clip.height
			)
				return;
			// Autocomplete is outside the framed editor; the host publishes the visible row count.
			const lines = editor.renderedVisibleLineCount;
			if (!Number.isInteger(lines) || (lines as number) < 1 || (lines as number) + 2 > rect.height) return;
			found = { ...rect, height: (lines as number) + 2 };
		}
		if (Array.isArray(box.children)) pending.push(...box.children);
		// Pi's editor is a leaf Container within the layout. Use its cached mouse
		// geometry, which was produced by that same render, without rerendering or
		// reading lines. Unknown wrappers and scrolled/clipped leaves are rejected.
		const container = box.component,
			rect = cellRect(box.rect);
		if (
			Array.isArray(box.children) &&
			box.children.length === 0 &&
			object(container) &&
			object(container.mouseLayout) &&
			rect &&
			(box.lineOffset === undefined || box.lineOffset === 0)
		) {
			const layout = container.mouseLayout;
			if (
				layout.width === rect.width &&
				Array.isArray(layout.children) &&
				Array.isArray(container.children) &&
				layout.children.length === container.children.length &&
				layout.children.length <= 128
			) {
				let offset = 0;
				for (let index = 0; index < layout.children.length; index++) {
					const child = layout.children[index];
					if (
						!object(child) ||
						child.component !== container.children[index] ||
						!Number.isInteger(child.height) ||
						(child.height as number) < 0
					)
						return;
					const height = child.height as number;
					if (height > 0)
						pending.push({
							component: child.component,
							rect: { ...rect, y: rect.y + offset, height },
							clip: box.clip,
							children: [],
						});
					offset += height;
				}
				if (offset > rect.height) return;
			}
		}
	}
	return found
		? parseEditorGeometry(
				{
					version: 1,
					columns: frame.width,
					rows: frame.height,
					rect: found,
					observedAt: new Date(now).toISOString(),
				},
				now,
			)
		: undefined;
}
