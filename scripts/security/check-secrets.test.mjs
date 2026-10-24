import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const runner = fileURLToPath(new URL("./check-secrets.sh", import.meta.url));
// Construct a synthetic detector fixture; this is not an issued credential.
const fixtureValue = ["k3Y", "0123456789abcdef"].join("_");

function scannerDirectory() {
	const candidates = (process.env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.map((directory) => resolve(directory, "gitleaks"));
	candidates.push(join(repository, ".cache/tools/gitleaks"));
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			return dirname(candidate);
		} catch {
			// Try the next executable location without printing environment data.
		}
	}
	throw new Error("Gitleaks is required for the secret-scanner integration tests.");
}

function fixture(t) {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-secret-scan-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const temporaryConfigs = join(cwd, "scan-temporary-files");
	mkdirSync(temporaryConfigs);
	const env = {
		...process.env,
		PATH: `${scannerDirectory()}${delimiter}${process.env.PATH ?? ""}`,
		TMPDIR: temporaryConfigs,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
	const context = { cwd, env, temporaryConfigs };
	git(context, ["init", "-q", "--initial-branch=main"]);
	return context;
}

function git({ cwd, env }, args) {
	const result = spawnSync(
		"git",
		[
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"user.name=Secret Scanner Test",
			"-c",
			"user.email=scanner@example.invalid",
			"-C",
			cwd,
			...args,
		],
		{ env, encoding: "utf8" },
	);
	assert.ifError(result.error);
	assert.equal(result.status, 0, "Git fixture operation failed; output intentionally withheld.");
}

function put({ cwd }, path, value) {
	mkdirSync(dirname(join(cwd, path)), { recursive: true });
	writeFileSync(join(cwd, path), value);
}

function commit(context) {
	git(context, ["add", "--all"]);
	git(context, ["commit", "-qm", "scanner fixture"]);
}

function scan(context) {
	const result = spawnSync("sh", [runner], {
		cwd: context.cwd,
		env: context.env,
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.ifError(result.error);
	const output = `${result.stdout}${result.stderr}`;
	assert.ok(!output.includes(fixtureValue), "Scanner output must redact the synthetic credential.");
	assert.deepEqual(readdirSync(context.temporaryConfigs), [], "Temporary scanner config must be removed.");
	return { status: result.status, detected: /leaks found:\s*[1-9]/.test(output) };
}

test("secret scanner accepts a clean committed repository", (t) => {
	const context = fixture(t);
	put(context, "source.js", "export const enabled = true;\n");
	commit(context);
	const result = scan(context);
	assert.equal(result.status, 0);
	assert.equal(result.detected, false);
});

test("secret scanner rejects a secret despite local config and inline suppression", (t) => {
	const context = fixture(t);
	put(context, "source.js", `const token = "${fixtureValue}"; // gitleaks:allow\n`);
	put(context, ".gitleaks.toml", "[extend]\nuseDefault = true\n[allowlist]\nregexes = ['''.*''']\n");
	context.env.GITLEAKS_CONFIG = join(context.cwd, ".gitleaks.toml");
	commit(context);
	const result = scan(context);
	assert.equal(result.status, 1);
	assert.equal(result.detected, true, "Expected a secret finding, not a scanner/configuration error.");
});

test("secret scanner detects a secret introduced only by a merge commit", (t) => {
	const context = fixture(t);
	put(context, "source.js", "export const enabled = true;\n");
	commit(context);
	git(context, ["checkout", "-qb", "feature"]);
	put(context, "feature.txt", "feature change\n");
	commit(context);
	git(context, ["checkout", "-q", "main"]);
	put(context, "main.txt", "main change\n");
	commit(context);
	git(context, ["merge", "--no-commit", "--no-ff", "feature"]);
	put(context, "merge-only.js", `const token = "${fixtureValue}";\n`);
	commit(context);
	const result = scan(context);
	assert.equal(result.status, 1, "A secret added during a merge must stop publication.");
	assert.equal(result.detected, true, "Expected a secret finding in the merge diff.");
});
