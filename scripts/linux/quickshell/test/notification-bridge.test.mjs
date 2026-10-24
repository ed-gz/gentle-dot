import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import {
	hash,
	installPrepared,
	ORIGINAL_HASHES,
	patchMain,
	patchPopups,
	prepare,
	prepareUpgrade,
	rollbackPrepared,
} from "../../install-capri-notifications.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const policySource = await readFile(path.join(HERE, "..", "CapriNotificationPolicy.js"), "utf8");
const policy = vm.createContext({});
vm.runInContext(policySource.replace(/^\.pragma library\s*/, ""), policy);

test("file reactions require exact producer metadata; messages, errors and auth remain conversational", async () => {
	const fixtures = JSON.parse(await readFile(path.join(HERE, "fixtures", "notification-kinds.json"), "utf8"));
	for (const fixture of fixtures)
		assert.equal(
			policy.notificationKind(fixture.source, fixture.summary, fixture.body),
			fixture.kind,
			JSON.stringify(fixture),
		);
});

test("V2 carries bounded source metadata without inferring authors or changing message text", () => {
	const source = policy.notificationSource({
		appName: "Slack",
		summary: "Nuevo mensaje en General",
		body: "Alex Rivera: Screenshot Saved",
		notif: { desktopEntry: "com.slack.Slack", urgency: 1, hints: { category: "im.received" } },
	});
	assert.deepEqual(JSON.parse(JSON.stringify(source)), {
		appName: "Slack",
		desktopEntry: "com.slack.Slack",
		category: "im.received",
		urgency: 1,
	});
	const command = Array.from(policy.offerCommand("id", "Original title", "Original body", source));
	assert.equal(command[8], "io.gentledot.Companion1.OfferNotificationV2");
	assert.equal(command[12], "'Original title'");
	assert.equal(command[13], "'Original body'");
	assert.equal(command[14], policy.variantString(JSON.stringify(source), 8192));
	const explicit = policy.notificationSource({
		appName: "x".repeat(500),
		notif: { hints: { "x-gentle-sender": "Ana", "x-gentle-conversation": "General" } },
	});
	assert.equal(explicit.appName.length, 160);
	assert.equal(explicit.sender, "Ana");
	assert.equal(explicit.conversation, "General");
});

test("D-Bus arguments use bounded explicit GVariant strings without shell interpretation", () => {
	const text = "a'b\\c\n\t\r\0\" $(touch /tmp/should-never-exist) `id`";
	const command = Array.from(policy.offerCommand("qs-id-1", text, "z".repeat(9000)));
	assert.deepEqual(command.slice(0, 11), [
		"gdbus",
		"call",
		"--session",
		"--dest",
		"io.gentledot.Companion",
		"--object-path",
		"/io/gentledot/Companion",
		"--method",
		"io.gentledot.Companion1.OfferNotification",
		"--timeout",
		"1",
	]);
	assert.equal(command[11], "'qs-id-1'");
	assert.equal(command[12], "'a\\'b\\\\c\\n\\t\\r\" $(touch /tmp/should-never-exist) `id`'");
	assert.equal(command[13], `'${"z".repeat(4096)}'`);
	assert.equal(policy.variantString("a".repeat(999), 160).length, 162);
	assert.equal(Array.from(policy.cancelCommand("qs-id-1")).at(-1), "'qs-id-1'");
});

test("only the exact successful D-Bus boolean tuple accepts notification ownership", () => {
	assert.equal(policy.acceptedReply("(true,)\n", 0, 0), true);
	for (const value of ["true", "(false,)", "(true,)extra", "(true, false)", "", "\n(true,)"]) {
		assert.equal(policy.acceptedReply(value, 0, 0), false, value);
	}
	assert.equal(policy.acceptedReply("(true,)", 1, 0), false);
	assert.equal(policy.acceptedReply("(true,)", 0, 1), false);
});

const history = `            n.tracked = true;
            masterWindow.liveNotifs[currentUid] = n;
            let notifData = { uid: currentUid, notif: n, actionsJson: JSON.stringify(extractedActions) };
            globalNotificationHistory.insert(0, notifData);
            if (!masterWindow.isStartup) {
                activePopupsModel.append(notifData);
                osdPopups.storeNotif(currentUid, n);
            }`;

