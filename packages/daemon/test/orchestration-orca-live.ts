/** Opt-in Orca smoke. Creates and closes only its own terminal in an explicitly selected existing local workspace. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runOrcaCli } from "../src/orchestration/displays.ts";
import { record } from "../src/orchestration/herdr.ts";
import { Orchestrator } from "../src/orchestration/index.ts";

if (process.env.GENTLE_DOT_LIVE_TEST !== "1" || !process.env.GENTLE_DOT_ORCA_TEST_WORKSPACE)
	throw new Error(
		"Set GENTLE_DOT_LIVE_TEST=1 and GENTLE_DOT_ORCA_TEST_WORKSPACE to an authorized local Orca workspace.",
	);
const scratch = await mkdtemp(join(tmpdir(), "dot-orca-"));
const fixture = join(scratch, "confirm.ts");
const marker = join(scratch, "decision.txt");
const wrapper = join(scratch, "pi-fixture");
const orca = process.env.GENTLE_DOT_ORCA_BIN || "orca-ide";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(
	fixture,
	`import { writeFileSync } from 'node:fs';
export default function(pi) { pi.registerCommand('dot-smoke-confirm', { description: 'Offline fixture', handler: async (_args, ctx) => {
const answer = await ctx.ui.confirm('Orca fixture', 'Approve only this offline test?');
writeFileSync(${JSON.stringify(marker)}, String(answer));
} }); }
`,
);
const vars = {
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
};
await writeFile(
	wrapper,
	`#!/bin/sh\ncd ${quote(scratch)} || exit 1\nexec env ${Object.entries(vars)
		.map(([key, value]) => quote(`${key}=${value}`))
		.join(" ")} ${quote(process.env.GENTLE_DOT_PI_BIN || "pi")} "$@"\n`,
	{ mode: 0o700 },
);
const orchestrator = new Orchestrator({
	dataDir: scratch,
	registryDirs: [],
	socketPath: join(scratch, "no-herdr.sock"),
	orcaCommand: orca,
	terminalLauncher: false,
	pollMs: 0,
	piCommand: wrapper,
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
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string): Promise<T> {
	const deadline = Date.now() + 25_000;
	while (Date.now() < deadline) {
		try {
			const value = await read();
			if (predicate(value)) return value;
		} catch {
			/* Wait for own fixture. */
		}
		await delay(200);
	}
	throw new Error(`Timed out: ${label}`);
}
let terminalId: string | undefined;
try {
	const created = await orchestrator.dispatch(
		{
			action: "create",
			provider: "orca",
			cwd: process.env.GENTLE_DOT_ORCA_TEST_WORKSPACE,
			label: "Gentle Dot isolated offline test",
		},
		"human",
	);
	assert.ok(record(created) && typeof created.terminalId === "string");
	terminalId = created.terminalId;
	const connected = await until(
		() => orchestrator.snapshot(),
		(snapshot) => snapshot.sessions.some((session) => session.connected && session.cwd === scratch),
		"Orca Pi registration",
	);
	const session = connected.sessions.find((entry) => entry.connected && entry.cwd === scratch);
	assert.ok(session?.sessionId && session.provider === "orca");
	const identity = { paneId: session.paneId, sessionId: session.sessionId };
	await orchestrator.dispatch({ action: "inspect", ...identity }, "human");
	await runOrcaCli(orca, [
		"terminal",
		"send",
		"--terminal",
		terminalId,
		"--text",
		"/dot-smoke-confirm",
		"--enter",
	]);
	const waiting = await until(
		() => orchestrator.snapshot(),
		(snapshot) => snapshot.approvals.some((approval) => approval.paneId === session.paneId),
		"Orca native confirmation",
	);
	const approval = waiting.approvals.find((entry) => entry.paneId === session.paneId);
	assert.ok(approval?.answerable);
	await orchestrator.dispatch(
		{ action: "answer", ...identity, requestId: approval.id, approved: true },
		"human",
	);
	await until(
		() => readFile(marker, "utf8"),
		(value) => value === "true",
		"actual approval resolved",
	);
	await orchestrator.dispatch({ action: "abort", ...identity }, "human");
	console.log(
		"PASS: actual Orca terminal.create, portable Pi binding, inspection, native approval and abort; no inference or existing terminal input.",
	);
} finally {
	await orchestrator.close();
	if (terminalId) await runOrcaCli(orca, ["terminal", "close", "--terminal", terminalId]);
	await rm(scratch, { recursive: true, force: true });
}
