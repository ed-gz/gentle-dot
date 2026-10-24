import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createConnection } from "node:net";
import { ATTACHMENT_IPC_BYTES } from "../src/orchestration/session-attachments.ts";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { startDaemon } from "../src/daemon.ts";
import { SESSION_EXTENSION_PATH } from "../src/orchestration/index.ts";
import { localRequest } from "../src/orchestration/herdr.ts";
import { CAPTURE_JPEG } from "./fixtures/capture-image.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });

async function fixture(images = true) {
 const dataDir = tempDir(); const cwd = join(dataDir, "destination"); mkdirSync(cwd);
 vi.stubEnv("GENTLE_DOT_SESSION_DIR", join(dataDir, "pi-sessions")); vi.stubEnv("HERDR_ENV", "0"); vi.stubEnv("ORCA_PANE_KEY", "");
 const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
 const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true,
  noContextFiles: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [SESSION_EXTENSION_PATH] });
 const model: Model<"openai-completions"> = { id: "attachments-offline", name: "Offline", api: "openai-completions", provider: "openai",
  baseUrl: "https://fixture.invalid", input: images ? ["text", "image"] : ["text"], reasoning: false, contextWindow: 100000,
  maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
 const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models"), refreshOnCreate: false, allowModelNetwork: false });
 await runtime.setRuntimeApiKey("openai", "offline-fixture-key"); await loader.reload();
 expect(loader.getExtensions().errors).toEqual([]);
 const { session } = await createAgentSession({ cwd, agentDir: cwd, resourceLoader: loader, model, modelRuntime: runtime,
  settingsManager, sessionManager: SessionManager.inMemory(cwd), tools: ["read"] });
 cleanups.push(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); await session.abort(); session.dispose(); });
 const requests: unknown[][] = [];
 session.agent.streamFunction = (_model, context) => {
  requests.push(structuredClone(context.messages));
  const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
   usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
   stopReason: "stop", content: [{ type: "text", text: "offline acknowledgement" }] };
  const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: "stop", message }); return stream;
 };
 await session.bindExtensions({ mode: "tui", onError: error => { throw error; } });
 const manifest = JSON.parse(readFileSync(join(dataDir, "pi-sessions", readdirSync(join(dataDir, "pi-sessions")).find(name => name.endsWith(".json"))!), "utf8"));
 const uiDir = join(dataDir, "ui"); mkdirSync(uiDir); writeFileSync(join(uiDir, "index.html"), "fixture");
 const workspace = join(dataDir, "dot-workspace");
 const daemon = await startDaemon({ port: 0, host: "127.0.0.1", dataDir, uiDir, workspace, agentCommand: process.execPath, agentArgs: [FAKE_AGENT] });
 cleanups.push(() => daemon.close());
 const target = { paneId: `pi:${manifest.instanceId}`, sessionId: manifest.sessionId };
 const headers = { Authorization: `Bearer ${daemon.token}` };
 const url = `http://127.0.0.1:${daemon.port}`;
 const upload = (name: string, bytes: Buffer | string, destination: Record<string, string> = target, extra = {}) => fetch(`${url}/upload`, {
  method: "POST", headers: { ...headers, "X-File-Name": name, "X-Agent-Pane": destination.paneId!, "X-Agent-Session": destination.sessionId!, ...extra }, body: bytes as BodyInit });
 const prompt = (body: object, token = daemon.token) => fetch(`${url}/orchestration`, { method: "POST", headers: {
  Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "prompt", ...target, ...body }) });
 const roots = () => readdirSync(cwd).filter(name => name.startsWith(".dot-attachments-"));
 return { cwd, workspace, daemon, target, manifest, session, requests, upload, prompt, roots, url, headers };
}

it("queues a real HTTP steering message during inference, confirms native consumption, and deduplicates an explicit retry", async () => {
 const h = await fixture();
 const original = h.session.agent.streamFunction;
 let release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 let first = true;
 h.session.agent.streamFunction = (model, context, options) => {
  const source = original(model, context, options);
  if (!first) return source;
  first = false;
  const held = createAssistantMessageEventStream();
  void (async () => { for await (const event of await source) { await gate; held.push(event); } })();
  return held;
 };
 const initial = h.session.prompt("initial work");
 try {
  await waitFor(() => h.requests.length === 1);
  const input = { text: "steer this running session", clientMessageId: "native-message-123", deliverAs: "steer" };
  expect((await h.prompt(input)).status).toBe(200);
  await waitFor(() => h.session.pendingMessageCount === 1);
  const inspect = () => localRequest(h.manifest.socketPath, "snapshot", { expectedSessionId: h.target.sessionId, expectedInstanceId: h.manifest.instanceId });
  expect(await inspect()).toMatchObject({ deliveries: [{ id: input.clientMessageId, status: "queued" }] });
  expect(h.requests).toHaveLength(1);
  release();
  await initial;
  await h.session.waitForIdle();
  expect(h.requests).toHaveLength(2);
  expect(JSON.stringify(h.requests[1])).toContain(input.text);
  expect(await inspect()).toMatchObject({ deliveries: [{ id: input.clientMessageId, status: "delivered" }] });
  expect((await h.prompt(input)).status).toBe(200);
  expect((await h.prompt({ ...input, text: "changed message" })).status).toBe(409);
  expect(h.requests).toHaveLength(2);
 } finally { release(); await initial; }
});

