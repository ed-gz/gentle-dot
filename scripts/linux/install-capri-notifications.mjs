#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ORIGINAL_HASHES = {
	"Main.qml": "a871bcd7d377fd7554b1c72f6c2b81687ef12297d14b770fdc9b4c83eafc3418",
	"notifications/NotificationPopups.qml": "c172c6fb73ec50363bee8d388b01ff043b6141b80ab2c90674a0ede5e14067dc",
};
export const HELPERS = ["CapriNotificationBridge.qml", "CapriNotificationPolicy.js"];
export const hash = (content) => createHash("sha256").update(content).digest("hex");

function replaceExactlyOnce(source, before, after) {
	const start = source.indexOf(before);
	if (start === -1 || source.indexOf(before, start + before.length) !== -1) {
		throw new Error("Unsupported Quickshell source: expected a unique notification anchor");
	}
	return source.slice(0, start) + after + source.slice(start + before.length);
}

export function patchMain(source) {
	let result = replaceExactlyOnce(
		source,
		"                activePopupsModel.append(notifData);\n                osdPopups.storeNotif(currentUid, n);",
		"                capriNotificationBridge.offer(notifData);",
	);
	result = replaceExactlyOnce(
		result,
		"    property var notifModel: globalNotificationHistory",
		`    // Capri delegates only the transient popup after the desktop frontend acknowledges it.
    CapriNotificationBridge {
        id: capriNotificationBridge
        doNotDisturb: !osdPopups.dndReady || osdPopups.dndEnabled
        onFallback: (notifData) => {
            activePopupsModel.append(notifData);
            osdPopups.storeNotif(notifData.uid, notifData.notif);
        }
    }

    property var notifModel: globalNotificationHistory`,
	);
	return result;
}

export function patchPopups(source) {
	let result = replaceExactlyOnce(
		source,
		"    property bool dndEnabled: false",
		"    property bool dndEnabled: false\n    property bool dndReady: false",
	);
	result = replaceExactlyOnce(
		result,
		'            onStreamFinished: popupWindow.dndEnabled = (this.text.trim() === "1")',
		`            onStreamFinished: {
                popupWindow.dndEnabled = (this.text.trim() === "1");
                popupWindow.dndReady = true;
            }`,
	);
	return result;
}

