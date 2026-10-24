import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AgentSupervisor } from "../src/supervisor.ts";
import { fakeSupervisor, tempDir, waitFor } from "./helpers.ts";

const running: AgentSupervisor[] = [];
afterEach(async () => {
	await Promise.all(running.splice(0).map((supervisor) => supervisor.stop()));
});

it("does not request a handoff for a late receipt after steering was consumed", async () => {
	const commandsFile = join(tempDir(), "commands.jsonl");
	const { supervisor } = fakeSupervisor({
		liveInput: true,
		env: {
			...process.env,
			FAKE_AGENT_LIVE_INPUT: "1",
			FAKE_AGENT_RPC_FILE: commandsFile,
			FAKE_AGENT_QUEUED_ACK_MS: "1800",
		},
	});
	running.push(supervisor);
	await supervisor.start();
	await supervisor.request({ type: "prompt", message: "slow", streamingBehavior: "steer" });
	const received = await supervisor.request({
		type: "prompt",
		message: "already read",
		streamingBehavior: "steer",
	});
	expect(received.data).toEqual({ disposition: "queued" });
	await supervisor.request({ type: "get_state" });
	expect(readFileSync(commandsFile, "utf8")).not.toContain("/dot-live-input interrupt");
});

it.each([
	["prompt", "abort"],
	["steer", "abort"],
	["prompt", "new_session"],
	["steer", "switch_session"],
] as const)("a late %s queued receipt cannot start a handoff after %s", async (type, stop) => {
	const commandsFile = join(tempDir(), "commands.jsonl");
	const commands = () =>
		readFileSync(commandsFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; message?: string });
	const { supervisor } = fakeSupervisor({
		liveInput: true,
		env: {
			...process.env,
			FAKE_AGENT_LIVE_INPUT: "1",
			FAKE_AGENT_RPC_FILE: commandsFile,
			FAKE_AGENT_QUEUED_ACK_MS: "400",
		},
	});
	running.push(supervisor);
	await supervisor.start();
	const sessionPath = supervisor.sessionFile;
	await supervisor.request({ type: "prompt", message: "hang", streamingBehavior: "steer" });
	const pending = supervisor.request({ type, message: "old queued input", streamingBehavior: "steer" });
	await waitFor(() => commands().some((command) => command.message === "old queued input"));
	await supervisor.request({ type: stop, ...(stop === "switch_session" ? { sessionPath } : {}) });
	expect((await pending).data).toEqual({ disposition: "queued" });
	// This round-trip is a barrier: any interrupt scheduled by the late receipt precedes it.
	await supervisor.request({ type: "get_state" });
	expect(commands().filter((command) => command.message === "/dot-live-input interrupt")).toEqual([]);
	if (stop === "abort") {
		const stopped = commands();
		const cancel = stopped.findIndex((command) => command.message === "/dot-live-input cancel");
		expect(cancel).toBeGreaterThan(-1);
		expect(stopped[cancel + 1]?.type).toBe("abort");
	}
	// The fence invalidates old receipts, not future human messages.
	await supervisor.request({ type: "prompt", message: "hang", streamingBehavior: "steer" });
	await supervisor.request({ type: "prompt", message: "fresh queued input", streamingBehavior: "steer" });
	await waitFor(() => commands().some((command) => command.message === "/dot-live-input interrupt"));
	expect(commands().filter((command) => command.message === "/dot-live-input interrupt")).toHaveLength(1);
});