it("delivers authenticated image, document and audio-file bytes to the exact managed Pi runner, once", async () => {
 const h = await fixture();
 const files = [await (await h.upload("photo.jpg", CAPTURE_JPEG)).json(), await (await h.upload("report.txt", "quarterly numbers")).json(), await (await h.upload("voice.wav", "RIFFfixtureWAVEaudio")).json()];
 const refs = files.map(({ uploadId, name }) => ({ uploadId, name }));
 const response = await h.prompt({ text: "inspect these", attachments: refs });
 expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ accepted: true, sessionId: h.target.sessionId, instanceId: h.manifest.instanceId });
 await waitFor(() => h.requests.length === 1); await h.session.waitForIdle();
 const user = h.requests[0]!.find((message: any) => message.role === "user") as any;
 expect(user.content).toContainEqual({ type: "image", mimeType: "image/jpeg", data: CAPTURE_JPEG.toString("base64") });
 const text = user.content.find((part: any) => part.type === "text").text as string;
 expect(text).toContain("inspect these\n\n<attachments>");
 const entries = text.split("\n").filter(line => line.startsWith("{\"name\"")).map(line => JSON.parse(line));
 expect(entries.map(entry => entry.name)).toEqual(["photo.jpg", "report.txt", "voice.wav"]);
 expect(entries.map(entry => entry.type)).toEqual(["image/jpeg", "application/octet-stream", "application/octet-stream"]);
 entries.forEach((entry, index) => {
  expect(relative(h.cwd, entry.path)).toMatch(/^\.dot-attachments-/);
  expect(statSync(entry.path).mode & 0o077).toBe(0);
  expect(readFileSync(entry.path)).toEqual([
   CAPTURE_JPEG, Buffer.from("quarterly numbers"), Buffer.from("RIFFfixtureWAVEaudio"),
  ][index]);
 });
 const count = h.roots().length;
 expect((await h.prompt({ text: "replay", attachments: refs })).status).toBe(400);
 expect(h.roots()).toHaveLength(count); expect(h.requests).toHaveLength(1);
 const only = await (await h.upload("only.txt", Buffer.alloc(200_000, 97))).json();
 expect((await h.prompt({ text: "", attachments: [{ uploadId: only.uploadId, name: only.name }] })).status).toBe(200);
 await waitFor(() => h.requests.length === 2); await h.session.waitForIdle();
 expect((await h.prompt({ text: "/literal command" })).status).toBe(200);
 await waitFor(() => h.requests.length === 3); await h.session.waitForIdle();
 expect(JSON.stringify(h.requests[2])).toContain("/literal command");
 const native = { expectedSessionId: h.target.sessionId, expectedInstanceId: h.manifest.instanceId, text: "lost acknowledgement fixture", deliveryId: "b".repeat(64), deliveryTokens: ["a".repeat(64)], files: [{ name: "dedup.txt", mime: "application/octet-stream", data: Buffer.from("once").toString("base64") }] };
 await localRequest(h.manifest.socketPath, "prompt", native);
 await waitFor(() => h.requests.length === 4); await h.session.waitForIdle();
 const roots = h.roots();
 await expect(localRequest(h.manifest.socketPath, "prompt", native)).resolves.toMatchObject({ accepted: true });
 await expect(localRequest(h.manifest.socketPath, "prompt", { ...native, deliveryId: "c".repeat(64) })).rejects.toMatchObject({ code: "ATTACHMENT_REPLAY" });
 expect(h.requests).toHaveLength(4); expect(h.roots()).toEqual(roots);
});

