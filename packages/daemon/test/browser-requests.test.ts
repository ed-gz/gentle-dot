import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserController } from "../src/browser.ts";
import { BrowserRequests } from "../src/browser-requests.ts";
import { SharedFileStore } from "../src/shared-files.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(approved = true) {
	const dir = mkdtempSync(join(tmpdir(), "dot-browser-requests-"));
	dirs.push(dir);
	const action = vi.fn(async (_input: Record<string, unknown>, _actor: string, valid: () => boolean) => {
		if (!valid()) throw new Error("revoked");
		return { active: true };
	});
	const ask = vi.fn(async () => approved);
	const install = vi.fn(async (requestId: string) => ({ requestId, status: "succeeded" }));
	const cancelInstall = vi.fn(async () => ({ status: "cancelled" }));
	const files = new SharedFileStore(dir);
	const broker = new BrowserRequests({
		browser: { action, status: () => ({ active: false }) } as unknown as BrowserController,
		files,
		ask,
		install,
		cancelInstall,
	});
	return { broker, action, ask, install, cancelInstall, files };
}

it("requires an actual human decision and never trusts an approved field from the model", async () => {
	const { broker, action } = fixture(false);
	await expect(
		broker.action({ action: "request_access", reason: "Revisar la página", approved: true }, "agent"),
	).rejects.toMatchObject({ code: "DECLINED" });
	expect(action).not.toHaveBeenCalled();
});

it("grants without an invented expiry and only after the human answers", async () => {
	const { broker, action, ask } = fixture();
	await broker.action({ action: "request_access", reason: "Revisar la página" }, "agent");
	expect(ask).toHaveBeenCalledOnce();
	expect(action).toHaveBeenCalledWith({ action: "start", window: false }, "human", expect.any(Function));
});

it("rechecks cancellation after approval and rejects duplicate pending requests", async () => {
	const { broker, ask, action } = fixture();
	let answer!: (approved: boolean) => void;
	ask.mockImplementation(
		() =>
			new Promise((resolve) => {
				answer = resolve;
			}),
	);
	const signal = new AbortController();
	const first = broker.action(
		{ action: "request_access", reason: "Revisar" },
		"agent",
		() => true,
		signal.signal,
	);
	const refused = expect(first).rejects.toMatchObject({ code: "DECLINED" });
	await expect(broker.action({ action: "request_access", reason: "Otra" }, "agent")).rejects.toMatchObject({
		code: "REQUEST_PENDING",
	});
	signal.abort();
	answer(true);
	await refused;
	expect(action).not.toHaveBeenCalled();
});

it("passes only an opaque request id to the fixed native installer after approval", async () => {
	const { broker, install, ask } = fixture();
	const result = await broker.action(
		{ action: "install_browser", reason: "Usar navegador", password: "untrusted", command: "untrusted" },
		"agent",
	);
	expect(ask).toHaveBeenCalledOnce();
	expect(install).toHaveBeenCalledWith(expect.stringMatching(/^[\da-f-]{36}$/));
	expect(result).toMatchObject({ status: "succeeded" });
});

it("revoking the browser cancels a pending grant instead of reopening it on a late answer", async () => {
	const { broker, ask, action } = fixture();
	let answer!: (approved: boolean) => void;
	ask.mockImplementation(
		() =>
			new Promise((resolve) => {
				answer = resolve;
			}),
	);
	const request = broker.action({ action: "request_access", reason: "Revisar" }, "agent");
	const rejected = expect(request).rejects.toMatchObject({ code: "DECLINED" });
	await broker.action({ action: "stop" }, "human");
	answer(true);
	await rejected;
	expect(action.mock.calls.some(([input]) => input.action === "start")).toBe(false);
});

it("fails closed when installation has no desktop channel", async () => {
	const { files } = fixture();
	const broker = new BrowserRequests({ browser: {} as BrowserController, files, ask: vi.fn() });
	await expect(
		broker.action({ action: "install_browser", reason: "Usar navegador" }, "agent"),
	).rejects.toMatchObject({ code: "APP_REQUIRED" });
});

it("retains the real installation result after the HTTP caller disconnects", async () => {
	const { broker, install, cancelInstall } = fixture();
	let finish!: (result: { requestId: string; status: string }) => void;
	install.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const controller = new AbortController();
	const pending = broker.action(
		{ action: "install_browser", reason: "Usar navegador" },
		"human",
		() => true,
		controller.signal,
	);
	expect(broker.status()).toMatchObject({ canRequestInstall: true, installation: { status: "pending" } });
	const requestId = broker.status().installation?.requestId as string;
	controller.abort();
	expect(cancelInstall).toHaveBeenCalledExactlyOnceWith(requestId);
	// Cancellation cannot kill an already started package manager; its actual result still matters.
	finish({ requestId, status: "succeeded" });
	expect(await pending).toMatchObject({ status: "succeeded" });
	expect(broker.status().installation).toMatchObject({ requestId, status: "succeeded" });
});

it("reports an unknown native outcome without leaking its exception or claiming cancellation", async () => {
	const { broker, install, cancelInstall } = fixture();
	install.mockRejectedValue(new Error("private authentication detail"));
	const result = await broker.action({ action: "install_browser", reason: "Usar navegador" }, "human");
	expect(result).toMatchObject({ status: "unknown" });
	expect(JSON.stringify(result)).not.toContain("private authentication detail");
	expect(cancelInstall).toHaveBeenCalledOnce();
});

it("rejects inherited property names as native statuses and masks stale desktop availability", async () => {
	const { broker, install, files } = fixture();
	install.mockImplementation(async (requestId) => ({ requestId, status: "constructor" }));
	expect(await broker.action({ action: "install_browser", reason: "Usar navegador" }, "human")).toMatchObject(
		{ status: "unknown" },
	);
	const unavailable = new BrowserRequests({
		browser: { status: () => ({ available: false }) } as BrowserController,
		files,
		ask: vi.fn(),
		install,
		installAvailable: () => false,
	});
	expect(unavailable.status().canRequestInstall).toBe(false);
	await expect(
		unavailable.action({ action: "install_browser", reason: "Usar navegador" }, "human"),
	).rejects.toMatchObject({ code: "APP_REQUIRED" });
});
