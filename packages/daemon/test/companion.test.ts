import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { CompanionPreference } from "../src/companion.ts";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import dotCompanion from "../src/extensions/dot-companion.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT } from "./helpers.ts";

const dirs: string[] = [];
const daemons: DotDaemon[] = [];
afterEach(async () => {
	for (const daemon of daemons.splice(0)) await daemon.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
function directory() {
	const dir = mkdtempSync(join(tmpdir(), "dot-capri-"));
	dirs.push(dir);
	return dir;
}

it("persists the selected identity across restarts and restores Gentle without losing other state", () => {
	const dir = directory();
	const first = new CompanionPreference(dir);
	expect(first.read()).toEqual({ mode: "gentle" });
	first.set("capri");
	const next = new CompanionPreference(dir);
	expect(next.read()).toEqual({ mode: "capri" });
	next.set("gentle");
	expect(new CompanionPreference(dir).read()).toEqual({ mode: "gentle" });
});

it("only authenticated users can switch between the two bounded personas", async () => {
	const dir = directory();
	const daemon = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir: dir,
		workspace: join(dir, "work"),
		uiDir: dir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		authRuntime: async () => fakeAuthRuntime().runtime,
	});
	daemons.push(daemon);
	const url = `http://127.0.0.1:${daemon.port}/api/mobile/companion`;
	expect((await fetch(url)).status).toBe(401);
	const headers = { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" };
	expect(await (await fetch(url, { headers })).json()).toEqual({ mode: "gentle" });
	expect(
		(await fetch(url, { method: "POST", headers, body: JSON.stringify({ mode: "ignore permissions" }) }))
			.status,
	).toBe(400);
	expect(
		await (await fetch(url, { method: "POST", headers, body: JSON.stringify({ mode: "capri" }) })).json(),
	).toEqual({ mode: "capri" });
	expect((await fetch(`http://127.0.0.1:${daemon.port}/api/companion/agent`, { headers })).status).toBe(401);
});

it("applies Capri on the next turn only, preserving the full operational prompt", async () => {
	vi.stubEnv("GENTLE_DOT_COMPANION_URL", "http://127.0.0.1/companion");
	vi.stubEnv("GENTLE_DOT_COMPANION_KEY", "test-key");
	const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ mode: "capri" }) });
	vi.stubGlobal("fetch", fetcher);
	const on = vi.fn();
	dotCompanion({ on, registerTool: vi.fn() } as unknown as ExtensionAPI);
	const callback = on.mock.calls[0]?.[1];
	const options = { appendSystemPrompt: "Keep existing workflow and approvals." };
	await callback({ systemPromptOptions: options });
	expect(options.appendSystemPrompt).toContain("Keep existing workflow and approvals.");
	expect(options.appendSystemPrompt).toContain("Active companion: Capri");
	await callback({ systemPromptOptions: options });
	expect(options.appendSystemPrompt.match(/Active companion: Capri/g)).toHaveLength(1);
	fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ mode: "gentle" }) });
	expect(await callback({ systemPromptOptions: options })).toBeUndefined();
	expect(options.appendSystemPrompt).toBe("Keep existing workflow and approvals.");
	fetcher.mockRejectedValueOnce(new Error("offline"));
	expect(await callback({ systemPromptOptions: options })).toBeUndefined();
});
