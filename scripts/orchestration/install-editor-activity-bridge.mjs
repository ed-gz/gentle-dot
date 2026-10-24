import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bridge = join(root, "packages/daemon/src/orchestration/editor-activity-bridge.ts");
const hash = (source) => createHash("sha256").update(source).digest("hex");
const supported = new Set([
	"5f94322105e1d6ff031c0228cd06297a0b488dfb2f0bcd9842d68eb377a3f8ff", // Packaged gentle-pi 4.0.0
	"98f0e96bf1379f8d3fd18dd1f5a09241a679b69d09ec4393384f77c106ac59b0", // Installed source, inspected 2026-10-23
]);
const relative = "extensions/gentle-shell.ts";

export function prepareEditorActivityBridge(directory) {
	const source = readFileSync(join(directory, relative), "utf8");
	if (!supported.has(hash(source)))
		throw new Error("Unsupported Gentle Shell editor source. Nothing was changed.");
	if (!existsSync(bridge)) throw new Error("The Gentle Dot editor activity bridge is unavailable.");
	const before = "\t\t\t\tprompt = created;";
	if (source.split(before).length !== 2) throw new Error("The verified editor insertion point changed.");
	return {
		[relative]: `import { installEditorActivityBridge } from ${JSON.stringify(bridge)};\n${source.replace(
			before,
			`${before}\n\t\t\t\tinstallEditorActivityBridge(prompt, pi.events, ctx.sessionManager.getSessionId());`,
		)}`,
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const directory = args.find((value) => !value.startsWith("--"));
	if (!directory || args.some((value) => value.startsWith("--") && !["--check", "--apply"].includes(value)))
		throw new Error(
			"Usage: node scripts/orchestration/install-editor-activity-bridge.mjs <gentle-pi-directory> [--check|--apply]. Default: check only.",
		);
	const prepared = prepareEditorActivityBridge(resolve(directory));
	for (const [relative, source] of Object.entries(prepared))
		console.log(`${relative}: prepared SHA-256 ${hash(source)}`);
	if (args.includes("--apply")) {
		prepareEditorActivityBridge(resolve(directory));
		for (const [relative, source] of Object.entries(prepared)) {
			const path = join(resolve(directory), relative);
			const backup = `${path}.before-gentle-dot-editor-activity`;
			if (existsSync(backup)) throw new Error("Backup already exists; refusing to overwrite it.");
			copyFileSync(path, backup);
			writeFileSync(`${path}.gentle-dot-activity-pending`, source, { flag: "wx" });
			renameSync(`${path}.gentle-dot-activity-pending`, path);
		}
		console.log(
			"Editor activity bridge installed for future editor construction. Existing loaded editors are unchanged.",
		);
	}
}
