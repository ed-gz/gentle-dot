import type { ServerPayload } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DotBridge } from "../src/bridge.ts";
import type { AgentSupervisor, SupervisorEvent } from "../src/supervisor.ts";
import { fakeSupervisor, waitFor } from "./helpers.ts";

const supervisors: AgentSupervisor[] = [];
afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((s) => s.stop()));
	vi.restoreAllMocks();
});

async function setup(env: NodeJS.ProcessEnv) {
	const { supervisor, dataDir } = fakeSupervisor({ env: { ...process.env, ...env } });
	supervisors.push(supervisor);
	let relay: (event: SupervisorEvent) => void = () => {};
	const subscribe = supervisor.onEvent.bind(supervisor);
	vi.spyOn(supervisor, "onEvent").mockImplementation((listener) => {
		relay = listener;
		return subscribe(listener);
	});
	const logs: string[] = [];
	const bridge = new DotBridge(supervisor, {
		dataDir,
		log: (line) => logs.push(line),
		stopTimeoutMs: 300,
		features: { conversations: true },
	});
	const received: ServerPayload[] = [];
	const client = { send: (payload: ServerPayload) => received.push(payload) };
	bridge.attach(client);
	await supervisor.start();
	return { bridge, client, received, logs, emit: (event: SupervisorEvent) => relay(event) };
}

describe("stopping before a switch", () => {
	it("keeps received messages visible after settlement until the engine consumes or clears them", async () => {
		const h = await setup({});
		h.emit({ type: "queue_update", steering: ["keep this instruction"], followUp: [] });
		h.emit({ type: "agent_settled" });
		expect(h.received.findLast((item) => item.type === "queue")).toEqual({
			type: "queue",
			steering: ["keep this instruction"],
			followUp: [],
		});
		const reconnected: ServerPayload[] = [];
		const detach = h.bridge.attach({ send: (payload) => reconnected.push(payload) });
		expect(reconnected).toContainEqual({ type: "queue", steering: ["keep this instruction"], followUp: [] });
		detach();
		h.emit({ type: "queue_update", steering: [], followUp: [] });
		expect(h.received.findLast((item) => item.type === "queue")).toEqual({
			type: "queue",
			steering: [],
			followUp: [],
		});
	});
	it("treats an engine-confirmed input handoff as a continuation, without hiding a later real stop", async () => {
		const h = await setup({});
		h.emit({
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: "gentle-dot-live-input",
			statusText: "interrupting",
		});
		h.emit({ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } });
		const handoff = h.received.findLast((item) => item.type === "message_done");
		expect(handoff).toMatchObject({ type: "message_done", intermediate: true });
		expect(handoff).not.toHaveProperty("stopped");
		h.emit({ type: "extension_ui_request", method: "setStatus", statusKey: "gentle-dot-live-input" });
		h.emit({ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } });
		expect(h.received.findLast((item) => item.type === "message_done")).toMatchObject({ stopped: true });
	});

	it("keeps an explicit Stop effective even while a human-message handoff is pending", async () => {
		const h = await setup({});
		await h.bridge.handle(h.client, { type: "send", text: "hang" });
		await waitFor(() => h.bridge.agentState === "thinking");
		h.emit({
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: "gentle-dot-live-input",
			statusText: "interrupting",
		});
		await h.bridge.handle(h.client, { type: "abort" });
		await waitFor(() => h.bridge.agentState === "idle");
		expect(h.received.findLast((item) => item.type === "message_done")).toMatchObject({ stopped: true });
	});
	it("marks tool continuations without classifying the final answer as intermediate", async () => {
		const { bridge, client, received } = await setup({});
		await bridge.handle(client, { type: "send", text: "tool-progress" });
		await waitFor(() => received.filter((item) => item.type === "message_done").length === 2);
		expect(received).toContainEqual(
			expect.objectContaining({ type: "message_done", text: "Revisando archivos", intermediate: true }),
		);
		const final = received.find((item) => item.type === "message_done" && item.text === "Revisión terminada");
		expect(final).not.toHaveProperty("intermediate");
	});

	it("stops the current response without a background pause side effect", async () => {
		const { bridge, client, received } = await setup({});
		await bridge.handle(client, { type: "send", text: "hang" });
		await waitFor(() => bridge.agentState === "thinking");
		await bridge.handle(client, { type: "abort" });
		await waitFor(() => bridge.agentState === "idle");
		expect(received).toContainEqual(expect.objectContaining({ type: "message_done", stopped: true }));
	});
	it("still switches after a bounded wait when the agent ignores the stop, and clears the stop mark", async () => {
		const { bridge, client, received, logs } = await setup({ FAKE_AGENT_IGNORE_ABORT: "1" });
		await bridge.handle(client, { type: "send", text: "hang" });
		await waitFor(() => bridge.agentState === "thinking");
		const started = Date.now();
		await bridge.handle(client, { type: "new_conversation" });
		expect(Date.now() - started).toBeLessThan(3000);
		expect(logs.some((line) => line.includes("did not stop"))).toBe(true);
		const history = received.findIndex((p) => p.type === "history");
		const stopped = received.findIndex((p) => p.type === "message_done" && p.stopped === true);
		expect(stopped).toBeGreaterThanOrEqual(0);
		expect(stopped).toBeLessThan(history);
		expect(received.filter((p) => p.type === "error" || p.type === "toast")).toEqual([]);
		await waitFor(() => bridge.agentState === "idle");

		// The mark is gone: a real failure afterwards is an error, not a stop.
		await bridge.handle(client, { type: "send", text: "fail" });
		const failed = await waitFor(() =>
			received.find(
				(p): p is Extract<ServerPayload, { type: "message_done" }> =>
					p.type === "message_done" && p.error !== undefined,
			),
		);
		expect(failed.stopped).toBeUndefined();
	});
});
