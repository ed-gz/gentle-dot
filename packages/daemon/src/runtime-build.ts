import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const LOCKFILE = join(PACKAGE, "..", "..", "pnpm-lock.yaml");
const IMPORTER = "packages/daemon";
const CONSENT_PATCH = join(PACKAGE, "..", "..", "patches", "gentle-pi@4.0.0.patch");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** npm installs the packaged runtime, so pnpm's workspace patch metadata alone is insufficient. */
export const consentPatchInstaller = `import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('./', import.meta.url);
const hash = text => createHash('sha256').update(text).digest('hex');
const descriptor = JSON.parse(readFileSync(new URL('review-consent-patch.json', root), 'utf8'));
const patch = readFileSync(new URL('gentle-pi@4.0.0.patch', root), 'utf8');
if (hash(patch) !== descriptor.patchSha256) throw new Error('Review consent patch integrity mismatch');
const pkg = new URL('node_modules/gentle-pi/', root);
if (JSON.parse(readFileSync(new URL('package.json', pkg), 'utf8')).version !== '4.0.0') throw new Error('Unsupported Gentle Pi consent version');
const updates = descriptor.files.map(file => {
  if (!['extensions/gentle-ai.ts', 'lib/review-consent-ui.ts'].includes(file.path)) throw new Error('Unexpected consent patch path');
  if (hash(file.content) !== file.afterSha256) throw new Error('Patched provider content integrity mismatch');
  const target = new URL(file.path, pkg);
  const current = hash(readFileSync(target, 'utf8'));
  if (current !== file.beforeSha256 && current !== file.afterSha256) throw new Error('Unsupported Gentle Pi consent source: ' + file.path);
  return { target, content: file.content, changed: current !== file.afterSha256 };
});
for (const file of updates) if (file.changed) writeFileSync(file.target, file.content);
console.log('Gentle Pi 4.0.0 review consent patch verified: ' + descriptor.patchSha256);
`;

/** Reverse the committed patch against installed bytes; never package an unrelated local edit. */
export function reviewConsentPatchFiles(patch: string, readInstalled: (path: string) => string) {
	const expected: Record<string, string> = {
		"extensions/gentle-ai.ts": "c68a70a8c2cfe2841e8dbdf031cd6767746c185f1b624d1f75915257c3fe6109",
		"lib/review-consent-ui.ts": "901e18ba765ea8481eb71c39804b7616781e007429781190da41a884c52d313d",
	};
	const files = patch.split(/^diff --git /m).slice(1).map(block => {
		const path = block.match(/^a\/(\S+) b\/\1\n/)?.[1];
		if (!path || !["extensions/gentle-ai.ts", "lib/review-consent-ui.ts"].includes(path))
			throw new Error("Unexpected review consent patch path");
		const content = readInstalled(path);
		if (sha256(content) !== expected[path]) throw new Error("Unsupported installed review consent source");
		const lines = content.split("\n");
		let delta = 0;
		for (const hunk of block.split(/^@@ /m).slice(1)) {
			const header = hunk.match(/^-\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@[^\n]*\n/);
			if (!header) throw new Error("Invalid review consent patch hunk");
			const body = hunk.slice(header[0].length).split("\n").filter(line => /^[ +\-]/.test(line));
			const before = body.filter(line => !line.startsWith("+")).map(line => line.slice(1));
			const after = body.filter(line => !line.startsWith("-")).map(line => line.slice(1));
			const start = Number(header[1]) - 1 + delta;
			if (JSON.stringify(lines.slice(start, start + after.length)) !== JSON.stringify(after))
				throw new Error("Installed provider does not match the committed review consent patch");
			lines.splice(start, after.length, ...before);
			delta += before.length - after.length;
		}
		return { path, original: lines.join("\n"), content, beforeSha256: sha256(lines.join("\n")), afterSha256: sha256(content) };
	});
	if (files.length !== 2 || new Set(files.map(file => file.path)).size !== 2)
		throw new Error("Incomplete review consent patch");
	return files;
}

/**
 * The exact versions pnpm installed for the daemon's own dependencies, read from
 * the `importers` section of the lockfile; workspace links are left out.
 */
export function lockedDependencies(
	lockfile: string = readFileSync(LOCKFILE, "utf8"),
): Record<string, string> {
	const versions: Record<string, string> = {};
	let section: "importer" | "dependencies" | undefined;
	let name: string | undefined;
	for (const line of lockfile.split("\n")) {
		if (/^ {2}\S/.test(line)) section = line.trim() === `${IMPORTER}:` ? "importer" : undefined;
		else if (section && /^ {4}\S/.test(line))
			section = line.trim() === "dependencies:" ? "dependencies" : "importer";
		else if (section === "dependencies" && /^ {6}\S/.test(line))
			name = line.trim().slice(0, -1).replace(/^'|'$/g, "");
		else if (section === "dependencies" && name && /^ {8}version: /.test(line)) {
			const version = line.trim().slice("version: ".length).split("(")[0] ?? "";
			if (!version.startsWith("link:")) versions[name] = version;
		}
	}
	if (Object.keys(versions).length === 0) throw new Error(`No ${IMPORTER} dependencies in the lockfile.`);
	return versions;
}

