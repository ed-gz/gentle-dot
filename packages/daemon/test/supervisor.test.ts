import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSupervisor } from "../src/supervisor.ts";
import { fakeSupervisor, tempDir, waitFor } from "./helpers.ts";

const running: AgentSupervisor[] = [];
afterEach(async () => {
	await Promise.all(running.splice(0).map((s) => s.stop()));
	vi.restoreAllMocks();
});

function track<T extends { supervisor: AgentSupervisor }>(value: T): T {
	running.push(value.supervisor);
	return value;
}

describe("AgentSupervisor", () => {
	it("requests an inference handoff only after a queued receipt and cancels it before explicit Stop", async () => {
		const commandsFile = join(tempDir(), "commands.jsonl");
		const commands = () =>
			readFileSync(commandsFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		const { supervisor, events } = track(
			fakeSupervisor({
				liveInput: true,
				env: { ...process.env, FAKE_AGENT_LIVE_INPUT: "1", FAKE_AGENT_RPC_FILE: commandsFile },
			}),
		);
		await supervisor.start();
		await supervisor.request({ type: "prompt", message: "hang", streamingBehavior: "steer" });
		expect(commands().some((entry) => String(entry.message).startsWith("/dot-live-input"))).toBe(false);
		await supervisor.request({ type: "prompt", message: "new requirement", streamingBehavior: "steer" });
		await waitFor(() => commands().some((entry) => entry.message === "/dot-live-input interrupt"));
		await waitFor(() => events.some((event) => "statusText" in event && event.statusText === "interrupting"));
		const images = [{ type: "image", data: "fixture", mimeType: "image/png" }];
		await supervisor.request({
			type: "prompt",
			message: "third during handoff",
			images,
			streamingBehavior: "steer",
		});
		expect(commands().find((entry) => entry.message === "third during handoff")).toMatchObject({
			type: "steer",
			images,
		});
		await supervisor.request({ type: "abort" });
		const sent = commands();
		const cancel = sent.findIndex((entry) => entry.message === "/dot-live-input cancel");
		expect(cancel).toBeGreaterThan(-1);
		expect(sent[cancel + 1]).toMatchObject({ type: "abort" });
		expect(
			events
				.filter((event) => event.type === "message_start")
				.some((event) => "message" in event && JSON.stringify(event.message).includes("/dot-live-input")),
		).toBe(false);
	});

	it("never sends a control command as chat when the engine has no live-input extension", async () => {
		const commandsFile = join(tempDir(), "commands.jsonl");
		const { supervisor } = track(
			fakeSupervisor({
				liveInput: true,
				env: { ...process.env, FAKE_AGENT_RPC_FILE: commandsFile },
			}),
		);
		await supervisor.start();
		await supervisor.request({ type: "prompt", message: "hang", streamingBehavior: "steer" });
		await supervisor.request({ type: "prompt", message: "second", streamingBehavior: "steer" });
		await supervisor.request({ type: "abort" });
		expect(readFileSync(commandsFile, "utf8")).not.toContain("/dot-live-input");
	});

	it("restores all-message steering at every engine launch", async () => {
		const { supervisor } = track(fakeSupervisor({ steeringMode: "all" }));
		await supervisor.start();
		expect((await supervisor.request({ type: "get_state" })).data).toMatchObject({ steeringMode: "all" });
		await supervisor.request({ type: "set_steering_mode", mode: "one-at-a-time" });
		await supervisor.restart();
		expect((await supervisor.request({ type: "get_state" })).data).toMatchObject({ steeringMode: "all" });
	});
	it("spawns the agent in RPC mode with the session dir and extra args", async () => {
		const argsFile = join(tempDir(), "argv.json");
		const { supervisor, dataDir } = track(
			fakeSupervisor({ env: { ...process.env, FAKE_AGENT_ARGS_FILE: argsFile }, extraArgs: ["--x", "1"] }),
		);
		await supervisor.start();
		const argv = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
		expect(argv).toEqual(["--mode", "rpc", "--session-dir", join(dataDir, "sessions"), "--x", "1"]);
		expect(supervisor.state).toBe("ready");
	});

	it("shares an initial handshake across concurrent starts", async () => {
		let launches = 0;
		const { supervisor } = track(
			fakeSupervisor({
				prepareSpawn: () => {
					launches++;
					return { FAKE_AGENT_START_DELAY_MS: "150" };
				},
			}),
		);
		await Promise.all([supervisor.start(), supervisor.start(), supervisor.start()]);
		expect(launches).toBe(1);
		expect(supervisor.state).toBe("ready");
	});

	it("serializes native-helper registration restarts behind a slow initial handshake", async () => {
		let launches = 0;
		const { supervisor, events } = track(
			fakeSupervisor({
				prepareSpawn: () => {
					launches++;
					return { FAKE_AGENT_START_DELAY_MS: "150" };
				},
			}),
		);
		const initial = supervisor.start();
		const firstPid = await waitFor(() => supervisor.pid);
		const registration = supervisor.restart();
		const secondRegistration = supervisor.restart();
		await Promise.all([initial, registration, secondRegistration]);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(launches).toBe(2);
		expect(supervisor.state).toBe("ready");
		expect(supervisor.pid).not.toBe(firstPid);
		expect(() => process.kill(firstPid, 0)).toThrow();
		expect(events.some((event) => event.type === "interrupted")).toBe(false);
		expect((await supervisor.request({ type: "get_state" })).success).toBe(true);
	});

	it("stopping while a registration restart waits for startup never spawns a replacement", async () => {
		let launches = 0;
		const { supervisor } = track(
			fakeSupervisor({
				prepareSpawn: () => {
					launches++;
					return { FAKE_AGENT_START_DELAY_MS: "300" };
				},
			}),
		);
		const initial = supervisor.start();
		const initialOutcome = initial.catch((error) => error);
		await waitFor(() => supervisor.pid);
		const registration = supervisor.restart();
		await supervisor.stop();
		await registration;
		await initialOutcome;
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(launches).toBe(1);
		expect(supervisor.pid).toBeUndefined();
		expect(supervisor.state).toBe("stopped");
	});

	it("starts the agent as the configured user, and as the daemon's own user without one (S25.8)", async () => {
		const own = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
		const processFile = join(tempDir(), "process.json");
		const env = { ...process.env, FAKE_AGENT_PROCESS_FILE: processFile };
		// Without a user, the agent runs as the daemon does today.
		const plain = track(fakeSupervisor({ env }));
		await plain.supervisor.start();
		expect(JSON.parse(readFileSync(processFile, "utf8"))).toMatchObject(own);
		await plain.supervisor.stop();
		const as = track(fakeSupervisor({ env, user: own }));
		await as.supervisor.start();
		expect(JSON.parse(readFileSync(processFile, "utf8"))).toMatchObject(own);
		expect(as.supervisor.state).toBe("ready");
	});

	it.skipIf((process.getuid?.() ?? 0) === 0)(
		"applies the user to the spawn: one it cannot take is refused",
		async () => {
			const own = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
			const { supervisor } = track(
				fakeSupervisor({ user: { uid: own.uid + 1, gid: own.gid }, startTimeoutMs: 2000 }),
			);
			await expect(supervisor.start()).rejects.toThrow();
			expect(supervisor.state).not.toBe("ready");
		},
	);

	it("correlates responses by id across concurrent commands", async () => {
		const { supervisor } = track(fakeSupervisor());
		await supervisor.start();
		const [state, commands] = await Promise.all([
			supervisor.request({ type: "get_state" }),
			supervisor.request({ type: "get_commands" }),
		]);
		expect(state.command).toBe("get_state");
		expect(commands.command).toBe("get_commands");
	});

	it("rejects a failed command with the agent's error", async () => {
		const { supervisor } = track(fakeSupervisor());
		await supervisor.start();
		await expect(supervisor.request({ type: "switch_session", sessionPath: "/nope.jsonl" })).rejects.toThrow(
			"Session not found",
		);
	});

	it("forwards session events and tracks busy until agent_settled", async () => {
		const { supervisor, events } = track(fakeSupervisor());
		await supervisor.start();
		await supervisor.request({ type: "prompt", message: "hello" });
		await waitFor(() => events.some((e) => e.type === "agent_settled"));
		expect(events.map((e) => e.type)).toContain("message_update");
		expect(supervisor.busy).toBe(false);
	});

	it("is not left busy when the run settles before the prompt response is handled", async () => {
		const { supervisor, events } = track(fakeSupervisor());
		await supervisor.start();
		await supervisor.request({ type: "prompt", message: "burst" });
		expect(events.some((e) => e.type === "agent_settled")).toBe(true);
		expect(supervisor.busy).toBe(false);
	});

	it("respawns after a crash, reopens the same conversation, and reports the interruption", async () => {
		const { supervisor, events } = track(fakeSupervisor());
		await supervisor.start();
		await supervisor.request({ type: "prompt", message: "first" });
		await waitFor(() => events.some((e) => e.type === "agent_settled"));
		const sessionBefore = supervisor.sessionFile;
		const pidBefore = supervisor.pid;

		await supervisor.request({ type: "prompt", message: "crash" });
		await waitFor(() => events.some((e) => e.type === "interrupted"));

		expect(supervisor.state).toBe("ready");
		expect(supervisor.pid).not.toBe(pidBefore);
		expect(supervisor.sessionFile).toBe(sessionBefore);
		const states = events.flatMap((e) => (e.type === "supervisor_state" && "state" in e ? [e.state] : []));
		expect(states).toContain("restarting");
		const history = await supervisor.request({ type: "get_messages" });
		const texts = (history.data as { messages: { content: unknown }[] }).messages.map((m) => m.content);
		expect(texts[0]).toBe("first");
	});

	it("does not report an interruption when the agent dies while idle", async () => {
		const { supervisor, events } = track(fakeSupervisor());
		await supervisor.start();
		process.kill(supervisor.pid ?? 0, "SIGKILL");
		await waitFor(
			() =>
				events.filter((e) => e.type === "supervisor_state" && "state" in e && e.state === "ready").length >=
				2,
		);
		expect(events.some((e) => e.type === "interrupted")).toBe(false);
	});

	it("rejects pending commands when the agent exits", async () => {
		const { supervisor } = track(fakeSupervisor());
		await supervisor.start();
		const pending = supervisor.request({ type: "noreply" });
		process.kill(supervisor.pid ?? 0, "SIGKILL");
		await expect(pending).rejects.toThrow(/agent exited/i);
	});

	it("reopens the last conversation after the daemon itself restarts", async () => {
		const dataDir = tempDir();
		const first = track(fakeSupervisor({ dataDir }));
		await first.supervisor.start();
		await first.supervisor.request({ type: "prompt", message: "remember me" });
		await waitFor(() => first.events.some((e) => e.type === "agent_settled"));
		await waitFor(() => first.supervisor.sessionFile && first.supervisor.sessionFile);
		const session = first.supervisor.sessionFile;
		await first.supervisor.stop();

		const second = track(fakeSupervisor({ dataDir }));
		await second.supervisor.start();
		expect(second.supervisor.sessionFile).toBe(session);
	});

	it("restarts on request, keeping the conversation and without an interruption", async () => {
		const { supervisor, events } = track(fakeSupervisor());
		await supervisor.start();
		await supervisor.request({ type: "prompt", message: "keep me" });
		await waitFor(() => events.some((e) => e.type === "agent_settled"));
		const session = supervisor.sessionFile;
		const pid = supervisor.pid;
		await supervisor.restart();
		expect(supervisor.state).toBe("ready");
		expect(supervisor.pid).not.toBe(pid);
		expect(supervisor.sessionFile).toBe(session);
		expect(events.some((e) => e.type === "interrupted")).toBe(false);
	});

	it("a stop during a restart starts nothing again (S35.2: the app quitting does both)", async () => {
		const { supervisor } = track(fakeSupervisor());
		await supervisor.start();
		const restarting = supervisor.restart();
		await supervisor.stop();
		await restarting;
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(supervisor.state).toBe("stopped");
		expect(supervisor.pid).toBeUndefined();
	});

	it("kills a child ignoring EOF and SIGTERM before completing an intentional restart", async () => {
		let launches = 0;
		const { supervisor } = track(
			fakeSupervisor({
				args: [fileURLToPath(new URL("./fixtures/lifecycle-agent.ts", import.meta.url))],
				stopTimeoutMs: 20,
				prepareSpawn: () => ({ FAKE_LIFECYCLE_MODE: ++launches === 1 ? "stubborn" : "ready" }),
			}),
		);
		await supervisor.start();
		const previous = supervisor.pid;
		await supervisor.restart();
		expect(supervisor.state).toBe("ready");
		expect(supervisor.pid).not.toBe(previous);
		expect(launches).toBe(2);
		if (previous) expect(() => process.kill(previous, 0)).toThrow();
	});

	it("schedules only one retry for a failed initialization and never leaves an extra child", async () => {
		let launches = 0;
		const delays = [81, 162, 324];
		const timers = vi.spyOn(globalThis, "setTimeout");
		const { supervisor } = track(
			fakeSupervisor({
				args: [fileURLToPath(new URL("./fixtures/lifecycle-agent.ts", import.meta.url))],
				backoffMs: delays,
				prepareSpawn: () => ({ FAKE_LIFECYCLE_MODE: ++launches <= 3 ? "exit" : "ready" }),
			}),
		);
		await expect(supervisor.start()).rejects.toThrow(/exited/);
		await waitFor(() => supervisor.state === "ready");
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(launches).toBe(4);
		expect(
			timers.mock.calls.map((call) => call[1]).filter((delay) => delays.includes(Number(delay))),
		).toEqual(delays);
		await supervisor.stop();
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(launches).toBe(4);
	});

	it("resets failure backoff once after a healthy run, not again on each failed startup", async () => {
		let launches = 0;
		const delays = [83, 166, 332];
		const timers = vi.spyOn(globalThis, "setTimeout");
		const { supervisor } = track(
			fakeSupervisor({
				args: [fileURLToPath(new URL("./fixtures/lifecycle-agent.ts", import.meta.url))],
				backoffMs: delays,
				stableMs: 20,
				prepareSpawn: () => ({ FAKE_LIFECYCLE_MODE: ++launches === 1 || launches >= 5 ? "ready" : "exit" }),
			}),
		);
		await supervisor.start();
		await new Promise((resolve) => setTimeout(resolve, 30));
		const previous = supervisor.pid;
		if (!previous) throw new Error("Expected running child");
		process.kill(previous, "SIGKILL");
		await waitFor(() => launches >= 5 && supervisor.state === "ready");
		expect(
			timers.mock.calls.map((call) => call[1]).filter((delay) => delays.includes(Number(delay))),
		).toEqual([83, 166, 332, 332]);
		// A later healthy process earns its own single reset.
		await new Promise((resolve) => setTimeout(resolve, 30));
		const healthy = supervisor.pid;
		if (!healthy) throw new Error("Expected replacement child");
		process.kill(healthy, "SIGKILL");
		await waitFor(() => launches >= 6 && supervisor.state === "ready");
		expect(
			timers.mock.calls.map((call) => call[1]).filter((delay) => delays.includes(Number(delay))),
		).toEqual([83, 166, 332, 332, 83]);
	});

	it("retries preparation failures both on first start and an intentional restart", async () => {
		let preparations = 0;
		const { supervisor, events } = track(
			fakeSupervisor({
				prepareSpawn: () => {
					preparations++;
					if (preparations === 1 || preparations === 3) throw new Error("Policy temporarily unavailable");
					return {};
				},
			}),
		);
		await expect(supervisor.start()).rejects.toThrow("Policy temporarily unavailable");
		await waitFor(() => supervisor.state === "ready");
		expect(preparations).toBe(2);
		const previous = supervisor.pid;
		await expect(supervisor.restart()).rejects.toThrow("Policy temporarily unavailable");
		await waitFor(() => supervisor.state === "ready");
		expect(preparations).toBe(4);
		expect(supervisor.pid).not.toBe(previous);
		expect(events.some((event) => event.type === "interrupted")).toBe(false);
	});

	it("cancels a queued retry after preparation fails when stopped", async () => {
		let preparations = 0;
		const { supervisor } = track(
			fakeSupervisor({
				prepareSpawn: () => {
					preparations++;
					throw new Error("Policy temporarily unavailable");
				},
			}),
		);
		await expect(supervisor.start()).rejects.toThrow("Policy temporarily unavailable");
		await supervisor.stop();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(preparations).toBe(1);
		expect(supervisor.state).toBe("stopped");
	});

	it("stops cleanly and reports the stopped state", async () => {
		const { supervisor } = track(fakeSupervisor());
		await supervisor.start();
		await supervisor.stop();
		expect(supervisor.state).toBe("stopped");
		await expect(supervisor.request({ type: "get_state" })).rejects.toThrow(/not ready/i);
	});
});
