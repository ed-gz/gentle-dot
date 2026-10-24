#!/usr/bin/env node
/** Build an isolated, pinned client. Never installs it or contacts an existing Herdr server. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(join(here, "source.json"), "utf8"));
const patch = join(here, "herdr-0.9.3-companion-layout.patch");
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const args = process.argv.slice(2);
const mode = args.shift();
const option = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const required = (name) => {
	const v = option(name);
	if (!v || !isAbsolute(v)) throw new Error(`${name} requires an absolute path`);
	return resolve(v);
};
const run = (program, argv, cwd, env = process.env) => {
	const result = spawnSync(program, argv, { cwd, env, stdio: "inherit" });
	if (result.error || result.status !== 0)
		throw result.error ?? new Error(`${program} exited ${result.status}`);
};
if (hash(patch) !== contract.patchSha256) throw new Error("Patch digest mismatch");
const directory = required("--directory");
if (mode === "--prepare") {
	const upstream = required("--source");
	const commit = execFileSync("git", ["-C", upstream, "rev-parse", `${contract.baseCommit}^{commit}`], {
		encoding: "utf8",
	}).trim();
	if (commit !== contract.baseCommit) throw new Error("Unexpected source commit");
	if (existsSync(directory)) throw new Error("Output directory must not exist");
	mkdirSync(directory, { mode: 0o700 });
	const archive = join(directory, ".source.tar");
	try {
		run("git", ["-C", upstream, "archive", "--format=tar", `--output=${archive}`, commit], upstream);
		run("tar", ["-xf", archive, "-C", directory], directory);
		// An archive nested under another checkout must not inherit that repository's
		// path prefix: git apply otherwise silently skips paths outside the prefix.
		const applyEnv = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(directory) };
		for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete applyEnv[key];
		run("git", ["apply", "--check", patch], directory, applyEnv);
		run("git", ["apply", patch], directory, applyEnv);
		writeFileSync(
			join(directory, ".companion-source.json"),
			JSON.stringify({ baseCommit: commit, patchSha256: contract.patchSha256 }, null, 2) + "\n",
			{ mode: 0o600 },
		);
	} finally {
		rmSync(archive, { force: true });
	}
} else if (!["--verify", "--test", "--build"].includes(mode)) {
	throw new Error(
		"Use --prepare --source /clone --directory /new-build, or --verify|--test|--build --directory /build [--zig /zig]",
	);
}
for (const [file, expected] of Object.entries(contract.files)) {
	if (hash(join(directory, file)) !== expected) throw new Error(`Source digest mismatch: ${file}`);
}
if (mode === "--build" || mode === "--test") {
	const zig = option("--zig") ?? process.env.ZIG ?? "zig";
	if (execFileSync(zig, ["version"], { encoding: "utf8" }).trim() !== "0.16.0")
		throw new Error("Zig 0.16.0 is required");
	const env = { ...process.env, ZIG: zig, CARGO_BUILD_JOBS: "2" };
	delete env.HERDR_SOCKET_PATH;
	delete env.HERDR_CLIENT_SOCKET_PATH;
	delete env.GENTLE_DOT_COMPANION_LAYOUT_DIR;
	if (mode === "--test") {
		run(
			"cargo",
			["test", "--locked", "--bin", "herdr", "companion_layout", "--", "--test-threads=1"],
			directory,
			env,
		);
		run(
			"cargo",
			["test", "--locked", "--bin", "herdr", "frozen_generation_one", "--", "--test-threads=1"],
			directory,
			env,
		);
		run("python3", ["-m", "unittest", "scripts.test_ui_hot_path_architecture"], directory, env);
	} else {
		run("cargo", ["build", "--release", "--locked", "--bin", "herdr"], directory, env);
		const binary = join(directory, "target", "release", "herdr");
		const version = execFileSync(binary, ["--version"], { env, encoding: "utf8" }).trim();
		const proof = {
			version: 1,
			baseCommit: contract.baseCommit,
			patchSha256: contract.patchSha256,
			binarySha256: hash(binary),
			binaryVersion: version,
			builtAt: new Date().toISOString(),
			installed: false,
			smokeVerified: false,
		};
		writeFileSync(join(directory, "companion-build.json"), JSON.stringify(proof, null, 2) + "\n", {
			mode: 0o600,
		});
	}
}
console.log(`Verified pinned companion source: ${directory}`);
