import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

describe("Linux OS authentication helper packaging", () => {
	it.runIf(process.platform === "linux" && spawnSync("rustc", ["--version"]).status === 0)(
		"builds a standalone helper with fixed root-owned install paths and refuses non-root execution",
		() => {
			const out = mkdtempSync(join(tmpdir(), "gentle-dot-helper-"));
			try {
				execFileSync(process.execPath, [join(root, "scripts/package/build-system-helper.mjs"), out]);
				const helper = join(out, "privileged-helper");
				const config = JSON.parse(readFileSync(join(out, "tauri-system-helper.json"), "utf8"));
				expect(config.bundle.linux.deb.files["/usr/libexec/gentle-dot/privileged-helper"]).toBe(helper);
				expect(statSync(helper).mode & 0o777).toBe(0o755);
				// Never run a package manager in tests, even when CI runs as root.
				if (process.geteuid?.() !== 0)
					expect(spawnSync(helper, ["install_browser", "chromium"]).status).toBe(77);
				expect(spawnSync(helper, ["not-an-operation"]).status).not.toBe(0);
				const policy = readFileSync(join(out, "dev.gentledot.install-browser.policy"), "utf8");
				expect(policy).toContain("<allow_active>auth_admin</allow_active>");
				expect(policy).not.toMatch(/auth_admin_keep|auth_self|<allow_\w+>yes/);
				expect(policy).toContain("<allow_inactive>no</allow_inactive>");
			} finally {
				rmSync(out, { recursive: true, force: true });
			}
		},
	);
});
