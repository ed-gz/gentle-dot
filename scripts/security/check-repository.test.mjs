import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRepository, MAX_BLOB_BYTES, WRAPPER } from "./check-repository.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const script = fileURLToPath(new URL("./check-repository.mjs", import.meta.url));
const ELF = Buffer.from("7f454c46020101000000000000000000", "hex");
const ZIP = Buffer.from("504b0304140000000000000000000000", "hex");
const PNG = Buffer.from("89504e470d0a1a0a0000000049454e44ae426082", "hex");

function git(cwd, args, input) {
	const result = spawnSync(
		"git",
		["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", cwd, ...args],
		{
			input,
			encoding: null,
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
			},
		},
	);
	assert.ifError(result.error);
	assert.equal(result.status, 0, "Git fixture command failed");
	return result.stdout;
}

function fixture(t) {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-publication-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	git(cwd, ["init", "-q", "--initial-branch=main"]);
	return cwd;
}
function put(cwd, path, value = "fixture\n") {
	mkdirSync(dirname(join(cwd, path)), { recursive: true });
	writeFileSync(join(cwd, path), value);
}
function stage(cwd) {
	git(cwd, ["add", "--all"]);
}
function commit(cwd) {
	git(cwd, [
		"-c",
		"user.name=Publication Guard Test",
		"-c",
		"user.email=guard@example.invalid",
		"commit",
		"-qm",
		"fixture",
	]);
}
function has(result, path, rule) {
	return result.findings.some((item) => item.path === path && item.rule === rule);
}

test("allows authored assets, examples, and source names containing auth/key/token", (t) => {
	const cwd = fixture(t);
	for (const path of [
		"packages/daemon/src/token.ts",
		"packages/daemon/src/auth/credentials.ts",
		"scripts/keychain.mjs",
		"test/fixtures/auth-source.ts",
		"test/fixtures/runtime/response.json",
		"docs/guide.md",
		"docs/demo.html",
		"icons/face.svg",
		".env.example",
	])
		put(cwd, path, path.endsWith(".example") ? "EXAMPLE_VALUE=replace-me\n" : "example\n");
	put(cwd, "packages/theme-capri/src/assets/sprite.png", PNG);
	stage(cwd);
	assert.deepEqual(checkRepository(cwd).findings, []);
});

test("blocks nested generated outputs and sensitive runtime/config paths", (t) => {
	const cwd = fixture(t);
	const paths = [
		"nested/.env",
		"nested/.env.production",
		"nested/.env.example.private",
		"nested/auth.json",
		"nested/hosts.yaml",
		"nested/signing.properties",
		"nested/id_ed25519",
		"nested/signing/upload.keystore",
		"nested/.ssh/config",
		"nested/credentials/account.txt",
		"nested/runtime/profile/settings.json",
		"nested/node_modules/library/index.js",
		"nested/dist/index.js",
		"nested/build/report.txt",
		"nested/.cache/item",
		"nested/session.sqlite",
		"nested/trace.har",
		"nested/.engram/config.json",
		"nested/project-firebase-adminsdk-fixture.json",
	];
	for (const path of paths) put(cwd, path, "{}");
	stage(cwd);
	const result = checkRepository(cwd);
	for (const path of paths)
		assert.ok(
			result.findings.some((item) => item.path === path),
			path,
		);
});

test("blocks installable packages, native libraries, archives, and bytecode by name", (t) => {
	const cwd = fixture(t);
	const names = [
		"a.apk",
		"a.aab",
		"a.aar",
		"a.dex",
		"a.class",
		"a.deb",
		"a.rpm",
		"a.dmg",
		"a.pkg",
		"a.msi",
		"a.exe",
		"a.AppImage",
		"a.ipa",
		"a.so.1.2",
		"a.dll",
		"a.dylib",
		"a.node",
		"a.jar",
		"a.zip",
		"a.tar.gz",
	];
	for (const name of names) put(cwd, `nested/${name}`);
	stage(cwd);
	const result = checkRepository(cwd);
	for (const name of names) assert.ok(has(result, `nested/${name}`, "compiled-or-archive-file"), name);
});

test("detects renamed ELF, PE, Mach-O, ZIP, tar and runtime databases", (t) => {
	const cwd = fixture(t);
	const tar = Buffer.alloc(512);
	tar.write("ustar", 257);
	const cases = [
		["art/sprite.png", ELF, "executable-or-bytecode-magic"],
		["docs/pe.txt", Buffer.from("MZfake"), "executable-or-bytecode-magic"],
		["docs/mach.svg", Buffer.from("cffaedfe00000000", "hex"), "executable-or-bytecode-magic"],
		["docs/archive.txt", ZIP, "archive-magic"],
		["docs/archive2.txt", tar, "archive-magic"],
		["docs/data.txt", Buffer.from("SQLite format 3\0"), "runtime-database-magic"],
	];
	for (const [path, bytes] of cases) put(cwd, path, bytes);
	stage(cwd);
	const result = checkRepository(cwd);
	for (const [path, , rule] of cases) assert.ok(has(result, path, rule), path);
});

