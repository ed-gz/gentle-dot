export interface CompanionSpaceRect {
	x: number;
	y: number;
	width: number;
	height: number;
}
export const FULL_COMPANION_SPACE: CompanionSpaceRect = { x: 0, y: 0, width: 1, height: 1 };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
export function normalizeCompanionSpace(rect: CompanionSpaceRect): CompanionSpaceRect {
	const width = clamp(finite(rect.width, 1), 0.2, 1);
	const height = clamp(finite(rect.height, 1), 0.2, 1);
	return {
		x: clamp(finite(rect.x, 0), 0, 1 - width),
		y: clamp(finite(rect.y, 0), 0, 1 - height),
		width,
		height,
	};
}
