import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { ExtensionContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { bundledMcpCli } from "../src/connectors.ts";
import { installRpcDialogGuard } from "../src/extensions/rpc-dialog-guard.ts";
import { JsonlDecoder } from "../src/jsonl.ts";
import { localRequest } from "../src/orchestration/herdr.ts";
import { tempDir, waitFor } from "./helpers.ts";

const fixture = fileURLToPath(new URL("./fixtures/rpc-guard-engine.ts", import.meta.url));
it("invalidates session changes, local cancellation and disposal without consuming stale answers", async () => {
	let session = "session-a";
	const native = vi.fn((_title: string, _message: string, options?: ExtensionUIDialogOptions) => new Promise<boolean>(resolve => {
		if (options?.signal?.aborted) return resolve(false);
		options?.signal?.addEventListener("abort", () => resolve(false), { once: true });
	}));
	const ui = { confirm: native, select: vi.fn(), input: vi.fn() } as unknown as ExtensionContext["ui"];
	const guard = installRpcDialogGuard(ui, () => session);
	const pending = ui.confirm("Question", "content");
	const q = guard.snapshot()!;
	session = "session-b";
	expect(guard.snapshot()).toBeNull();
	expect(guard.answer({ instanceId: q.instanceId, sessionId: q.sessionId, questionId: q.questionId, revision: q.revision, confirmed: true })).toBe(false);
	guard.dispose();
	await expect(pending).resolves.toBe(false);
	expect(ui.confirm).toBe(native);
	expect(guard.answer({ instanceId: q.instanceId, sessionId: q.sessionId, questionId: q.questionId, revision: q.revision, confirmed: true })).toBe(false);
});

it("binds RPC answers to the exact consumer, keeps the legacy desktop path and rejects stale revisions", async () => {
	const dir = tempDir(), agent = join(dir, "agent"), socket = join(dir, "guard.sock");
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "unused", models: [{ id: "fake" }] } } }));
	const cli = bundledMcpCli();
	const child = spawn(cli.command, [...cli.args, "--mode", "rpc", "--no-session", "--model", "fake/fake", "-e", fixture], {
		cwd: dir, env: { ...process.env, HOME: dir, PI_CODING_AGENT_DIR: agent, RPC_GUARD_TEST_SOCKET: socket }, stdio: ["pipe", "pipe", "pipe"],
	});
	const records: Record<string, unknown>[] = [];
	const decoder = new JsonlDecoder(record => records.push(record as Record<string, unknown>));
	child.stdout.on("data", (bytes: Buffer) => decoder.push(bytes));
	let stderr = "";
	child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString(); });
	try {
		await waitFor(() => existsSync(socket), 15_000).catch(() => { throw new Error(`Pi did not initialize: ${stderr.slice(-2000)}`); });
		const call = (method: string, params: Record<string, unknown> = {}) => localRequest(socket, method, params);
		await waitFor(() => records.find(r => r.type === "extension_ui_request" && r.title === "Review"));
		const q = (await call("snapshot")).question as Record<string, unknown>;
		expect(q).toMatchObject({ title: "Review", message: "original content", kind: "confirm" });
		const binding = { instanceId: q.instanceId, sessionId: q.sessionId, questionId: q.questionId, revision: q.revision };
		expect(await call("answer", { ...binding, revision: "changed", confirmed: true })).toEqual({ accepted: false });
		expect(await call("answer", { ...binding, sessionId: "other", confirmed: true })).toEqual({ accepted: false });
		expect(await call("answer", { ...binding, confirmed: true, value: "extra" })).toEqual({ accepted: false });
		expect(await call("answer", { ...binding, confirmed: true })).toEqual({ accepted: true });
		await waitFor(() => records.find(r => r.method === "notify" && r.message === "first:true"));
		const legacy = await waitFor(() => records.find(r => r.method === "confirm" && r.title === "Legacy"));
		child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: legacy.id, confirmed: false })}\n`);
		await waitFor(() => records.find(r => r.method === "notify" && r.message === "legacy:false"));
		await waitFor(() => records.find(r => r.method === "select" && r.title === "Choose"));
		const choice = (await call("snapshot")).question as Record<string, unknown>;
		const next = { instanceId: choice.instanceId, sessionId: choice.sessionId, questionId: choice.questionId, revision: choice.revision };
		expect(await call("answer", { ...next, revision: binding.revision, value: "A" })).toEqual({ accepted: false });
		expect(await call("answer", { ...next, value: "C" })).toEqual({ accepted: false });
		expect(await call("answer", { ...next, value: "B" })).toEqual({ accepted: true });
		await waitFor(() => records.find(r => r.method === "notify" && r.message === "choice:B"));
		expect(await call("answer", { ...next, value: "B" })).toEqual({ accepted: false });
	} finally { child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
