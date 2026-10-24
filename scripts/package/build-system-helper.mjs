#!/usr/bin/env node
// Builds (never installs or runs) the fixed Linux privilege helper for OS packaging.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = resolve(process.argv[2] ?? join(root, "build/system-helper"));
if (process.platform !== "linux") throw new Error("Build the Linux system helper on Linux.");
if (process.argv.length > 3) throw new Error("Usage: build-system-helper.mjs [output-directory]");
mkdirSync(out, { recursive: true, mode: 0o755 });
const helper = join(out, "privileged-helper");
const result = spawnSync(
	"rustc",
	[
		"--edition",
		"2021",
		"-C",
		"opt-level=2",
		"-C",
		"strip=symbols",
		join(root, "packaging/linux/privileged-helper.rs"),
		"-o",
		helper,
	],
	{ stdio: "inherit" },
);
if (result.error || result.status !== 0) throw new Error("The system helper did not compile.");
chmodSync(helper, 0o755);
const policy = join(out, "dev.gentledot.install-browser.policy");
copyFileSync(join(root, "packaging/linux/dev.gentledot.install-browser.policy"), policy);
chmodSync(policy, 0o644);
writeFileSync(
	join(out, "tauri-system-helper.json"),
	JSON.stringify(
		{
			bundle: {
				linux: {
					deb: {
						files: {
							"/usr/libexec/gentle-dot/privileged-helper": helper,
							"/usr/share/polkit-1/actions/dev.gentledot.install-browser.policy": policy,
						},
						recommends: ["polkitd", "pkexec"],
					},
				},
			},
		},
		null,
		2,
	),
);
writeFileSync(
	join(out, "SHA256SUMS"),
	`${[helper, policy]
		.map(
			(path) =>
				`${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${path === helper ? "privileged-helper" : "dev.gentledot.install-browser.policy"}`,
		)
		.join("\n")}\n`,
);
console.log(`Built system helper for packaging: ${out}`);
