import { afterEach, expect, it, vi } from "vitest";
import { createOrchestrationClient } from "../src/orchestration.ts";
import { createTerminalMoodClient, parseTerminalMood, TerminalMoodError, type TerminalMoodState } from "../src/terminal-mood.ts";

const state: TerminalMoodState = { available: true, paneId: "pi:one", scope: "window", mood: null,
	canRestore: false, windowId: 7, affectedPaneIds: ["pi:one"], sharedWindow: false, requiresSharedConfirmation: false };
const connection = { url: "wss://fixture.invalid/ws", token: "device-key" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("loads the exact pane with header authentication and exposes the client through orchestration", async () => {
	const fetcher = vi.fn(async () => response(state)); vi.stubGlobal("fetch", fetcher);
	const client = createOrchestrationClient(connection).terminalMood!;
	expect(await client.status("pi:one")).toEqual(state);
	expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://fixture.invalid/api/mobile/terminal-mood?paneId=pi%3Aone", expect.objectContaining({
		method: "GET", headers: { Authorization: "Bearer device-key" }, credentials: "omit", redirect: "error", cache: "no-store",
	}));
});

it("forwards the explicit shared-window grant only for its one mutation", async () => {
	const fetcher = vi.fn<typeof fetch>(async () => response({ ...state, mood: "afterlife", verified: true })); vi.stubGlobal("fetch", fetcher);
	const client = createTerminalMoodClient(connection);
	await client.apply("pi:one", "afterlife", true);
	await client.apply("pi:one", "afterlife");
	expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ paneId: "pi:one", mood: "afterlife", allowSharedWindow: true }) });
	expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ body: JSON.stringify({ paneId: "pi:one", mood: "afterlife" }) });
});

it.each([{}, { verified: false }, { verified: true, mood: "sunset" }, { verified: true, available: false }])("rejects an unconfirmed or mismatched mutation: %j", async extras => {
	vi.stubGlobal("fetch", vi.fn(async () => response({ ...state, mood: "hacker", ...extras })));
	await expect(createTerminalMoodClient(connection).apply("pi:one", "hacker")).rejects.toThrow(/no confirmó/);
});

it("treats a legacy GET 404 as unavailable and never retries a POST conflict", async () => {
	const fetcher = vi.fn().mockResolvedValueOnce(response({}, 404)).mockResolvedValueOnce(response({ error: "Revisa los paneles compartidos" }, 409));
	vi.stubGlobal("fetch", fetcher);
	const client = createTerminalMoodClient(connection);
	expect(await client.status("pi:one")).toMatchObject({ available: false, reason: expect.stringMatching(/Actualiza Gentle Dot/) });
	await expect(client.apply("pi:one", "hacker")).rejects.toMatchObject({ status: 409, message: "Revisa los paneles compartidos" });
	expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([400, 401, 404])("retains HTTP %s as a mutation error", async status => {
	vi.stubGlobal("fetch", vi.fn(async () => response({}, status)));
	await expect(createTerminalMoodClient(connection).apply("pi:one", "restore")).rejects.toBeInstanceOf(TerminalMoodError);
});

it("refuses state for another pane and malformed window scopes", () => {
	expect(() => parseTerminalMood({ ...state, paneId: "pi:other" }, "pi:one")).toThrow(/no válido/);
	expect(() => parseTerminalMood({ ...state, scope: "global" }, "pi:one")).toThrow(/no válido/);
	expect(() => parseTerminalMood({ ...state, affectedPaneIds: [2] }, "pi:one")).toThrow(/no válido/);
	for (const windowId of ["7", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
		expect(() => parseTerminalMood({ ...state, windowId }, "pi:one")).toThrow(/no válido/);
});
