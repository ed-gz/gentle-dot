import type { ServerPayload } from "@gentle-dot/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { DotBridge } from "../src/bridge.ts";
import type { WorkflowStatus } from "../src/workflows.ts";
import { fakeSupervisor } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

it.each(["adapter-outdated", "human", "disconnected", "review", "uncertain", undefined] as const)(
	"emits the reload message only for adapter-outdated (reason=%s)",
	async pauseReason => {
		const { supervisor, dataDir } = fakeSupervisor();
		cleanups.push(() => supervisor.stop());
		const bridge = new DotBridge(supervisor, { dataDir });
		const received: ServerPayload[] = [];
		const client = { send: (payload: ServerPayload) => received.push(payload) };
		bridge.attach(client);
		const answer = vi.fn(async (_choice: "continue" | "stop") => {});
		const message = "La sesión portal usa una versión anterior del conector. Escribí /reload en esa sesión y decime «seguí vigilando».";
		const pause: Pick<WorkflowStatus, "pauseReason" | "lastMessage"> = { pauseReason, lastMessage: message };
		bridge.askWatchContinuation("portal", answer, pause);
		const asks = received.filter(payload => payload.type === "ask");
		expect(asks).toHaveLength(1);
		const ask = asks[0]!.ask;
		expect(ask.title).toBe(pauseReason === "adapter-outdated" ? message : "¿Sigo vigilando la sesión portal o la dejo?");
		expect(ask.options).toEqual(["Continuar", "Dejar de vigilar"]);
		expect(answer).not.toHaveBeenCalled();
		await bridge.handle(client, { type: "ui_response", requestId: ask.requestId, value: "Dejar de vigilar" });
		expect(answer).toHaveBeenCalledExactlyOnceWith("stop");
	},
);
