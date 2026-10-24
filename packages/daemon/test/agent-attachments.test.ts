import { mkdirSync, readdirSync, writeFileSync, existsSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startDaemon, type DotDaemon } from "../src/daemon.ts";
import { FAKE_AGENT, tempDir } from "./helpers.ts";
import { Readable } from "node:stream";
import { ATTACHMENT_LIMITS } from "@gentle-dot/protocol";
import { UploadStore } from "../src/uploads.ts";
import { ATTACHMENT_IPC_BYTES, decodeSessionFiles, SESSION_ATTACHMENT_LIMITS } from "../src/orchestration/session-attachments.ts";

const daemons: DotDaemon[] = [];
afterEach(async () => { for (const daemon of daemons.splice(0)) await daemon.close(); });

it("rejects authenticated uploads to an unbound agent before storing any bytes", async () => {
 const dataDir = tempDir();
 const uiDir = join(dataDir, "ui"); mkdirSync(uiDir); writeFileSync(join(uiDir, "index.html"), "fixture");
 const workspace = join(dataDir, "workspace");
 const daemon = await startDaemon({ port: 0, host: "127.0.0.1", dataDir, uiDir, workspace,
  agentCommand: process.execPath, agentArgs: [FAKE_AGENT] });
 daemons.push(daemon);
 const response = await fetch(`http://127.0.0.1:${daemon.port}/upload`, { method: "POST", headers: {
  Authorization: `Bearer ${daemon.token}`, "X-File-Name": "secret.txt",
  "X-Agent-Pane": "pi:missing", "X-Agent-Session": "missing-session",
 }, body: "must not be stored" });
 expect(response.status).toBe(409);
 expect(existsSync(join(workspace, "uploads")) ? readdirSync(join(workspace, "uploads")) : []).toEqual([]);
});

it("bounds native decoded file count, per-file and aggregate bytes before materialization", () => {
 expect(SESSION_ATTACHMENT_LIMITS).toEqual(ATTACHMENT_LIMITS);
 expect(ATTACHMENT_IPC_BYTES).toBe(Math.ceil(ATTACHMENT_LIMITS.messageBytes / 3) * 4 + 128 * 1024);
 const file = { name: "file.txt", mime: "application/octet-stream", data: "aGk=" };
 for (const invalid of [[], Array.from({ length: 11 }, () => file), [{ ...file, name: "../injected" }], [{ ...file, name: "https://evil.invalid" }], [{ ...file, data: "!!!!" }], [{ ...file, data: "a===" }], [{ ...file, path: "/etc/passwd" }], [{ ...file, mime: "text/html" }]])
  expect(() => decodeSessionFiles(invalid, true)).toThrow();
 expect(() => decodeSessionFiles([{ ...file, data: "A".repeat(Math.ceil(ATTACHMENT_LIMITS.fileBytes / 3) * 4 + 4) }], true)).toThrow();
 const large = { ...file, data: Buffer.alloc(18 * 1024 * 1024).toString("base64") };
 expect(() => decodeSessionFiles([large, large, large], true)).toThrow();
 expect(decodeSessionFiles([file], true)[0]?.bytes.toString()).toBe("hi");
});

it("binds agent batches to an exact owner, blocks cross-owner joins/replay/expiry and preserves ordinary Dot records", async () => {
 let now = 0;
 const store = new UploadStore({ workspace: tempDir(), now: () => now, ttlMs: 100 });
 const sent = await store.receive(Readable.from(["file"]), { name: "file.txt", owner: "device:session:instance" });
 expect(sent.ok).toBe(true); if (!sent.ok) throw new Error("upload refused");
 const refs = [{ uploadId: sent.file.uploadId, name: sent.file.name }];
 expect(store.resolve(refs).ok).toBe(false);
 expect(store.resolve(refs, "different-device:same-session:instance").ok).toBe(false);
 expect((await store.receive(Readable.from(["no"]), { name: "join.txt", uploadId: sent.file.uploadId, owner: "different" })).ok).toBe(false);
 expect(store.resolve(refs, "device:session:instance").ok).toBe(true);
 now = 100;
 expect(store.resolve(refs, "device:session:instance").ok).toBe(false);
 const dot = await store.receive(Readable.from(["ordinary"]), { name: "dot.txt" });
 if (!dot.ok) throw new Error("ordinary upload refused");
 const ordinary = [{ uploadId: dot.file.uploadId, name: dot.file.name }];
 expect(store.resolve(ordinary).ok).toBe(true); store.consume(ordinary); expect(store.resolve(ordinary).ok).toBe(false);
});

it("refuses a followed upload-store link instead of reading a substituted source path", async () => {
 const workspace = tempDir();
 const store = new UploadStore({ workspace });
 const upload = await store.receive(Readable.from(["safe"]), { name: "file.txt", owner: "owner" });
 if (!upload.ok) throw new Error("fixture upload failed");
 const path = join(workspace, upload.file.path);
 const outside = join(workspace, "sentinel.txt");
 writeFileSync(outside, "not an upload");
 renameSync(path, `${path}.original`);
 symlinkSync(outside, path);
 expect(() => store.readForSession([{ uploadId: upload.file.uploadId, name: upload.file.name }], "owner")).toThrow();
});
