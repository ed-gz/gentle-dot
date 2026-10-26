import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { type ExtensionAPI, type ExtensionContext, type ExtensionUIDialogOptions, initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { createDotSession } from "../src/extensions/dot-session.ts";
import { localRequest } from "../src/orchestration/herdr.ts";
import * as registry from "../src/orchestration/registry.ts";
import { WorkflowContinuations } from "../src/workflows.ts";

initTheme("dark", false);
const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
 vi.restoreAllMocks();
 for (const close of cleanups.splice(0).reverse()) await close();
});
function deferred<T>() {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>(done => { resolve = done; });
 return { promise, resolve };
}
async function fixture(startImmediately = true) {
 const directory = await mkdtemp(join(tmpdir(), "dot-reconnect-"));
 cleanups.push(() => rm(directory, { recursive: true, force: true }));
 const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
 const ctx = {
  mode: "tui", cwd: directory, isIdle: () => true,
  ui: { notify: vi.fn(), confirm: (_title: string, _message: string, options?: ExtensionUIDialogOptions) => new Promise<boolean>(resolve => {
   options?.signal?.addEventListener("abort", () => resolve(false), { once: true });
  }) },
  sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined, getBranch: () => [] },
 } as unknown as ExtensionContext;
 const pi = { on: (name: string, callback: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, callback),
  events: { on: () => () => {}, emit: () => {} }, sendUserMessage: vi.fn() } as unknown as ExtensionAPI;
 const registryDir = join(directory, "pi-sessions");
 const extension = createDotSession(pi, { GENTLE_DOT_SESSION_DIR: registryDir });
 cleanups.push(extension.close);
 await handlers.get("session_start")?.({}, ctx);
 const [manifest] = await registry.readManifests([registryDir], "");
 if (!manifest) throw new Error("Missing test adapter");
 const call = (method: string, params = {}) => localRequest(manifest.socketPath, method, {
  expectedSessionId: "s1", expectedInstanceId: manifest.instanceId, ...params,
 });
 const target = { paneId: "pane-a", sessionId: "s1" };
 const coordinator = new WorkflowContinuations({
  dataDir: directory, registryDirs: [registryDir],
  snapshot: async () => {
   const page = await call("snapshot");
   return { sessions: [{ ...target, label: "Local", state: page.question ? "blocked" : "working", connected: true,
    activityInstanceId: manifest.instanceId, humanActivityAt: (page.companionActivity as { humanActivityAt?: string }).humanActivityAt,
    capabilities: { inspect: true, approvals: true, activityFence: 1 } }],
    approvals: page.question ? [{ ...target, id: String((page.question as { id: string }).id) }] : [] };
  }, inspect: () => call("snapshot"), prompt: vi.fn(),
 });
 cleanups.push(() => coordinator.close());
 const start = () => coordinator.dispatch({ action: "start", mode: "session", objective: "Run project tests", authorization: "Aprueba todos los permisos de esta sesión", sessions: [target] }, "agent");
 if (startImmediately) await start();
 const tool = (id: string) => handlers.get("tool_call")?.({ toolName: "bash", toolCallId: id, input: { command: "npm test" } }, ctx);
 return { coordinator, call, tool, start, manifest };
}
it("rejects a stale pre-disconnect registry completion before sending enrollment", async () => {
 const h = await fixture(false);
 const entered = deferred<void>();
 const unblock = deferred<Awaited<ReturnType<typeof registry.readManifests>>>();
 vi.spyOn(registry, "readManifests").mockImplementationOnce(async () => { entered.resolve(); return unblock.promise; });
 const starting = h.start();
 await entered.promise;
 h.coordinator.onEvent({ id: "offline", type: "disconnected", at: new Date().toISOString() });
 const writes = vi.spyOn(Socket.prototype, "write");
 unblock.resolve([h.manifest]);
 await starting;
 await h.coordinator.poll(false);
 expect(writes.mock.calls.filter(args => String(args[0]).includes('"method":"workflow.enroll"'))).toHaveLength(0);
 expect(h.coordinator.status().workflows[0]?.state).toBe("paused");
});
it("fresh enrollment after reconnect permits newly generated workspace grants", async () => {
 const h = await fixture();
 h.coordinator.onEvent({ id: "offline", type: "disconnected", at: new Date().toISOString() });
 await h.coordinator.prepare();
 await h.coordinator.poll(false);
 expect(h.coordinator.status().workflows[0]?.state).toBe("waiting");
 const waiting = h.tool("fresh-grant");
 const question = (await h.call("snapshot")).question as { id: string };
 expect(question).not.toBeNull();
 await h.call("answer", { questionId: question.id, confirmed: true, expectedHumanActivityAt: null });
 await waiting;
});
it("replaces enrollment and invalidates its WeakMap grant when reconnect beats queued revocation", async () => {
 const sockets: Socket[] = [];
 const write = Socket.prototype.write;
 vi.spyOn(Socket.prototype, "write").mockImplementation(function(this: Socket, ...args: Parameters<Socket["write"]>) {
  if (String(args[0]).includes('"method":"workflow.enroll"')) sockets.push(this);
  return write.apply(this, args);
 });
 const h = await fixture();
 const waiting = h.tool("old-grant");
 const question = (await h.call("snapshot")).question as { id: string };
 const entered = deferred<void>();
 const unblock = deferred<Awaited<ReturnType<typeof registry.readManifests>>>();
 const realRead = registry.readManifests;
 vi.spyOn(registry, "readManifests").mockImplementationOnce(async () => { entered.resolve(); return unblock.promise; });
 const syncing = h.coordinator.poll(false);
 await entered.promise;
 h.coordinator.onEvent({ id: "offline", type: "disconnected", at: new Date().toISOString() });
 // Recovery saves waiting state while the old registry read still holds the sync queue.
 await h.coordinator.prepare();
 expect(h.coordinator.status().workflows[0]?.state).toBe("waiting");
 // The old WeakMap capability is already invalid while registry I/O is still blocked.
 await expect(h.call("answer", { questionId: question.id, confirmed: true, expectedHumanActivityAt: null })).rejects.toMatchObject({ code: "HUMAN_REQUIRED" });
 unblock.resolve(await realRead([], ""));
 await syncing;
 await h.coordinator.poll(false);
 expect(sockets).toHaveLength(2);
 expect(sockets[0]).not.toBe(sockets[1]);
 await expect(h.call("answer", { questionId: question.id, confirmed: true, expectedHumanActivityAt: null })).rejects.toMatchObject({ code: "HUMAN_REQUIRED" });
 await h.call("answer", { questionId: question.id, confirmed: false });
 await waiting;

});
