/** Opt-in, isolated HERDR + Pi smoke. No model request and no existing user session is touched. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { localRequest, record } from "../src/orchestration/herdr.ts";
import { Orchestrator } from "../src/orchestration/index.ts";

if (process.env.GENTLE_DOT_LIVE_TEST !== "1")
	throw new Error("Set GENTLE_DOT_LIVE_TEST=1 to run this isolated smoke.");
const scratch = await mkdtemp(join(tmpdir(), "dot-live-"));
const socketPath = join(scratch, "herdr.sock");
const marker = join(scratch, "decision.txt");
const fixture = join(scratch, "confirm.ts");
await mkdir(join(scratch, "config", "herdr"), { recursive: true });
await writeFile(join(scratch, "config", "herdr", "config.toml"), "onboarding = false\n");
await writeFile(
	fixture,
	`import { writeFile } from 'node:fs/promises';
export default function(pi) { pi.registerCommand('dot-smoke-confirm', { description: 'Offline fixture', handler: async (_args, ctx) => {
const answer = await ctx.ui.confirm('Offline approval', 'Approve only this isolated fixture?');
await writeFile(${JSON.stringify(marker)}, String(answer));
} }); }
`,
);
const env = {
	...process.env,
	HERDR_SOCKET_PATH: socketPath,
	HERDR_CONFIG_PATH: join(scratch, "config", "herdr", "config.toml"),
	XDG_CONFIG_HOME: join(scratch, "config"),
	PI_CODING_AGENT_DIR: join(scratch, "pi"),
	PI_OFFLINE: "1",
	GENTLE_SHELL_HOME: join(scratch, "pi"),
	GENTLE_SHELL_CONFIG: join(scratch, "gentle.json"),
	GENTLE_SHELL_NO_AUTO_SETUP: "1",
	GENTLE_PI_CONFIG_HOME: join(scratch, "gentle"),
	XDG_CACHE_HOME: join(scratch, "cache"),
	PI_TELEMETRY: "0",
	GENTLE_AI_TELEMETRY: "0",
	SHELL: "/bin/sh",
};
for (const name of Object.keys(env)) {
	if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|BEARER_TOKEN|SECRET_ACCESS_KEY)$/.test(name))
		delete (env as NodeJS.ProcessEnv)[name];
}
const herdr = spawn(process.env.HERDR_BIN || "herdr", ["server"], {
	env,
	cwd: scratch,
	stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
herdr.stderr?.on("data", (chunk) => {
	stderr = (stderr + chunk.toString()).slice(-4000);
});
let startupError: Error | undefined;
herdr.once("error", (error) => {
	startupError = error;
});
const orchestrator = new Orchestrator({
	dataDir: join(scratch, "data"),
	socketPath,
	pollMs: 0,
	orcaCommand: false,
	terminalLauncher: false,
	registryDirs: [],
	piCommand: process.env.GENTLE_DOT_PI_BIN || "pi",
	piArgs: [
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
	],
});
async function until<T>(
	read: () => Promise<T>,
	predicate: (value: T) => boolean,
	label: string,
	timeout = 20_000,
): Promise<T> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			const value = await read();
			if (predicate(value)) return value;
		} catch {
			/* Wait for the isolated service. */
		}
		if (startupError) throw startupError;
		if (herdr.exitCode !== null) throw new Error(`HERDR exited: ${stderr}`);
		await delay(100);
	}
	throw new Error(`Timed out: ${label}; HERDR ${stderr}`);
}
try {
	const ping = await until(
		() => localRequest(socketPath, "ping", {}, 500),
		() => true,
		"HERDR startup",
	);
	console.log(`HERDR ${ping.version}, protocol ${ping.protocol}`);
	const created = await orchestrator.dispatch(
		{ action: "create", cwd: scratch, label: "Dot offline smoke" },
		"human",
	);
	assert.ok(record(created) && typeof created.paneId === "string");
	const paneId = created.paneId;
	const connected = await until(
		() => orchestrator.snapshot(),
		(snapshot) => snapshot.sessions.some((session) => session.paneId === paneId && session.connected),
		"Pi adapter registration",
	);
	const session = connected.sessions.find((entry) => entry.paneId === paneId);
	assert.ok(session?.sessionId && session.managed);
	const page = await orchestrator.dispatch(
		{ action: "inspect", paneId, sessionId: session.sessionId },
		"human",
	);
	assert.ok(record(page) && page.sessionId === session.sessionId);
	await localRequest(socketPath, "pane.send_input", {
		pane_id: paneId,
		text: "/dot-smoke-confirm",
		keys: ["enter"],
	});
	const waiting = await until(
		() => orchestrator.snapshot(),
		(snapshot) => snapshot.approvals.some((approval) => approval.answerable),
		"native confirm",
	);
	const approval = waiting.approvals[0];
	assert.ok(approval);
	await orchestrator.dispatch(
		{
			action: "grant",
			paneId,
			sessionId: session.sessionId,
			requestId: approval.id,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			maxUses: 1,
		},
		"human",
	);
	await orchestrator.snapshot();
	await until(
		() => readFile(marker, "utf8"),
		(value) => value === "true",
		"native confirmation result",
	);
	await rm(marker);
	await localRequest(socketPath, "pane.send_input", {
		pane_id: paneId,
		text: "/dot-smoke-confirm",
		keys: ["enter"],
	});
	const next = await until(
		() => orchestrator.snapshot(),
		(snapshot) => snapshot.approvals.some((entry) => entry.id !== approval.id),
		"second confirmation",
	);
	assert.equal(next.policies.length, 0);
	assert.ok(next.approvals[0]);
	await orchestrator.dispatch(
		{
			action: "answer",
			paneId,
			sessionId: session.sessionId,
			requestId: next.approvals[0].id,
			approved: false,
		},
		"human",
	);
	await until(
		() => readFile(marker, "utf8"),
		(value) => value === "false",
		"denial result",
	);
	console.log(
		"PASS: real Pi registration, history, actual UI confirmation, exact one-use grant, second prompt denied; no inference.",
	);
} finally {
	await orchestrator.close();
	await localRequest(socketPath, "server.stop", {}, 500).catch(() => {});
	if (herdr.exitCode === null) herdr.kill("SIGTERM");
	await delay(300);
	if (herdr.exitCode === null) herdr.kill("SIGKILL");
	await rm(scratch, { recursive: true, force: true });
}