test("patch changes only popup dispatch and preserves live notification/history/action objects", () => {
	const source = `import QtQuick\nItem {\n${history}\n    property var notifModel: globalNotificationHistory\n}`;
	const result = patchMain(source);
	const unchangedPrefix = history.slice(0, history.indexOf("                activePopupsModel"));
	assert.ok(result.includes(unchangedPrefix));
	assert.ok(
		result.includes(
			"if (!masterWindow.isStartup) {\n                capriNotificationBridge.offer(notifData);",
		),
	);
	assert.equal((result.match(/activePopupsModel\.append/g) || []).length, 1);
	assert.ok(result.includes("osdPopups.storeNotif(notifData.uid, notifData.notif)"));
	assert.ok(result.includes("doNotDisturb: !osdPopups.dndReady || osdPopups.dndEnabled"));
	assert.throws(() => patchMain(result), /unique notification anchor/);
	assert.throws(() => patchMain(source + source), /unique notification anchor/);
});

test("DND remains unknown until its existing reader finishes, keeping its prior parsing unchanged", () => {
	const source = `Item {\n    property bool dndEnabled: false\n    Process {\n        stdout: StdioCollector {\n            onStreamFinished: popupWindow.dndEnabled = (this.text.trim() === "1")\n        }\n    }\n}`;
	const result = patchPopups(source);
	assert.ok(result.includes("property bool dndReady: false"));
	assert.ok(
		result.indexOf('popupWindow.dndEnabled = (this.text.trim() === "1");') <
			result.indexOf("popupWindow.dndReady = true;"),
	);
	assert.throws(() => patchPopups(result), /unique notification anchor/);
});

