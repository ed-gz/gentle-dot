import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerPayload } from "@gentle-dot/protocol";
import { afterEach, expect, it } from "vitest";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, tempDir } from "./helpers.ts";

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
});

it.each([true, false])(
	"scopes chat retrieval to Dot's own session directory (own engine: %s)",
	async (own) => {
		const dir = tempDir();
		const processFile = join(dir, "process.json");
		const auth = fakeAuthRuntime();
		const daemon = await startDaemon({
			port: 0,
			host: "127.0.0.1",
			dataDir: dir,
			workspace: join(dir, "workspace"),
			uiDir: dir,
			...(own ? { agentHome: join(dir, "agent") } : {}),
			agentCommand: process.execPath,
			agentArgs: [FAKE_AGENT],
			authRuntime: async () => auth.runtime,
			agentEnv: {
				...process.env,
				FAKE_AGENT_PROCESS_FILE: processFile,
				GENTLE_DOT_HISTORY_DIR: "/another-agent/private-history",
			},
		});
		daemons.push(daemon);
		const child = JSON.parse(readFileSync(processFile, "utf8")) as {
			env: Record<string, string>;
			argv: string[];
		};
		expect(child.argv.some((arg) => arg.endsWith("/dot-history.ts"))).toBe(own);
		expect(child.env.GENTLE_DOT_HISTORY_DIR).toBe(own ? join(dir, "sessions") : undefined);
		const received: ServerPayload[] = [];
		const other: ServerPayload[] = [];
		const client = { send: (payload: ServerPayload) => received.push(payload) };
		const detach = daemon.bridge.attach(client);
		const detachOther = daemon.bridge.attach({ send: (payload) => other.push(payload) });
		try {
			expect(received[0]).toMatchObject({ type: "ready", features: { historyRefresh: true } });
			await daemon.bridge.handle(client, { type: "get_history", requestId: "refresh-once" });
			expect(received.findLast((item) => item.type === "history")).toMatchObject({
				requestId: "refresh-once",
			});
			expect(other.filter((item) => item.type === "history")).toHaveLength(0);
			await daemon.bridge.handle(client, { type: "get_history" });
			expect(received.findLast((item) => item.type === "history")).not.toHaveProperty("requestId");
			await daemon.bridge.handle(client, { type: "list_conversations" });
			expect(received.findLast((item) => item.type === "conversations")).toMatchObject({ conversations: [] });
		} finally {
			detach();
			detachOther();
		}
	},
);
