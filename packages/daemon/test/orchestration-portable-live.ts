/** Opt-in real Pi test in an isolated PTY. No Herdr, Orca, user profile or model request. Linux util-linux script required. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Orchestrator, SESSION_EXTENSION_PATH } from "../src/orchestration/index.ts";

if (process.env.GENTLE_DOT_LIVE_TEST !== "1")
	throw new Error("Set GENTLE_DOT_LIVE_TEST=1 to run the isolated PTY smoke.");
const scratch = await mkdtemp(join(tmpdir(), "dot-pty-"));
const fixture = join(scratch, "confirm.ts");
const marker = join(scratch, "decision.txt");
await writeFile(
	fixture,
	`import { writeFileSync } from 'node:fs';
export default function(pi) { pi.registerCommand('dot-smoke-confirm', { description: 'Offline fixture', handler: async (_args, ctx) => {
const answer = await ctx.ui.confirm('Portable fixture', 'Approve only this offline test?');
writeFileSync(${JSON.stringify(marker)}, String(answer));
} }); }
`,
);
const env: NodeJS.ProcessEnv = {
	...process.env,
	TERM: "xterm-256color",
	PI_CODING_AGENT_DIR: join(scratch, "pi"),
	PI_OFFLINE: "1",
	GENTLE_SHELL_HOME: join(scratch, "pi"),
	GENTLE_SHELL_CONFIG: join(scratch, "gentle.json"),
	GENTLE_SHELL_NO_AUTO_SETUP: "1",
	GENTLE_PI_CONFIG_HOME: join(scratch, "gentle"),
	XDG_CONFIG_HOME: join(scratch, "config"),
	XDG_CACHE_HOME: join(scratch, "cache"),
	PI_TELEMETRY: "0",
	GENTLE_AI_TELEMETRY: "0",
	GENTLE_DOT_SESSION_DIR: join(scratch, "pi-sessions"),
	SHELL: "/bin/sh",
};
for (const name of Object.keys(env)) {
	if (
		/^(?:HERDR_|ORCA_)/.test(name) ||
		/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|BEARER_TOKEN|SECRET_ACCESS_KEY)$/.test(name)
	)
		delete env[name];
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const argv = [
	process.env.GENTLE_DOT_PI_BIN || "pi",
	"--offline",
	"--no-extensions",
	"--no-tools",
	"--no-mcp",
	"--no-skills",
	"--no-context-files",
	"--no-approve",
	"--no-prompt-templates",
	"--no-themes",
	"--no-session",
	"--provider",
	"anthropic",
	"--model",
	"claude-sonnet-4-6",
	"-e",
	fixture,
	"-e",
	SESSION_EXTENSION_PATH,
];
const child = spawn("script", ["-q", "-c", argv.map(quote).join(" "), "/dev/null"], {
	cwd: scratch,
	env,
	detached: true,
	stdio: "pipe",
});
let output = "";
child.stdout.on("data", (chunk) => {
	output = (output + chunk.toString()).slice(-3000);
});
child.stderr.on("data", (chunk) => {
	output = (output + chunk.toString()).slice(-3000);
});
let failure: Error | undefined;
child.once("error", (error) => {
	failure = error;
});
const orchestrator = new Orchestrator({
	dataDir: scratch,
	registryDirs: [],
	socketPath: join(scratch, "no-herdr.sock"),
	orcaCommand: false,
	terminalLauncher: false,
	pollMs: 0,
});
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string): Promise<T> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			const value = await read();
			if (predicate(value)) return value;
		} catch {
			/* Wait for own fixture. */
		}
		if (failure) throw failure;
		if (child.exitCode !== null) throw new Error(`Pi exited: ${output}`);
		await delay(100);
	}
	throw new Error(`Timed out: ${label}; ${output}`);
}
try {
	const connected = await until(
		() => orchestrator.snapshot(),
		(snapshot) => snapshot.sessions.some((session) => session.connected),
		"portable Pi registration",
	);
	const session = connected.sessions[0];
	assert.ok(session?.sessionId && session.provider === "terminal" && session.capabilities.abort);
	assert.equal(connected.providers.find((provider) => provider.id === "herdr")?.available, false);
	const identity = { paneId: session.paneId, sessionId: session.sessionId };
	await orchestrator.dispatch({ action: "inspect", ...identity }, "human");
	child.stdin.write("/dot-smoke-confirm\r");
	const waiting = await until(
		() => orchestrator.snapshot(),
		(snapshot) => snapshot.approvals.some((approval) => approval.answerable),
		"portable native confirmation",
	);
	assert.ok(waiting.approvals[0]);
	await orchestrator.dispatch(
		{ action: "answer", ...identity, requestId: waiting.approvals[0].id, approved: true },
		"human",
	);
	await until(
		() => readFile(marker, "utf8"),
		(value) => value === "true",
		"confirmation resolved",
	);
	await rm(marker);
	child.stdin.write("/dot-smoke-confirm\r");
	await until(
		() => orchestrator.snapshot(),
		(snapshot) => snapshot.approvals.some((approval) => approval.answerable),
		"second native confirmation",
	);
	await orchestrator.dispatch({ action: "abort", ...identity }, "human");
	await until(
		() => readFile(marker, "utf8"),
		(value) => value === "false",
		"abort denies actual pending confirmation",
	);
	console.log(
		"PASS: real Pi portable registration, inspection, approval and abort in isolated PTY without Herdr or Orca; no inference.",
	);
} finally {
	await orchestrator.close();
	if (child.pid) {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			/* Already exited. */
		}
	}
	await delay(300);
	if (child.exitCode === null && child.pid) {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			/* Already exited. */
		}
	}
	await rm(scratch, { recursive: true, force: true });
}