test("prepare refuses unknown shell versions and refuses writing inside live configuration", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "capri-prepare-test-"));
	try {
		const source = path.join(root, "source");
		await mkdir(source);
		await writeFile(path.join(source, "Main.qml"), "a different user's configuration");
		await assert.rejects(prepare(source, path.join(root, "staged")), /Source hash mismatch/);
		await assert.rejects(prepare(source, path.join(source, "staged")), /outside the live/);
		assert.equal(await readFile(path.join(source, "Main.qml"), "utf8"), "a different user's configuration");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("apply refuses an invalid prepared manifest before touching a live configuration", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "capri-apply-test-"));
	try {
		await writeFile(path.join(root, "capri-notifications-manifest.json"), JSON.stringify({ version: 2 }));
		await assert.rejects(installPrepared(root), /Invalid preparation manifest/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reviewed installation succeeds on an isolated copy and preserves exact backups", {
	skip: !process.env.CAPRI_QUICKSHELL_SOURCE,
}, async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "capri-install-copy-"));
	try {
		const source = path.join(root, "source");
		const stage = path.join(root, "stage");
		for (const name of Object.keys(ORIGINAL_HASHES)) {
			await mkdir(path.dirname(path.join(source, name)), { recursive: true });
			await copyFile(path.join(process.env.CAPRI_QUICKSHELL_SOURCE, name), path.join(source, name));
		}
		const { manifest, files } = await prepare(source, stage);
		await writeFile(path.join(stage, "CapriNotificationBridge.qml"), "unexpected edit");
		await assert.rejects(installPrepared(stage), /Prepared file changed/);
		assert.equal(hash(await readFile(path.join(source, "Main.qml"))), ORIGINAL_HASHES["Main.qml"]);
		await writeFile(path.join(stage, "CapriNotificationBridge.qml"), files["CapriNotificationBridge.qml"]);
		assert.equal(await installPrepared(stage), source);
		for (const name of Object.keys(ORIGINAL_HASHES)) {
			assert.equal(hash(await readFile(path.join(source, `${name}.before-capri`))), ORIGINAL_HASHES[name]);
		}
		for (const [name, expected] of Object.entries(manifest.preparedHashes)) {
			assert.equal(hash(await readFile(path.join(source, name))), expected);
		}
		await assert.rejects(installPrepared(stage), /Live file changed since review/);
		await writeFile(path.join(source, "CapriNotificationBridge.qml"), "user adjustment");
		await assert.rejects(rollbackPrepared(stage), /Installed file changed/);
		await writeFile(path.join(source, "CapriNotificationBridge.qml"), files["CapriNotificationBridge.qml"]);
		assert.equal(await rollbackPrepared(stage), source);
		for (const [name, expected] of Object.entries(ORIGINAL_HASHES)) {
			assert.equal(hash(await readFile(path.join(source, name))), expected);
		}
		assert.equal(await installPrepared(stage), source);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("real Quickshell fixture: ACK, fallback, DND, close, timeout, duplicate, capacity", {
	timeout: 20000,
}, async (context) => {
	try {
		await run("quickshell", ["--version"]);
	} catch {
		context.skip("Quickshell runtime is unavailable");
		return;
	}
	const root = await mkdtemp(path.join(os.tmpdir(), "capri-qml-test-"));
	try {
		for (const name of ["CapriNotificationBridge.qml", "CapriNotificationPolicy.js"]) {
			await copyFile(path.join(HERE, "..", name), path.join(root, name));
		}
		const fixture = await readFile(path.join(HERE, "fixtures", "BridgeFixture.qml"), "utf8");
		await writeFile(path.join(root, "shell.qml"), fixture.replace('import "../.."', 'import "."'));
		await copyFile(path.join(HERE, "fixtures", "fake-reply.mjs"), path.join(root, "fake-reply.mjs"));
		const env = { ...process.env, QT_QPA_PLATFORM: "offscreen" };
		delete env.WAYLAND_DISPLAY;
		const result = await run("quickshell", ["--no-color", "--path", path.join(root, "shell.qml")], {
			env,
			timeout: 15000,
		});
		const output = result.stdout + result.stderr;
		assert.match(output, /CAPRI_FIXTURE_PASSED: 45/);
		assert.doesNotMatch(output, /CAPRI_FIXTURE_FAILED|ReferenceError|TypeError|Private text/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("V2 helper upgrade and rollback preserve live history/action hooks and exact old helpers", {
	skip: !process.env.CAPRI_QUICKSHELL_PREVIOUS,
}, async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "capri-upgrade-copy-"));
	try {
		const previous = path.join(root, "previous"),
			source = path.join(root, "source"),
			stage = path.join(root, "stage");
		const old = JSON.parse(
			await readFile(
				path.join(process.env.CAPRI_QUICKSHELL_PREVIOUS, "capri-notifications-manifest.json"),
				"utf8",
			),
		);
		for (const name of Object.keys(old.preparedHashes)) {
			for (const dir of [previous, source]) {
				await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
				await copyFile(path.join(process.env.CAPRI_QUICKSHELL_PREVIOUS, name), path.join(dir, name));
			}
			if (name in ORIGINAL_HASHES)
				await copyFile(
					path.join(old.source, `${name}.before-capri`),
					path.join(source, `${name}.before-capri`),
				);
		}
		old.source = source;
		await writeFile(path.join(previous, "capri-notifications-manifest.json"), JSON.stringify(old));
		const { manifest, files } = await prepareUpgrade(previous, stage);
		assert.notEqual(
			manifest.preparedHashes["CapriNotificationPolicy.js"],
			old.preparedHashes["CapriNotificationPolicy.js"],
		);
		await writeFile(path.join(stage, "CapriNotificationPolicy.js"), "unreviewed change");
		await assert.rejects(installPrepared(stage), /Prepared file changed/);
		await writeFile(path.join(stage, "CapriNotificationPolicy.js"), files["CapriNotificationPolicy.js"]);
		assert.equal(await installPrepared(stage), source);
		for (const name of Object.keys(ORIGINAL_HASHES))
			assert.equal(hash(await readFile(path.join(source, name))), old.preparedHashes[name]);
		for (const name of ["CapriNotificationPolicy.js", "CapriNotificationBridge.qml"]) {
			assert.equal(hash(await readFile(path.join(source, name))), manifest.preparedHashes[name]);
			assert.equal(
				hash(
					await readFile(
						path.join(source, `${name}.before-capri-v2-${old.preparedHashes[name].slice(0, 12)}`),
					),
				),
				old.preparedHashes[name],
			);
		}
		await writeFile(path.join(source, "CapriNotificationBridge.qml"), "user edit");
		await assert.rejects(rollbackPrepared(stage), /Installed file changed/);
		await writeFile(path.join(source, "CapriNotificationBridge.qml"), files["CapriNotificationBridge.qml"]);
		assert.equal(await rollbackPrepared(stage), source);
		for (const name of Object.keys(old.preparedHashes))
			assert.equal(hash(await readFile(path.join(source, name))), old.preparedHashes[name]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
