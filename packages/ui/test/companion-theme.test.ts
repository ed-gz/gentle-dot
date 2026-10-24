import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPRI_THEME } from "@gentle-dot/theme-capri/manifest";
import { expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../theme-capri");
it("ships an opt-in offline inventory with every production file and no reference screenshots", () => {
	expect(CAPRI_THEME.defaultEnabled).toBe(false);
	for (const sheet of [...CAPRI_THEME.animationSheets, ...CAPRI_THEME.staticSheets]) {
		for (const path of [sheet.manifest, sheet.image]) {
			expect(path).not.toMatch(/(^\/|\.\.|https?:)/);
			expect(existsSync(join(root, path)), path).toBe(true);
		}
	}
	expect(CAPRI_THEME.animationSheets).toHaveLength(7);
	expect(existsSync(join(root, "src/assets/references"))).toBe(false);
	for (const name of readdirSync(join(root, "provenance"))) {
		expect(readFileSync(join(root, "provenance", name), "utf8")).not.toMatch(/\/home\/|\/tmp\//);
	}
});
