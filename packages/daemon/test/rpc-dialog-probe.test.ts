// Investigative test, not proof that the bridge supports RPC questions. It loads
// the real bundled Pi with a test-only mode shim; production never loads it.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundledMcpCli } from "../src/connectors.ts";
import { JsonlDecoder } from "../src/jsonl.ts";
import { localRequest } from "../src/orchestration/herdr.ts";
import { tempDir, waitFor } from "./helpers.ts";

const fixture = fileURLToPath(new URL("./fixtures/rpc-dialog-probe.ts", import.meta.url));

describe("real Pi RPC dialog adapter feasibility", () => {
	it("resolves the original RPC confirm and rejects a changed question under the same id", async () => {
		const dir = tempDir(), agent = join(dir, "agent"), registry = join(dir, "registry");
		mkdirSync(agent, { recursive: true });
		writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "unused", models: [{ id: "fake" }] } } }));
		const cli = bundledMcpCli();
		const child = spawn(cli.command, [...cli.args, "--mode", "rpc", "--no-session", "--model", "fake/fake", "-e", fixture], {
			cwd: dir, env: { ...process.env, HOME: dir, PI_CODING_AGENT_DIR: agent, GENTLE_DOT_SESSION_DIR: registry }, stdio: ["pipe", "pipe", "pipe"],
		});
		const records: Record<string, unknown>[] = [];
		let stderr = "";
		const decoder = new JsonlDecoder(record => records.push(record as Record<string, unknown>));
		child.stdout.on("data", (bytes: Buffer) => decoder.push(bytes));
		child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString(); });
		try {
			const path = await waitFor(() => {
				try { const name = readdirSync(registry).find(file => file.endsWith(".json")); return name ? join(registry, name) : undefined; }
				catch { return undefined; }
			}, 15_000).catch(() => { throw new Error(`RPC probe did not initialize: ${stderr.slice(-2000)}`); });
			const manifest = JSON.parse(readFileSync(path, "utf8"));
			const call = (method: string, params: Record<string, unknown> = {}) => localRequest(manifest.socketPath, method, { expectedInstanceId: manifest.instanceId, expectedSessionId: manifest.sessionId, ...params });
			await waitFor(() => records.find(record => record.type === "extension_ui_request" && record.method === "confirm"), 15_000);
			const original = await call("snapshot");
			const question = original.question as Record<string, unknown>;
			expect(question).toMatchObject({ kind: "confirm", title: "First", message: "Original details" });
			await expect(call("answer", { questionId: question.id, expectedQuestionRevision: original.questionRevision, confirmed: true })).resolves.toMatchObject({ accepted: true });
			await waitFor(() => records.find(record => record.method === "notify" && record.message === "probe-confirm:true"));
			const legacy = await waitFor(() => records.find(record => record.type === "extension_ui_request" && record.method === "confirm" && record.title === "Second"));
			const legacySnapshot = await call("snapshot");
			expect(legacySnapshot.question).toMatchObject({ kind: "confirm", title: "Second" });
			child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: legacy.id, confirmed: false })}\n`);
			await waitFor(() => records.find(record => record.method === "notify" && record.message === "probe-legacy:false"));
			const replace = await waitFor(() => records.find(record => record.method === "input" && record.title === "Replace probe question"));
			const before = await call("snapshot");
			expect(before.question).toMatchObject({ id: "same-id" });
			child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: replace.id, value: "replace" })}\n`);
			let changed = before;
			for (let i = 0; i < 100 && changed.questionRevision === before.questionRevision; i++) {
				await new Promise(resolve => setTimeout(resolve, 30));
				changed = await call("snapshot");
			}
			expect(changed.question).toMatchObject({ id: "same-id" });
			expect(changed.questionRevision).not.toEqual(before.questionRevision);
			const answer = { questionId: "same-id", answers: [{ questionId: "one", optionIndices: [0] }] };
			await expect(call("answer", { ...answer, expectedQuestionRevision: before.questionRevision })).rejects.toMatchObject({ code: "QUESTION_CHANGED" });
			expect(records.some(record => record.message === "probe-questionnaire-consumed")).toBe(false);
			await expect(call("answer", { ...answer, expectedQuestionRevision: changed.questionRevision })).resolves.toMatchObject({ accepted: true });
			await waitFor(() => records.find(record => record.message === "probe-questionnaire-consumed"));
		} finally {
			child.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
