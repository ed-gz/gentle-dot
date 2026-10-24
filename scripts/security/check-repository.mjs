import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_BLOB_BYTES = 20 * 1024 * 1024;
export const WRAPPER = Object.freeze({
	path: "apps/mobile/android/gradle/wrapper/gradle-wrapper.jar",
	sha256: "7d3a4ac4de1c32b59bc6a4eb8ecb8e612ccd0cf1ae1e99f66902da64df296172",
});

const OBJECT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const GENERATED = new Set([
	".git",
	".cache",
	".gradle",
	".next",
	".nuxt",
	".output",
	".turbo",
	".vite",
	".venv",
	"__pycache__",
	"node_modules",
	"build",
	"dist",
	"target",
	"coverage",
	"out",
	"venv",
]);
const PRIVATE = new Set([
	".ssh",
	".aws",
	".gnupg",
	".kube",
	".codex",
	".pi",
	".gentle-dot",
	".engram",
	".config",
	".local",
	".secrets",
	"secrets",
	"credentials",
	"runtime-data",
	"user-data",
	"userdata",
	"private-data",
	"personal-data",
]);
const RUNTIME_DIRS = new Set([
	"runtime",
	"profiles",
	"sessions",
	"auth",
	"hosts",
	"history",
	"conversations",
]);
const SOURCE_CONTEXT = new Set(["src", "scripts", "test", "tests", "fixtures", "docs", "e2e"]);
const ARTIFACT =
	/\.(?:apk|aab|aar|ap_|dex|class|deb|rpm|dmg|pkg|msi|exe|appimage|ipa|dll|dylib|node|wasm|bin|elf|o|obj|a|lib|pyc|pyo|pyd|jar|zip|tar|tgz|gz|bz2|xz|lz|lz4|lzma|zst|7z|rar|cab|iso|img|tsbuildinfo|map)$|\.so(?:\.\d+)*$/i;
const KEY = /\.(?:key|pem|der|crt|cer|p12|pfx|jks|keystore|kdbx|gpg|pgp)$/i;
const RUNTIME =
	/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$|\.(?:log(?:\.\d+)?|har|pcap|dmp|dump|heapdump|hprof)$/i;
const AUTH_FILE =
	/^(?:\.?(?:auth|credentials|tokens?|hosts|accounts|profiles|sessions|conversations)(?:\.(?:json|jsonl|ya?ml|toml))?|(?:service[-_]account|client[-_]secret)[^/]*\.json|(?:signing|keystore|key|local)\.properties|\.netrc|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|authorized_keys|known_hosts|google-services\.json|googleservice-info\.plist)$/i;

function git(cwd, args, input, maxBuffer = 64 * 1024 * 1024) {
	const result = spawnSync("git", ["-C", cwd, ...args], {
		input,
		encoding: null,
		maxBuffer,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
	});
	// Git errors can include configuration or credentials; never echo stderr.
	if (result.error || result.status !== 0) throw new Error("Cannot read Git metadata or objects.");
	return result.stdout;
}

function nulRecords(bytes) {
	const records = [];
	let start = 0;
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 0) {
			records.push(bytes.subarray(start, i));
			start = i + 1;
		}
	}
	if (start !== bytes.length) throw new Error("Malformed Git record stream.");
	return records;
}

function entry(record, tree = false) {
	const tab = record.indexOf(9);
	if (tab < 0) throw new Error("Malformed Git entry.");
	const [mode, second, third] = record.subarray(0, tab).toString("ascii").split(" ");
	const oid = tree ? third : second;
	if (!/^\d{6}$/.test(mode) || !OBJECT.test(oid)) throw new Error("Malformed Git object reference.");
	const path = new TextDecoder("utf-8", { fatal: true }).decode(record.subarray(tab + 1));
	return { mode, oid, path, stage: tree ? "0" : third };
}

function pathRules(path) {
	const parts = path.split("/");
	const base = parts.at(-1);
	const lower = base.toLowerCase();
	const dirs = parts.slice(0, -1).map((part) => part.toLowerCase());
	const rules = [];
	if (!path || path.startsWith("/") || parts.some((part) => !part || part === "." || part === ".."))
		rules.push("invalid-path");
	if (dirs.some((dir) => GENERATED.has(dir) || /\.(?:app|framework|xcarchive)$/.test(dir)))
		rules.push("generated-directory");
	if (dirs.some((dir) => PRIVATE.has(dir))) rules.push("private-data-directory");
	// Source modules named auth/sessions/history are not runtime profile folders.
	if (!dirs.some((dir) => SOURCE_CONTEXT.has(dir)) && dirs.some((dir) => RUNTIME_DIRS.has(dir)))
		rules.push("runtime-profile-directory");
	if (lower === ".env" || (lower.startsWith(".env.") && lower !== ".env.example"))
		rules.push("environment-file");
	if (AUTH_FILE.test(base) || KEY.test(base) || /firebase-adminsdk.*\.json$/i.test(base))
		rules.push("credential-or-private-config");
	if (RUNTIME.test(base) || /^(?:chats?|events)\.jsonl$/i.test(base)) rules.push("runtime-data-file");
	if (path !== WRAPPER.path && ARTIFACT.test(base)) rules.push("compiled-or-archive-file");
	return rules;
}