export async function prepare(sourceDirectory, outputDirectory) {
	const source = path.resolve(sourceDirectory);
	const output = path.resolve(outputDirectory);
	if (output === source || output.startsWith(`${source}${path.sep}`)) {
		throw new Error("Preparation must use a separate directory outside the live Quickshell configuration");
	}
	const originals = {};
	const files = {};
	for (const [name, expected] of Object.entries(ORIGINAL_HASHES)) {
		const content = await readFile(path.join(source, name), "utf8");
		if (hash(content) !== expected)
			throw new Error(`Source hash mismatch for ${name}; review its changes before installing`);
		originals[name] = content;
		files[name] = name === "Main.qml" ? patchMain(content) : patchPopups(content);
	}
	for (const name of HELPERS) files[name] = await readFile(path.join(HERE, "quickshell", name), "utf8");
	const manifest = { version: 1, source, originalHashes: ORIGINAL_HASHES, preparedHashes: {} };
	for (const [name, content] of Object.entries(files)) {
		const destination = path.join(output, name);
		await mkdir(path.dirname(destination), { recursive: true });
		await writeFile(destination, content);
		manifest.preparedHashes[name] = hash(content);
	}
	await writeFile(
		path.join(output, "capri-notifications-manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	return { manifest, originals, files };
}

/** Upgrade only our two helper files; the shell history/action/DND hooks stay byte-identical. */
export async function prepareUpgrade(previousDirectory, outputDirectory) {
	const previous = path.resolve(previousDirectory),
		output = path.resolve(outputDirectory);
	const old = JSON.parse(await readFile(path.join(previous, "capri-notifications-manifest.json"), "utf8"));
	if (old.version !== 1 || typeof old.source !== "string" || !old.preparedHashes)
		throw new Error("Invalid previous preparation manifest");
	const source = path.resolve(old.source);
	if (output === source || output.startsWith(`${source}${path.sep}`) || output === previous)
		throw new Error(
			"Upgrade preparation needs a separate directory outside live configuration and prior evidence",
		);
	const files = {},
		manifest = {
			version: 2,
			source,
			originalHashes: ORIGINAL_HASHES,
			previousPreparedHashes: old.preparedHashes,
			preparedHashes: {},
		};
	for (const name of [...Object.keys(ORIGINAL_HASHES), ...HELPERS]) {
		const current = await readFile(path.join(source, name), "utf8"),
			prior = await readFile(path.join(previous, name), "utf8");
		if (hash(current) !== old.preparedHashes[name] || hash(prior) !== old.preparedHashes[name])
			throw new Error(`Previously installed file changed: ${name}`);
		if (name in ORIGINAL_HASHES) {
			const original = await readFile(path.join(source, `${name}.before-capri`), "utf8");
			if (
				hash(original) !== ORIGINAL_HASHES[name] ||
				current !== (name === "Main.qml" ? patchMain(original) : patchPopups(original))
			)
				throw new Error(`Unrecognized original shell hook: ${name}`);
			files[name] = current;
		} else files[name] = await readFile(path.join(HERE, "quickshell", name), "utf8");
	}
	for (const [name, content] of Object.entries(files)) {
		const target = path.join(output, name);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, content);
		manifest.preparedHashes[name] = hash(content);
	}
	await writeFile(
		path.join(output, "capri-notifications-manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	return { manifest, files };
}

async function installUpgrade(output, manifest) {
	if (typeof manifest.source !== "string" || !manifest.previousPreparedHashes || !manifest.preparedHashes)
		throw new Error("Invalid preparation manifest");
	const files = {};
	for (const name of [...Object.keys(ORIGINAL_HASHES), ...HELPERS]) {
		const current = await readFile(path.join(manifest.source, name), "utf8"),
			prepared = await readFile(path.join(output, name), "utf8");
		if (hash(current) !== manifest.previousPreparedHashes[name])
			throw new Error(`Live file changed since upgrade review: ${name}`);
		if (hash(prepared) !== manifest.preparedHashes[name]) throw new Error(`Prepared file changed: ${name}`);
		if (name in ORIGINAL_HASHES) {
			const original = await readFile(path.join(manifest.source, `${name}.before-capri`), "utf8");
			if (
				hash(original) !== ORIGINAL_HASHES[name] ||
				current !== (name === "Main.qml" ? patchMain(original) : patchPopups(original)) ||
				prepared !== current
			)
				throw new Error(`Upgrade may not modify shell hooks: ${name}`);
		} else {
			if (prepared !== (await readFile(path.join(HERE, "quickshell", name), "utf8")))
				throw new Error(`Unexpected helper: ${name}`);
			const backup = path.join(manifest.source, `${name}.before-capri-v2-${hash(current).slice(0, 12)}`);
			if ((await exists(backup)) && hash(await readFile(backup)) !== hash(current))
				throw new Error(`Unrecognized upgrade backup: ${name}`);
			files[name] = { current, prepared, backup };
		}
	}
	for (const value of Object.values(files))
		if (!(await exists(value.backup))) await writeFile(value.backup, value.current, { flag: "wx" });
	// New policy still supports a legacy three-argument bridge during automatic QML reloads.
	for (const name of ["CapriNotificationPolicy.js", "CapriNotificationBridge.qml"]) {
		const destination = path.join(manifest.source, name),
			temporary = `${destination}.capri-upgrade-${process.pid}`;
		await writeFile(temporary, files[name].prepared);
		await rename(temporary, destination);
	}
	return manifest.source;
}

async function rollbackUpgrade(manifest) {
	if (typeof manifest.source !== "string" || !manifest.previousPreparedHashes || !manifest.preparedHashes)
		throw new Error("Invalid preparation manifest");
	const originals = {};
	for (const name of [...Object.keys(ORIGINAL_HASHES), ...HELPERS]) {
		if (hash(await readFile(path.join(manifest.source, name))) !== manifest.preparedHashes[name])
			throw new Error(`Installed file changed: ${name}; refusing to overwrite it`);
		if (HELPERS.includes(name)) {
			const expected = manifest.previousPreparedHashes[name];
			if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected))
				throw new Error("Invalid upgrade backup fingerprint");
			originals[name] = await readFile(
				path.join(manifest.source, `${name}.before-capri-v2-${expected.slice(0, 12)}`),
			);
			if (hash(originals[name]) !== expected) throw new Error(`Invalid upgrade backup: ${name}`);
		}
	}
	// Restore the old bridge first while the new policy still supports its legacy call.
	for (const name of ["CapriNotificationBridge.qml", "CapriNotificationPolicy.js"]) {
		const destination = path.join(manifest.source, name),
			temporary = `${destination}.capri-rollback-${process.pid}`;
		await writeFile(temporary, originals[name]);
		await rename(temporary, destination);
	}
	return manifest.source;
}

async function exists(file) {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

// Installation is explicit; preparation and checks never reload or modify Quickshell.
export async function installPrepared(outputDirectory) {
	const output = path.resolve(outputDirectory);
	const manifest = JSON.parse(await readFile(path.join(output, "capri-notifications-manifest.json"), "utf8"));
	if (manifest.version === 2) return installUpgrade(output, manifest);
	if (manifest.version !== 1 || typeof manifest.source !== "string")
		throw new Error("Invalid preparation manifest");
	const names = [...Object.keys(ORIGINAL_HASHES), ...HELPERS];
	const prepared = {};
	for (const name of names) {
		prepared[name] = await readFile(path.join(output, name), "utf8");
		if (hash(prepared[name]) !== manifest.preparedHashes[name])
			throw new Error(`Prepared file changed: ${name}`);
		if (name in ORIGINAL_HASHES) {
			const source = await readFile(path.join(manifest.source, name), "utf8");
			if (hash(source) !== ORIGINAL_HASHES[name]) throw new Error(`Live file changed since review: ${name}`);
			const expected = name === "Main.qml" ? patchMain(source) : patchPopups(source);
			if (prepared[name] !== expected) throw new Error(`Unexpected patch: ${name}`);
			const backup = path.join(manifest.source, `${name}.before-capri`);
			if ((await exists(backup)) && hash(await readFile(backup)) !== ORIGINAL_HASHES[name])
				throw new Error(`Unrecognized backup: ${name}.before-capri`);
		} else {
			if (prepared[name] !== (await readFile(path.join(HERE, "quickshell", name), "utf8")))
				throw new Error(`Unexpected helper: ${name}`);
			if (await exists(path.join(manifest.source, name))) throw new Error(`Helper already exists: ${name}`);
		}
	}
	// Helpers and DND state arrive before the Main.qml reference, with original files backed up.
	for (const name of Object.keys(ORIGINAL_HASHES))
		await copyFile(path.join(manifest.source, name), path.join(manifest.source, `${name}.before-capri`));
	for (const name of [...HELPERS, "notifications/NotificationPopups.qml", "Main.qml"]) {
		const destination = path.join(manifest.source, name);
		const temporary = `${destination}.capri-install-${process.pid}`;
		await writeFile(temporary, prepared[name]);
		await rename(temporary, destination);
	}
	return manifest.source;
}

export async function rollbackPrepared(outputDirectory) {
	const output = path.resolve(outputDirectory);
	const manifest = JSON.parse(await readFile(path.join(output, "capri-notifications-manifest.json"), "utf8"));
	if (manifest.version === 2) return rollbackUpgrade(manifest);
	if (manifest.version !== 1 || typeof manifest.source !== "string")
		throw new Error("Invalid preparation manifest");
	const originals = {};
	for (const name of [...Object.keys(ORIGINAL_HASHES), ...HELPERS]) {
		const current = await readFile(path.join(manifest.source, name));
		if (hash(current) !== manifest.preparedHashes[name])
			throw new Error(`Installed file changed: ${name}; refusing to overwrite it`);
		if (name in ORIGINAL_HASHES) {
			originals[name] = await readFile(path.join(manifest.source, `${name}.before-capri`));
			if (hash(originals[name]) !== ORIGINAL_HASHES[name]) throw new Error(`Invalid backup: ${name}`);
		}
	}
	// Remove Main's reference first, then restore DND and remove only unchanged helper files.
	for (const name of ["Main.qml", "notifications/NotificationPopups.qml"]) {
		const destination = path.join(manifest.source, name);
		const temporary = `${destination}.capri-rollback-${process.pid}`;
		await writeFile(temporary, originals[name]);
		await rename(temporary, destination);
	}
	for (const name of HELPERS) await unlink(path.join(manifest.source, name));
	return manifest.source;
}

async function main(args) {
	if (args[0] === "--prepare-upgrade" && args.length === 3) {
		const { manifest } = await prepareUpgrade(args[1], args[2]);
		console.log(
			`Prepared ${HELPERS.length} helper updates in ${path.resolve(args[2])}; live shell hooks and configuration unchanged.`,
		);
		return manifest;
	}
	if (args[0] === "--rollback" && args.length === 2) {
		console.log(
			`Restored original notifications in ${await rollbackPrepared(args[1])}. Backups retained; no reload was requested.`,
		);
		return;
	}
	if (args[0] === "--apply" && args.length === 2) {
		console.log(
			`Installed reviewed notification bridge in ${await installPrepared(args[1])}. No reload was requested.`,
		);
		return;
	}
	if (args[0] !== "--prepare" || args.length < 2 || args.length > 3) {
		throw new Error(
			"Usage: node scripts/linux/install-capri-notifications.mjs --prepare <separate-output-directory> [quickshell-source-directory]\nFor an existing bridge: --prepare-upgrade <previous-prepared-directory> <new-output-directory>.\nReview that output, then explicitly install with --apply <prepared-directory>, or undo with --rollback <prepared-directory>. This installer never requests a Quickshell reload; the shell may watch its own files.",
		);
	}
	const source = args[2] || path.join(os.homedir(), ".config/hypr/scripts/quickshell");
	const { manifest } = await prepare(source, args[1]);
	console.log(
		`Prepared ${Object.keys(manifest.preparedHashes).length} files in ${path.resolve(args[1])}; live configuration unchanged.`,
	);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