it("rejects malformed, foreign, changed-session and unauthorized refs without materialization or model calls", async () => {
 const h = await fixture();
 const uploaded = await (await h.upload("owned.txt", "owned bytes")).json(); const refs = [{ uploadId: uploaded.uploadId, name: uploaded.name }];
 for (const body of [
  { text: "x", attachments: [{ path: "/etc/passwd" }] },
  { text: "x", attachments: [{ url: "http://127.0.0.1/" }] },
  { text: "x", attachments: [...refs, ...refs] },
  { text: "x", attachments: refs, sessionId: "different" },
  { text: "x", attachments: [{ uploadId: uploaded.uploadId, name: "../owned.txt" }] },
 ]) expect((await h.prompt(body)).status).toBeGreaterThanOrEqual(400);
 expect((await h.prompt({ text: "x", attachments: refs }, "invalid-device-token")).status).toBe(401);
 const api = async (path: string, body: object, token?: string) => fetch(`${h.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
 const { code } = await (await api("/api/mobile/code", {}, h.daemon.token)).json();
 const device = await (await api("/api/mobile/pair", { code, deviceName: "Other phone" })).json();
 expect(typeof device.token).toBe("string");
 expect((await h.prompt({ text: "foreign authenticated device", attachments: refs }, device.token)).status).toBe(400);
 expect((await api("/api/mobile/revoke", { deviceId: device.deviceId }, h.daemon.token)).status).toBe(200);
 expect((await h.prompt({ text: "revoked device", attachments: refs }, device.token)).status).toBe(401);
 // Unscoped Dot files cannot be stolen by an agent, and agent files cannot join a Dot batch.
 const dot = await fetch(`${h.url}/upload`, { method: "POST", headers: { ...h.headers, "X-File-Name": "dot.txt" }, body: "Dot" });
 const ordinary = await dot.json();
 expect((await h.prompt({ text: "x", attachments: [{ uploadId: ordinary.uploadId, name: ordinary.name }] })).status).toBe(400);
 expect((await fetch(`${h.url}/upload`, { method: "POST", headers: { ...h.headers, "X-File-Name": "join.txt", "X-Upload-Id": uploaded.uploadId }, body: "no" })).status).toBe(404);
 expect((await h.upload("changed.txt", "no", { ...h.target, sessionId: "different" })).status).toBe(409);
 expect(h.roots()).toEqual([]); expect(h.requests).toEqual([]);
 const stored = readdirSync(join(h.workspace, "uploads"));
 h.session.setActiveToolsByName([]);
 const unsupported = await h.upload("unsupported.txt", "must not be saved");
 expect(unsupported.status).toBe(409);
 expect(await unsupported.json()).toMatchObject({ message: expect.stringContaining("no admite archivos") });
 expect((await h.prompt({ text: "unsupported", attachments: refs })).status).toBe(409);
 expect(readdirSync(join(h.workspace, "uploads"))).toEqual(stored);
 expect(h.roots()).toEqual([]); expect(h.requests).toEqual([]);
 h.session.setActiveToolsByName(["read"]);
 expect((await h.prompt({ text: "valid after rejections", attachments: refs })).status).toBe(200);
 await waitFor(() => h.requests.length === 1); await h.session.waitForIdle();
 await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
 expect((await h.upload("disconnected.txt", "must not be saved")).status).toBe(409);
 expect(h.requests).toHaveLength(1);
});

it("rejects unsupported model images before consuming refs or writing destination files", async () => {
 const h = await fixture(false);
 const image = await (await h.upload("photo.jpg", CAPTURE_JPEG)).json();
 const refs = [{ uploadId: image.uploadId, name: image.name }];
 for (let i = 0; i < 2; i++) {
  const response = await h.prompt({ text: "", attachments: refs }); expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("no admite imágenes") });
 }
 expect(h.roots()).toEqual([]); expect(h.requests).toEqual([]);
 // Native socket repeats capability and shape validation; no invented local paths are accepted.
 await expect(localRequest(h.manifest.socketPath, "prompt", { expectedSessionId: h.target.sessionId, expectedInstanceId: h.manifest.instanceId,
  text: "", files: [{ name: "bad.txt", mime: "application/octet-stream", data: "aA==", path: "/tmp/injected" }] })).rejects.toMatchObject({ code: "INVALID_ATTACHMENTS" });
 expect(h.roots()).toEqual([]); expect(h.requests).toEqual([]);
 expect(existsSync(join(h.workspace, "uploads", image.uploadId, image.name))).toBe(true);
 await expect(localRequest(h.manifest.socketPath, "snapshot", {
  expectedSessionId: h.target.sessionId, expectedInstanceId: h.manifest.instanceId,
  padding: "x".repeat(128 * 1024),
 })).rejects.toMatchObject({ code: "TOO_LARGE" });
 let authorizationChecks = 0;
 await expect(localRequest(h.manifest.socketPath, "prompt", {
  expectedSessionId: h.target.sessionId, expectedInstanceId: h.manifest.instanceId,
  text: "", deliveryId: "d".repeat(64), deliveryTokens: ["e".repeat(64)],
  files: [{ name: "cancelled.txt", mime: "application/octet-stream", data: Buffer.alloc(200_000).toString("base64") }],
 }, 5_000, () => ++authorizationChecks === 1)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
 expect(authorizationChecks).toBe(2);
 // An unterminated oversized envelope is dropped before JSON parsing/materialization.
 await new Promise<void>((resolve, reject) => {
  const socket = createConnection(h.manifest.socketPath);
  socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error("oversized socket did not close")); });
  socket.on("error", () => {});
  socket.once("close", () => resolve());
  socket.once("connect", () => socket.end(Buffer.alloc(ATTACHMENT_IPC_BYTES + 1, 32)));
 });
 expect(h.roots()).toEqual([]); expect(h.requests).toEqual([]);
});
