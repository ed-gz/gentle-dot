import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { type ExtensionAPI, type ExtensionContext, type ExtensionUIDialogOptions, initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { createDotSession } from "../src/extensions/dot-session.ts";
import { localRequest } from "../src/orchestration/herdr.ts";
import * as herdr from "../src/orchestration/herdr.ts";
import * as registry from "../src/orchestration/registry.ts";
import { WorkflowContinuations, type WorkflowOptions } from "../src/workflows.ts";

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
 const options: WorkflowOptions = {
  dataDir: directory, registryDirs: [registryDir],
  snapshot: async () => {
   const page = await call("snapshot");
   return { sessions: [{ ...target, label: "Local", state: page.question ? "blocked" : "working", connected: true,
    activityInstanceId: manifest.instanceId, humanActivityAt: (page.companionActivity as { humanActivityAt?: string }).humanActivityAt,
    capabilities: { inspect: true, approvals: true, activityFence: 1, enrollmentProtocol: 1 } }],
    approvals: page.question ? [{ ...target, id: String((page.question as { id: string }).id) }] : [] };
  }, inspect: () => call("snapshot"), prompt: vi.fn(),
 };
 const coordinator = new WorkflowContinuations(options);
 cleanups.push(() => coordinator.close());
 const start = () => coordinator.dispatch({ action: "start", mode: "session", objective: "Run project tests", authorization: "Aprueba todos los permisos de esta sesión", sessions: [target] }, "agent");
 if (startImmediately) await start();
 const tool = (id: string) => handlers.get("tool_call")?.({ toolName: "bash", toolCallId: id, input: { command: "npm test" } }, ctx);
 return { coordinator, call, tool, start, manifest, options };
}
it.each([undefined, 0, 1])("verifies adapter-owned protocol %s before enrolling a persisted active delegation on startup", async protocol => {
 const h = await fixture();
 h.coordinator.close();
 const request = herdr.localRequest;
 vi.spyOn(herdr, "localRequest").mockImplementation(async (...args) => {
  const page = await request(...args);
  if (args[1] !== "snapshot") return page;
  return {...page, capabilities:{...(page.capabilities as object), enrollmentProtocol:protocol}};
 });
 const writes = vi.spyOn(Socket.prototype, "write");
 const notify = vi.fn<NonNullable<WorkflowOptions["askContinuation"]>>();
 const restarted = new WorkflowContinuations({...h.options, askContinuation:notify});
 cleanups.push(() => restarted.close());
 await restarted.poll(false); // Drain startup enrollment without invoking discovery recovery.
 const enrollments = writes.mock.calls.filter(args => String(args[0]).includes('"method":"workflow.enroll"'));
 expect(enrollments).toHaveLength(protocol === 1 ? 1 : 0);
 if (protocol === 1) {
  expect(restarted.status().workflows[0]?.state).toBe("waiting");
  expect(notify).not.toHaveBeenCalled();
 } else {
  expect(restarted.status().workflows[0]).toMatchObject({state:"paused", pauseReason:"adapter-outdated"});
  expect(notify).toHaveBeenCalledTimes(1);
  await restarted.poll(false);
  expect(notify).toHaveBeenCalledTimes(1);
 }
});
it.each(["instance", "session", "unavailable"])("does not enroll persisted authority with unverified snapshot evidence (%s)", async failure => {
 const h = await fixture();
 h.coordinator.close();
 const request = herdr.localRequest;
 vi.spyOn(herdr, "localRequest").mockImplementation(async (...args) => {
  if (args[1] === "snapshot" && failure === "unavailable") throw new Error("offline");
  const page = await request(...args);
  if (args[1] !== "snapshot") return page;
  return {...page, ...(failure === "instance" ? {instanceId:"other-instance"} : {sessionId:"other-session"})};
 });
 const writes = vi.spyOn(Socket.prototype, "write");
 const restarted = new WorkflowContinuations(h.options);
 cleanups.push(() => restarted.close());
 await restarted.poll(false);
 expect(writes.mock.calls.filter(args => String(args[0]).includes('"method":"workflow.enroll"'))).toHaveLength(0);
});
it("checks live protocol evidence before renewal and revokes an outdated enrolled adapter once", async () => {
 const h = await fixture();
 const writes = vi.spyOn(Socket.prototype, "write");
 await vi.waitFor(() => expect(writes.mock.calls.some(args => String(args[0]) === "workflow.renew\n")).toBe(true), {timeout:2500});
 const request = herdr.localRequest;
 vi.spyOn(herdr, "localRequest").mockImplementation(async (...args) => {
  const page = await request(...args);
  return args[1] === "snapshot" ? {...page, capabilities:{enrollmentProtocol:0}} : page;
 });
 const notify = vi.fn<NonNullable<WorkflowOptions["askContinuation"]>>();
 h.options.askContinuation = notify;
 writes.mockClear();
 await h.coordinator.poll(false);
 expect(h.coordinator.status().workflows[0]).toMatchObject({state:"paused",pauseReason:"adapter-outdated"});
 await new Promise(resolve => setTimeout(resolve, 1100));
 expect(writes.mock.calls.filter(args => String(args[0]) === "workflow.renew\n")).toHaveLength(0);
 expect(notify).toHaveBeenCalledTimes(1);
});
it("revokes and persists snapshot disconnect A before awaiting reconnect inspection B", async () => {
 const h = await fixture();
 const snapshot = h.options.snapshot;
 const targetB = { paneId: "pane-b", sessionId: "s2" };
 let disconnectedA = false;
 h.options.snapshot = async () => {
  const page = await snapshot();
  return { ...page, sessions: [
   ...page.sessions.map(session => ({ ...session, connected: !disconnectedA })),
   { ...targetB, label: "B", state: "working", connected: true, activityInstanceId: "adapter-b",
    capabilities: { inspect: true, approvals: true, activityFence: 1, enrollmentProtocol: 1 } },
  ] };
 };
 await h.coordinator.dispatch({ action: "start", mode: "session", objective: "Run tests in B",
  authorization: "Aprueba todos los permisos de esta sesión", sessions: [targetB] }, "agent");
 h.coordinator.onEvent({ id: "offline-b", type: "disconnected", at: new Date().toISOString(), ...targetB });
 const waiting = h.tool("snapshot-old-grant");
 const question = (await h.call("snapshot")).question as { id: string };
 await h.coordinator.poll(false);
 const registryEntered = deferred<void>();
 const unblockRegistry = deferred<Awaited<ReturnType<typeof registry.readManifests>>>();
 vi.spyOn(registry, "readManifests").mockImplementationOnce(async () => {
  registryEntered.resolve();
  return unblockRegistry.promise;
 });
 const syncing = h.coordinator.poll(false);
 await registryEntered.promise;
 const entered = deferred<void>();
 const unblock = deferred<unknown>();
 h.options.inspect = async paneId => {
  expect(paneId).toBe(targetB.paneId);
  entered.resolve();
  return unblock.promise;
 };
 disconnectedA = true;
 const preparing = h.coordinator.prepare();
 try {
  await entered.promise;
  // Both B's inspection and enrollment registry I/O remain blocked: A must be revoked.
  await expect(h.call("answer", { questionId: question.id, confirmed: true, expectedHumanActivityAt: null })).rejects.toMatchObject({ code: "HUMAN_REQUIRED" });
  const stored = JSON.parse(await readFile(join(h.options.dataDir, "workflows.json"), "utf8"));
  expect(stored.workflows[0]).toMatchObject({ state: "paused", pauseReason: "disconnected" });
  expect(stored.workflows[0].observed[JSON.stringify(["pane-a", "s1"])]).toMatchObject({ connected: false });
 } finally {
  unblockRegistry.resolve([]);
  unblock.resolve({ sessionId: targetB.sessionId, status: "idle" });
  await preparing;
  await syncing;
  if ((await h.call("snapshot")).question) await h.call("answer", { questionId: question.id, confirmed: false });
  await waiting;
 }
});
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
