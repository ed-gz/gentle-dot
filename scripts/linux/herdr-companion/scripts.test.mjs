import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const here = dirname(fileURLToPath(import.meta.url));
const fixture = () => {
	const base = mkdtempSync(join(tmpdir(), "gd-herdr-script-"));
	const build = join(base, "build");
	mkdirSync(join(build, "target", "release"), { recursive: true });
	const content = "fixture executable; never run";
	writeFileSync(join(build, "target", "release", "herdr"), content);
	const hash = createHash("sha256").update(content).digest("hex");
	const proof = { binarySha256: hash, patchSha256: "test-patch", smokeVerified: false };
	writeFileSync(join(build, "companion-build.json"), JSON.stringify(proof));
	return { base, build, hash, proof };
};
test("staging refuses unverified smoke without creating or replacing a sidecar", () => {
	const f = fixture();
	try {
		const smoke = join(f.base, "smoke.json"),
			destination = join(f.base, "sidecar");
		writeFileSync(smoke, JSON.stringify({ verified: false }));
		const r = spawnSync(process.execPath, [
			join(here, "stage.mjs"),
			"--build",
			f.build,
			"--smoke",
			smoke,
			"--destination",
			destination,
		]);
		assert.notEqual(r.status, 0);
		assert.equal(existsSync(destination), false);
		assert.equal(
			readFileSync(join(f.build, "target", "release", "herdr"), "utf8"),
			"fixture executable; never run",
		);
	} finally {
		rmSync(f.base, { recursive: true, force: true });
	}
});
test("verified staging uses a new private directory and preserves the source binary", () => {
	const f = fixture();
	try {
		const smoke = join(f.base, "smoke.json"),
			destination = join(f.base, "sidecar");
		writeFileSync(
			smoke,
			JSON.stringify({ verified: true, scope: "isolated", binarySha256: f.hash, patchSha256: "test-patch" }),
		);
		const args = [
			join(here, "stage.mjs"),
			"--build",
			f.build,
			"--smoke",
			smoke,
			"--destination",
			destination,
		];
		assert.equal(spawnSync(process.execPath, args).status, 0);
		assert.equal(statSync(destination).mode & 0o777, 0o700);
		assert.equal(statSync(join(destination, "herdr")).mode & 0o777, 0o700);
		assert.equal(JSON.parse(readFileSync(join(destination, "companion-build.json"))).smokeVerified, true);
		assert.notEqual(spawnSync(process.execPath, args).status, 0);
	} finally {
		rmSync(f.base, { recursive: true, force: true });
	}
});
test("default opening only prints a plan for the existing server and leaves runtime directories untouched", async () => {
	const f = fixture();
	const server = createServer();
	try {
		const sidecar = join(f.base, "sidecar"),
			runtime = join(f.base, "runtime"),
			socket = join(f.base, "server.sock");
		mkdirSync(sidecar, { mode: 0o700 });
		mkdirSync(runtime, { mode: 0o700 });
		writeFileSync(join(sidecar, "herdr"), "fixture executable; never run");
		writeFileSync(join(sidecar, "companion-build.json"), JSON.stringify({ ...f.proof, smokeVerified: true }));
		await new Promise((resolve) => server.listen(socket, resolve));
		const r = spawnSync(
			process.execPath,
			[join(here, "open.mjs"), "--sidecar", sidecar, "--socket", socket],
			{ env: { ...process.env, XDG_RUNTIME_DIR: runtime }, encoding: "utf8" },
		);
		assert.equal(r.status, 0, r.stderr);
		const plan = JSON.parse(r.stdout);
		assert.equal(plan.launch, false);
		assert.equal(plan.program, "kitty");
		assert.deepEqual(plan.argv.slice(-2), [join(sidecar, "herdr"), "client"]);
		assert.equal(plan.environment.HERDR_SOCKET_PATH, socket);
		assert.equal(existsSync(join(runtime, "gentle-dot")), false);
	} finally {
		server.close();
		rmSync(f.base, { recursive: true, force: true });
	}
});
