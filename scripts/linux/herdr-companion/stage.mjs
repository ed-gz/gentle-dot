#!/usr/bin/env node
/** Copy a verified client into a NEW private sidecar directory. Never changes PATH or starts it. */
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	chmodSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
const args = process.argv.slice(2);
const required = (key) => {
	const i = args.indexOf(key),
		value = args[i + 1];
	if (i < 0 || !value || !isAbsolute(value)) throw new Error(`${key} requires an absolute path`);
	return resolve(value);
};
const build = required("--build"),
	destination = required("--destination"),
	smokeFile = required("--smoke");
const proof = JSON.parse(readFileSync(join(build, "companion-build.json"), "utf8"));
const smoke = JSON.parse(readFileSync(smokeFile, "utf8"));
const binary = join(build, "target", "release", "herdr");
const digest = createHash("sha256").update(readFileSync(binary)).digest("hex");
if (
	proof.binarySha256 !== digest ||
	smoke.binarySha256 !== digest ||
	smoke.patchSha256 !== proof.patchSha256 ||
	smoke.verified !== true ||
	smoke.scope !== "isolated"
)
	throw new Error("A matching successful isolated smoke is required before staging");
if (existsSync(destination))
	throw new Error("Destination must not exist; existing sidecars are never overwritten");
mkdirSync(destination, { mode: 0o700 });
const dir = lstatSync(destination);
if (dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0)
	throw new Error("Sidecar directory is not private");
copyFileSync(binary, join(destination, "herdr"));
chmodSync(join(destination, "herdr"), 0o700);
writeFileSync(
	join(destination, "companion-build.json"),
	JSON.stringify(
		{ ...proof, smokeVerified: true, installed: true, stagedAt: new Date().toISOString() },
		null,
		2,
	) + "\n",
	{ mode: 0o600 },
);
copyFileSync(smokeFile, join(destination, "companion-smoke.json"));
chmodSync(join(destination, "companion-smoke.json"), 0o600);
console.log(`Private sidecar staged; no window started: ${destination}`);