/** A `pi` command that runs the runtime's own Node on the engine, from wherever the runtime folder is. */
export function piWrapper(engineEntry: string): string {
	return `#!/bin/sh
# The engine's \`pi\` command for an installed Gentle Dot runtime (generated by build:runtime).
self=$0
while [ -L "$self" ]; do
	link=$(readlink "$self")
	case $link in
		/*) self=$link ;;
		*) self=$(dirname "$self")/$link ;;
	esac
done
runtime=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd -P) || exit 1
exec "$runtime/node/bin/node" "$runtime/daemon/node_modules/${engineEntry}" "$@"
`;
}

/** The engine's `pi` entry inside `node_modules`, from its package's `bin` (its exports hide `package.json`). */
function engineEntry(): string {
	const engine = join("@earendil-works", "pi-coding-agent");
	const require = createRequire(join(PACKAGE, "package.json"));
	for (const dir of require.resolve.paths(engine) ?? []) {
		const manifest = join(dir, engine, "package.json");
		if (!existsSync(manifest)) continue;
		const bin = (JSON.parse(readFileSync(manifest, "utf8")) as { bin?: Record<string, string> }).bin?.pi;
		if (!bin) throw new Error("The engine package has no `pi` command.");
		return `@earendil-works/pi-coding-agent/${bin.replace(/^\.\//, "")}`;
	}
	throw new Error("The assistant engine is missing. Run `pnpm install`.");
}

/**
 * Builds the daemon part of the installed runtime into `outDir`: `daemon/cli.mjs`
 * (the daemon and the protocol bundled; the engine and `ws` external), the files it
 * finds next to itself, a `package.json` for a flat install of the external
 * dependencies, and `bin/pi`. Nothing is installed.
 */
export async function buildRuntime(outDir: string): Promise<void> {
	const daemon = join(outDir, "daemon");
	mkdirSync(join(daemon, "extensions"), { recursive: true });
	mkdirSync(join(outDir, "bin"), { recursive: true });
	const dependencies = lockedDependencies();
	await build({
		entryPoints: [join(PACKAGE, "src", "cli.ts")],
		outfile: join(daemon, "cli.mjs"),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node24",
		external: Object.keys(dependencies),
		logLevel: "error",
	});
	chmodSync(join(daemon, "cli.mjs"), 0o755);
	// The bundle finds these through `import.meta.url`, as the sources do in `src/`.
	copyFileSync(join(PACKAGE, "src", "identity.md"), join(daemon, "identity.md"));
	// Loaded by the workflow extension outside the daemon bundle.
	copyFileSync(join(PACKAGE, "src", "workflow-authorization.ts"), join(daemon, "workflow-authorization.ts"));
	copyFileSync(join(PACKAGE, "src", "history-recall.ts"), join(daemon, "history-recall.ts"));
	copyFileSync(join(PACKAGE, "src", "terminal-mood.py"), join(daemon, "terminal-mood.py"));
	// The engine loads the guard with -e, and the guard imports its siblings.
	for (const name of [
		"approval-guard.ts",
		"background-turn.ts",
		"screenshot-context.ts",
		"dot-orchestrator.ts",
		"dot-browser.ts",
		"dot-share-file.ts",
		"dot-completions.ts",
		"dot-live-input.ts",
		"dot-companion.ts",
		"dot-history.ts",
		"dot-workflows.ts",
		"dot-watch.ts",
		"dot-session.ts",
	]) {
		copyFileSync(join(PACKAGE, "src", "extensions", name), join(daemon, "extensions", name));
	}
	mkdirSync(join(daemon, "orchestration"), { recursive: true });
	for (const name of [
		"herdr.ts",
		"process-identity.ts",
		"activity.ts",
		"companion-activity.ts",
        "editor-geometry.ts",
		"activity-files.ts",
		"delivery.ts",
		"questions.ts",
		"review-consent.ts",
		"review-consent-presentation.ts",
		"session-info.ts",
		"session-copy.ts",
		"session-attachments.ts",
		"transcript.ts",
	])
		copyFileSync(join(PACKAGE, "src", "orchestration", name), join(daemon, "orchestration", name));
	const require = createRequire(join(PACKAGE, "package.json"));
	const provider = join(require.resolve("gentle-pi/package.json"), "..");
	const patch = readFileSync(CONSENT_PATCH, "utf8");
	const files = reviewConsentPatchFiles(patch, path => readFileSync(join(provider, path), "utf8"))
		.map(({ original: _original, ...file }) => file);
	copyFileSync(CONSENT_PATCH, join(daemon, "gentle-pi@4.0.0.patch"));
	writeFileSync(join(daemon, "review-consent-patch.json"), JSON.stringify({ version: "4.0.0", patchSha256: sha256(patch), files }));
	writeFileSync(join(daemon, "apply-review-consent-patch.mjs"), consentPatchInstaller);
	const manifest = {
		name: "gentle-dot-runtime", private: true, type: "module", dependencies,
		scripts: { postinstall: "node apply-review-consent-patch.mjs" },
	};
	writeFileSync(join(daemon, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	writeFileSync(join(outDir, "bin", "pi"), piWrapper(engineEntry()), { mode: 0o755 });
}
