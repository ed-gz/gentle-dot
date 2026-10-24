#!/usr/bin/env node
/** Explicitly open a new opt-in client window. Existing terminals and server are untouched. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
const args = process.argv.slice(2);
const option = (key) => {
	const i = args.indexOf(key);
	return i >= 0 ? args[i + 1] : undefined;
};
const required = (key) => {
	const value = option(key);
	if (!value || !isAbsolute(value)) throw new Error(`${key} requires an absolute path`);
	return resolve(value);
};
const sidecar = required("--sidecar"),
	socket = realpathSync(required("--socket"));
const binary = join(sidecar, "herdr");
const proof = JSON.parse(readFileSync(join(sidecar, "companion-build.json"), "utf8"));
if (
	proof.smokeVerified !== true ||
	createHash("sha256").update(readFileSync(binary)).digest("hex") !== proof.binarySha256
)
	throw new Error("The private client must have a matching, completed smoke verification");
if (!lstatSync(socket).isSocket()) throw new Error("Expected an existing Herdr API socket");
const runtime = process.env.XDG_RUNTIME_DIR;
if (!runtime || !isAbsolute(runtime)) throw new Error("XDG_RUNTIME_DIR is required");
const privateDir = (path, create) => {
	if (create)
		try {
			mkdirSync(path, { mode: 0o700 });
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
	const stat = lstatSync(path);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		stat.uid !== process.getuid?.() ||
		(stat.mode & 0o077) !== 0
	)
		throw new Error("Expected an owner-only runtime directory");
};
privateDir(runtime, false);
const base = join(runtime, "gentle-dot"),
	layouts = join(base, "herdr-layout"),
	sockets = join(base, "kitty");
const launch = args.includes("--launch");
if (launch) {
	privateDir(base, true);
	privateDir(layouts, true);
	privateDir(sockets, true);
}
const kittySocket = `unix:${join(sockets, `herdr-${randomUUID()}.sock`)}`;
const argv = [
	"--listen-on",
	kittySocket,
	"--override",
	"allow_remote_control=socket-only",
	"--title",
	"Herdr · Capri",
	binary,
	"client",
];
const env = { ...process.env, HERDR_SOCKET_PATH: socket, GENTLE_DOT_COMPANION_LAYOUT_DIR: layouts };
for (const name of [
	"HERDR_CLIENT_SOCKET_PATH",
	"HERDR_PANE_ID",
	"HERDR_SESSION",
	"HERDR_ENV",
	"KITTY_WINDOW_ID",
	"KITTY_LISTEN_ON",
	"KITTY_PID",
])
	delete env[name];
if (!launch) {
	console.log(
		JSON.stringify(
			{
				program: "kitty",
				argv,
				environment: { HERDR_SOCKET_PATH: socket, GENTLE_DOT_COMPANION_LAYOUT_DIR: layouts },
				launch: false,
			},
			null,
			2,
		),
	);
} else {
	const child = spawn("kitty", argv, { env, detached: true, stdio: "ignore" });
	child.on("error", (error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
	child.unref();
}
