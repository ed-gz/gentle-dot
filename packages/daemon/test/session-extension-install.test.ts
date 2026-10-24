import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { tempDir } from "./helpers.ts";

const script = fileURLToPath(
	new URL("../../../scripts/orchestration/prepare-session-extension.mjs", import.meta.url),
);
const run = (...args: string[]) =>
	execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: "pipe" });
it("only prepares by default, installs a private wrapper explicitly and preserves unrelated extension/config files", () => {
	const directory = tempDir();
	const agent = join(directory, "agent");
	const output = join(directory, "prepared.ts");
	run("--output", output, "--agent-dir", agent);
	expect(existsSync(agent)).toBe(false);
	expect(readFileSync(output, "utf8")).toContain("createDotSession");
	run("--install", "--agent-dir", agent);
	const installed = join(agent, "extensions", "gentle-dot-session", "index.ts");
	expect(readFileSync(installed, "utf8")).toBe(readFileSync(output, "utf8"));
	expect(statSync(installed).mode & 0o777).toBe(0o600);
	const settings = join(agent, "settings.json");
	writeFileSync(settings, "keep settings");
	run("--install", "--agent-dir", agent);
	expect(readFileSync(settings, "utf8")).toBe("keep settings");
	writeFileSync(installed, "user-owned extension");
	expect(() => run("--install", "--agent-dir", agent)).toThrow();
	expect(readFileSync(installed, "utf8")).toBe("user-owned extension");
});
it("refuses symlinks in profile ancestors without touching their target", () => {
	const directory = tempDir();
	const real = join(directory, "real");
	mkdirSync(real);
	const link = join(directory, "linked");
	symlinkSync(real, link);
	expect(() => run("--install", "--agent-dir", link)).toThrow();
	expect(existsSync(join(real, "extensions"))).toBe(false);
});