function magicRule(bytes) {
	const hex = bytes.subarray(0, 8).toString("hex");
	if (
		hex.startsWith("7f454c46") ||
		hex.startsWith("4d5a") ||
		["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].some(
			(value) => hex.startsWith(value),
		) ||
		hex.startsWith("0061736d") ||
		bytes.subarray(0, 4).equals(Buffer.from("dex\n")) ||
		bytes.subarray(0, 4).equals(Buffer.from("cdex"))
	)
		return "executable-or-bytecode-magic";
	if (
		[
			"504b0304",
			"504b0506",
			"504b0708",
			"1f8b",
			"1f9d",
			"1fa0",
			"377abcaf271c",
			"526172211a07",
			"fd377a585a00",
			"28b52ffd",
			"04224d18",
			"4d534346",
		].some((value) => hex.startsWith(value)) ||
		bytes.subarray(0, 3).equals(Buffer.from("BZh")) ||
		bytes.subarray(0, 8).equals(Buffer.from("!<arch>\n")) ||
		bytes.subarray(0, 8).equals(Buffer.from("!<thin>\n")) ||
		/^(070701|070702|070707)/.test(bytes.subarray(0, 6).toString("ascii")) ||
		bytes.subarray(257, 262).equals(Buffer.from("ustar")) ||
		bytes.subarray(32769, 32774).equals(Buffer.from("CD001"))
	)
		return "archive-magic";
	if (bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) return "runtime-database-magic";
	return undefined;
}

function objectInfo(cwd, oids) {
	const unique = [...new Set(oids)];
	if (!unique.length) return new Map();
	const lines = git(
		cwd,
		["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
		`${unique.join("\n")}\n`,
	)
		.toString("ascii")
		.trim()
		.split("\n");
	const result = new Map();
	for (const line of lines) {
		const [oid, type, rawSize] = line.split(" ");
		const size = Number(rawSize);
		if (!OBJECT.test(oid) || !Number.isSafeInteger(size) || size < 0)
			throw new Error("Missing or invalid Git object.");
		result.set(oid, { type, size });
	}
	return result;
}

/** Reads staged blobs, optionally all reachable history. Never scans working-tree files. */
export function checkRepository(cwd = ".", { history = false } = {}) {
	cwd = resolve(cwd);
	const entries = nulRecords(git(cwd, ["ls-files", "--stage", "-z"])).map((record) => entry(record));
	if (history) {
		const oids = git(cwd, ["rev-list", "--objects", "--all"])
			.toString("utf8")
			.split("\n")
			.map((line) => line.split(" ", 1)[0])
			.filter((oid) => OBJECT.test(oid));
		const reachable = objectInfo(cwd, oids);
		// Inspect every commit tree: one blob may have both safe and forbidden names.
		for (const [oid, info] of reachable) {
			if (info.type !== "commit") continue;
			entries.push(
				...nulRecords(git(cwd, ["ls-tree", "-r", "-z", "--full-tree", oid])).map((record) =>
					entry(record, true),
				),
			);
		}
		const named = new Set(entries.map((item) => item.oid));
		for (const [oid, info] of reachable) {
			if (info.type === "blob" && !named.has(oid))
				entries.push({ mode: "100644", stage: "0", oid, path: `<reachable-blob:${oid}>` });
		}
	}
	const info = objectInfo(
		cwd,
		entries.filter((item) => item.mode !== "160000").map((item) => item.oid),
	);
	const blobs = new Map();
	const findings = [];
	const seen = new Set();
	const seenEntries = new Set();
	const report = (item, rule) => {
		const identity = `${item.path}\0${rule}`;
		if (seen.has(identity)) return;
		seen.add(identity);
		findings.push({ path: item.path, rule, object: item.oid });
	};
	for (const item of entries) {
		const identity = `${item.mode}\0${item.oid}\0${item.stage}\0${item.path}`;
		if (seenEntries.has(identity)) continue;
		seenEntries.add(identity);
		if (item.stage !== "0") report(item, "unmerged-index");
		if (item.mode === "160000") {
			report(item, "gitlink-submodule");
			continue;
		}
		if (!["100644", "100755"].includes(item.mode)) report(item, "non-regular-file");
		for (const rule of pathRules(item.path)) report(item, rule);
		const metadata = info.get(item.oid);
		if (metadata?.type !== "blob") {
			report(item, "not-a-blob");
			continue;
		}
		if (metadata.size > MAX_BLOB_BYTES) {
			report(item, "blob-over-20-mib");
			continue;
		}
		if (!blobs.has(item.oid)) {
			const bytes = git(cwd, ["cat-file", "blob", item.oid], undefined, MAX_BLOB_BYTES + 65536);
			blobs.set(item.oid, {
				sha256: createHash("sha256").update(bytes).digest("hex"),
				rule: magicRule(bytes),
			});
		}
		const blob = blobs.get(item.oid);
		if (item.path === WRAPPER.path) {
			if (item.mode !== "100644" || blob.sha256 !== WRAPPER.sha256) report(item, "unapproved-gradle-wrapper");
		} else if (blob.rule) report(item, blob.rule);
	}
	findings.sort((a, b) => a.path.localeCompare(b.path) || a.rule.localeCompare(b.rule));
	return { history, entries: seenEntries.size, blobs: blobs.size, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args.includes("--help")) {
		console.log("Usage: node scripts/security/check-repository.mjs [--history] [repository]");
	} else {
		const paths = args.filter((arg) => !arg.startsWith("--"));
		if (paths.length > 1 || args.some((arg) => arg.startsWith("--") && arg !== "--history")) {
			console.error("Invalid arguments. Use --help.");
			process.exitCode = 2;
		} else {
			try {
				const result = checkRepository(paths[0] ?? ".", { history: args.includes("--history") });
				for (const finding of result.findings) console.error(JSON.stringify(finding));
				console.log(
					JSON.stringify({
						history: result.history,
						entries: result.entries,
						blobs: result.blobs,
						violations: result.findings.length,
					}),
				);
				process.exitCode = result.findings.length ? 1 : 0;
			} catch {
				console.error("Repository check failed: Git metadata or objects could not be safely inspected.");
				process.exitCode = 2;
			}
		}
	}
}
