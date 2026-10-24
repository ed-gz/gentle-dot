#!/usr/bin/env node
/** Linux-only runtime smoke: a new private server + hidden Kitty client, never a user's session. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { localRequest } from "../../../packages/daemon/src/orchestration/herdr.ts";
import {
	readHerdrLayout,
	parseHerdrLayout,
} from "../../../packages/daemon/src/orchestration/herdr-layout.ts";
import { processIdentity } from "../../../packages/daemon/src/orchestration/process-identity.ts";
import { terminalProcessTree } from "../../../packages/daemon/src/terminal-mood.ts";

const args = process.argv.slice(2);
const required = (key) => {
	const i = args.indexOf(key),
		value = args[i + 1];
	if (i < 0 || !value || !isAbsolute(value)) throw new Error(`${key} requires an absolute path`);
	return resolve(value);
};
const build = required("--build"),
	output = required("--output");
const binary = join(build, "target", "release", "herdr");
const proof = JSON.parse(readFileSync(join(build, "companion-build.json"), "utf8"));
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
assert.equal(hash(binary), proof.binarySha256, "build binary must match provenance");
assert.equal(
	proof.patchSha256,
	JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "source.json"), "utf8")).patchSha256,
);
assert.equal(existsSync(output), false, "smoke evidence is never overwritten");
const base = mkdtempSync(join(tmpdir(), "gentle-dot-herdr-smoke-"));
const layouts = join(base, "layouts"),
	config = join(base, "config.toml"),
	socket = join(base, "qa.sock"),
	control = join(base, "kitty.sock");
for (const dir of [layouts, "config", "state", "data", "cache"].map((p) =>
	isAbsolute(p) ? p : join(base, p),
))
	mkdirSync(dir, { mode: 0o700 });
writeFileSync(
	config,
	'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n[ui.toast]\ndelivery = "off"\n',
	{ mode: 0o600 },
);
const env = { ...process.env };
for (const key of Object.keys(env))
	if (
		key.startsWith("HERDR_") ||
		key.startsWith("GENTLE_DOT_") ||
		["KITTY_PID", "KITTY_WINDOW_ID", "KITTY_LISTEN_ON", "ENV", "BASH_ENV", "ZDOTDIR"].includes(key)
	)
		delete env[key];
Object.assign(env, {
	HERDR_SOCKET_PATH: socket,
	HERDR_CONFIG_PATH: config,
	HERDR_STARTUP_CWD: base,
	HERDR_DISABLE_SOUND: "1",
	SHELL: "/bin/sh",
	XDG_CONFIG_HOME: join(base, "config"),
	XDG_STATE_HOME: join(base, "state"),
	XDG_DATA_HOME: join(base, "data"),
	XDG_CACHE_HOME: join(base, "cache"),
});
const children = [];
const start = (program, argv, childEnv = env) => {
	const child = spawn(program, argv, {
		cwd: base,
		env: childEnv,
		detached: true,
		stdio: ["ignore", "ignore", "pipe"],
	});
	children.push(child);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		if (stderr.length < 8192) stderr += chunk;
	});
	child.on("error", () => {});
	child.diagnostic = () => stderr;
	return child;
};
const until = async (fn, label, timeout = 15000) => {
	const stop = Date.now() + timeout;
	let last;
	while (Date.now() < stop) {
		try {
			const v = await fn();
			if (v) return v;
		} catch (e) {
			last = e;
		}
		await delay(100);
	}
	throw new Error(`${label} timed out${last ? `: ${last.message}` : ""}`);
};
const ownReport = () => {
	const files = readdirSync(layouts).filter((f) => /^\d+\.json$/.test(f));
	return files.length === 1 ? JSON.parse(readFileSync(join(layouts, files[0]), "utf8")) : undefined;
};
const kitty = (...argv) => {
	const r = spawnSync("kitty", ["@", "--to", `unix:${control}`, ...argv], {
		env,
		encoding: "utf8",
		timeout: 4000,
	});
	if (r.status !== 0) throw new Error(r.stderr || "Kitty command failed");
	return r.stdout;
};
const activeWindow = () => {
	const r = spawnSync("hyprctl", ["activewindow", "-j"], { encoding: "utf8", timeout: 2000 });
	if (r.status !== 0) return null;
	try {
		const w = JSON.parse(r.stdout);
		return { address: w.address ?? null, pid: w.pid ?? null };
	} catch {
		return null;
	}
};
const beforeFocus = activeWindow();
let clientPid,
	clientIdentity,
	paused = false,
	success;
try {
	const server = start(binary, ["server"]);
	await until(() => existsSync(socket), "isolated server");
	const snapshot = await localRequest(socket, "pane.list");
	assert.ok(snapshot.panes?.length > 0, "isolated server has its own fixture pane");
	const paneId = snapshot.panes[0].pane_id;
	assert.equal(typeof paneId, "string");
	const terminal = start(
		"kitty",
		[
			"--config",
			"NONE",
			"--start-as",
			"hidden",
			"--listen-on",
			`unix:${control}`,
			"--override",
			"allow_remote_control=socket-only",
			"--override",
			"initial_window_width=100c",
			"--override",
			"initial_window_height=30c",
			"--title",
			`Gentle Dot isolated Herdr ${process.pid}`,
			binary,
			"client",
		],
		{ ...env, GENTLE_DOT_COMPANION_LAYOUT_DIR: layouts },
	);
	const report = await until(
		() => {
			const r = ownReport();
			return r?.available && r.panes?.some((p) => p.paneId === paneId) ? r : undefined;
		},
		"actual presented client layout",
		20000,
	);
	clientPid = report.clientPid;
	clientIdentity = report.processIdentity;
	assert.equal(await processIdentity(clientPid), report.processIdentity);
	const tree = terminalProcessTree(clientPid);
	assert.equal(tree.names[0], "herdr");
	assert.equal(tree.kittyPid, terminal.pid);
	assert.equal(tree.windowId, report.kittyWindowId);
	assert.notEqual(clientPid, server.pid, "client is independent of its server");
	assert.equal(report.herdrSocketPath, socket);
	const stat = lstatSync(join(layouts, `${clientPid}.json`));
	assert.equal(stat.mode & 0o777, 0o600);
	assert.equal(stat.uid, process.getuid());
	assert.equal(lstatSync(layouts).mode & 0o777, 0o700);
	const allowed = new Set([
		"version",
		"clientPid",
		"processIdentity",
		"tty",
		"kittyWindowId",
		"herdrSocketPath",
		"observedAt",
		"columns",
		"rows",
		"revision",
		"serverBootId",
		"overlayActive",
		"outerFocused",
		"available",
		"focusedPaneId",
		"panes",
		"sidebarRows",
	]);
	assert.ok(
		Object.keys(report).every((k) => allowed.has(k)),
		"report contains only the geometry contract",
	);
	assert.ok(
		report.panes.every((p) =>
			Object.keys(p).every((k) => ["paneId", "innerRect", "scrollOffset", "endpoint"].includes(k)),
		),
	);
	assert.ok(report.columns > 0 && report.rows > 0);
	const rect = report.panes.find((p) => p.paneId === paneId).innerRect;
	assert.ok(
		rect.x > 0 && rect.width > 0 && rect.y + rect.height <= report.rows,
		"real sidebar/chrome offset is included",
	);
	const windows = JSON.parse(kitty("ls"));
	const owned = windows
		.flatMap((w) => w.tabs.flatMap((t) => t.windows))
		.find((w) => w.id === report.kittyWindowId);
	assert.ok(owned?.pid === clientPid, "Kitty window owns the exact client PID");
	const read = await readHerdrLayout(terminal.pid, paneId, socket, { directory: layouts });
	const unfocused = report.outerFocused === false;
	if (unfocused) assert.equal(read, undefined, "hidden host is rejected for exact placement");
	else {
		assert.ok(read, "real report accepted through the production reader");
		assert.deepEqual(read.innerRect, rect);
	}
	const times = [Date.parse(report.observedAt)];
	for (let i = 0; i < 3; i++) {
		const next = await until(
			() => {
				const r = ownReport();
				return r && Date.parse(r.observedAt) > times.at(-1) ? r : undefined;
			},
			"bounded heartbeat",
			3500,
		);
		times.push(Date.parse(next.observedAt));
	}
	assert.ok(
		times.slice(1).every((t, i) => t - times[i] >= 990),
		"publisher does not exceed one update per second",
	);
	assert.equal(await processIdentity(clientPid), clientIdentity, "client identity before pause");
	process.kill(clientPid, "SIGSTOP");
	paused = true;
	const last = ownReport();
	await delay(2800);
	assert.equal(
		ownReport().observedAt,
		last.observedAt,
		"worker cannot invent heartbeat while the UI loop is paused",
	);
	assert.equal(parseHerdrLayout(last, paneId), undefined, "stale layout rejected");
	assert.equal(await readHerdrLayout(terminal.pid, paneId, socket, { directory: layouts }), undefined);
	assert.equal(await processIdentity(clientPid), clientIdentity, "client identity before resume");
	process.kill(clientPid, "SIGCONT");
	paused = false;
	await until(
		() => Date.parse(ownReport()?.observedAt) > Date.parse(last.observedAt),
		"resumed UI heartbeat",
	);
	const afterFocus = activeWindow();
	assert.notEqual(afterFocus?.pid, terminal.pid, "hidden QA terminal did not acquire focus");
	success = {
		version: 1,
		scope: "isolated",
		verified: true,
		checkedAt: new Date().toISOString(),
		binarySha256: proof.binarySha256,
		patchSha256: proof.patchSha256,
		checks: {
			privateOutput: true,
			actualKittyClientIdentity: true,
			separateServerClient: true,
			actualPaneAndChromeGeometry: true,
			noTextFields: true,
			throttled: true,
			staleLoopRejected: true,
			readerAccepted: !unfocused,
			hiddenHostRejected: unfocused,
			isolatedServerOnly: true,
		},
		geometry: { columns: report.columns, rows: report.rows, innerRect: rect },
		publicationIntervalsMs: times.slice(1).map((t, i) => t - times[i]),
		foreground: { before: beforeFocus, after: afterFocus },
		limits: [
			"Hidden isolated window; no production session was attached or focused.",
			"Composer projection additionally requires the Pi editor adapter and a genuinely focused visible Kitty window.",
		],
	};
} catch (error) {
	console.error(error.message);
	for (const child of children) {
		const d = child.diagnostic();
		if (d) console.error(`isolated ${child.spawnfile}: ${d}`);
	}
	throw error;
} finally {
	if (paused && clientPid)
		try {
			if ((await processIdentity(clientPid)) === clientIdentity) process.kill(clientPid, "SIGCONT");
		} catch {}
	for (const child of children.toReversed())
		if (child.exitCode === null && child.signalCode === null) {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {}
		}
	await delay(300);
	for (const child of children.toReversed())
		if (child.exitCode === null && child.signalCode === null)
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
	rmSync(base, { recursive: true, force: true });
}
if (success) {
	writeFileSync(output, JSON.stringify(success, null, 2) + "\n", { mode: 0o600 });
	console.log(JSON.stringify(success, null, 2));
}