test("examines staged content rather than newer worktree content", (t) => {
	const cwd = fixture(t);
	put(cwd, "safe.txt", "source");
	put(cwd, "unsafe.txt", ELF);
	stage(cwd);
	put(cwd, "safe.txt", ELF);
	put(cwd, "unsafe.txt", "fixed only in worktree");
	const result = checkRepository(cwd);
	assert.ok(!result.findings.some((item) => item.path === "safe.txt"));
	assert.ok(has(result, "unsafe.txt", "executable-or-bytecode-magic"));
});

test("permits only the fixed wrapper path and bytes", (t) => {
	const cwd = fixture(t);
	const approved = git(repository, ["show", `:${WRAPPER.path}`]);
	put(cwd, WRAPPER.path, approved);
	stage(cwd);
	assert.deepEqual(checkRepository(cwd).findings, []);
	put(cwd, "another/gradle-wrapper.jar", approved);
	put(cwd, WRAPPER.path, ZIP);
	stage(cwd);
	const result = checkRepository(cwd);
	assert.ok(has(result, WRAPPER.path, "unapproved-gradle-wrapper"));
	assert.ok(has(result, "another/gradle-wrapper.jar", "compiled-or-archive-file"));
});

test("rejects oversized staged blobs before reading their contents", (t) => {
	const cwd = fixture(t);
	put(cwd, "asset.png", Buffer.alloc(MAX_BLOB_BYTES + 1));
	stage(cwd);
	assert.ok(has(checkRepository(cwd), "asset.png", "blob-over-20-mib"));
});

test("rejects gitlinks without inspecting their external repository", (t) => {
	const cwd = fixture(t);
	put(cwd, "source.ts");
	stage(cwd);
	commit(cwd);
	const oid = git(cwd, ["rev-parse", "HEAD"]).toString("ascii").trim();
	git(cwd, ["update-index", "--add", "--cacheinfo", `160000,${oid},nested/dependency`]);
	assert.ok(has(checkRepository(cwd), "nested/dependency", "gitlink-submodule"));
});

test("rejects symlinks without following them", (t) => {
	const cwd = fixture(t);
	symlinkSync("missing-private-file", join(cwd, "linked.txt"));
	stage(cwd);
	assert.ok(has(checkRepository(cwd), "linked.txt", "non-regular-file"));
});

test("history catches deleted artifacts and credential paths on another ref", (t) => {
	const cwd = fixture(t);
	put(cwd, "source.ts", "export const example = true;\n");
	stage(cwd);
	commit(cwd);
	git(cwd, ["switch", "-qc", "old-artifacts"]);
	put(cwd, "removed/auth.json", "{}");
	put(cwd, "removed/renamed.txt", ELF);
	stage(cwd);
	commit(cwd);
	git(cwd, ["switch", "-q", "main"]);
	assert.deepEqual(checkRepository(cwd).findings, []);
	const result = checkRepository(cwd, { history: true });
	assert.ok(has(result, "removed/auth.json", "credential-or-private-config"));
	assert.ok(has(result, "removed/renamed.txt", "executable-or-bytecode-magic"));
});

test("history checks every filename even when the blob was previously harmless", (t) => {
	const cwd = fixture(t);
	put(cwd, "example.json", "{}");
	stage(cwd);
	commit(cwd);
	git(cwd, ["mv", "example.json", "credentials.json"]);
	commit(cwd);
	git(cwd, ["rm", "credentials.json"]);
	commit(cwd);
	assert.deepEqual(checkRepository(cwd).findings, []);
	assert.ok(has(checkRepository(cwd, { history: true }), "credentials.json", "credential-or-private-config"));
});

test("CLI reports escaped paths and rules, never staged contents", (t) => {
	const cwd = fixture(t);
	const marker = "PRIVATE_FIXTURE_VALUE_DO_NOT_PRINT";
	put(cwd, "nested/.env", marker);
	stage(cwd);
	const result = spawnSync(process.execPath, [script, cwd], { encoding: "utf8" });
	assert.ifError(result.error);
	assert.equal(result.status, 1);
	const output = `${result.stdout}${result.stderr}`;
	assert.ok(output.includes("environment-file"));
	assert.ok(output.includes("nested/.env"));
	assert.ok(!output.includes(marker));
});
