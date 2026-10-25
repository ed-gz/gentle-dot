import type { ServerPayload } from "@gentle-dot/protocol";
import { describe, expect, it, vi } from "vitest";
import { DotBridge } from "../src/bridge.ts";
import { LocalVoice } from "../src/local-voice.ts";
import type { AgentSupervisor } from "../src/supervisor.ts";
import { VoiceService } from "../src/voice.ts";

function setup() {
	const app = { connected: true, request: vi.fn(async () => ({ installed: true })) };
	const voice = new VoiceService({ apiKey: async () => undefined, local: new LocalVoice(app) });
	const supervisor = { onEvent: vi.fn() } as unknown as AgentSupervisor;
	const bridge = new DotBridge(supervisor, { dataDir: "/unused", voice });
	const received: ServerPayload[] = [];
	const detach = bridge.attach({ send: (payload) => received.push(payload) });
	return { app, voice, bridge, received, detach };
}

describe("live PC voice capability (S17.3, S15)", () => {
	it("refreshes on attach without requesting accounts", async () => {
		const { received } = setup();
		await vi.waitFor(() => expect(received).toContainEqual({
			type: "voice_capability", voice: { transcribe: true, speak: false, local: true },
		}));
		expect(received[0]).toMatchObject({ type: "ready", voice: { transcribe: false, speak: false } });
	});

	it("broadcasts channel and model availability changes to every client", async () => {
		const { app, bridge, received } = setup();
		const second: ServerPayload[] = [];
		bridge.attach({ send: (payload) => second.push(payload) });
		await vi.waitFor(() => expect(received).toContainEqual(expect.objectContaining({ type: "voice_capability" })));
		app.connected = false;
		await bridge.refreshVoiceCapability();
		for (const messages of [received, second]) expect(messages.at(-1)).toEqual({
			type: "voice_capability", voice: { transcribe: false, speak: false },
		});
		app.connected = true;
		await bridge.refreshVoiceCapability();
		expect(second.at(-1)).toMatchObject({ type: "voice_capability", voice: { local: true } });
		app.request.mockResolvedValue({ installed: false });
		await bridge.refreshVoiceCapability();
		expect(second.at(-1)).toEqual({ type: "voice_capability", voice: { transcribe: false, speak: false } });
	});

	it("does not deliver an attach refresh to a detached client", async () => {
		const { received, detach } = setup();
		detach();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(received).toHaveLength(1);
	});
});
