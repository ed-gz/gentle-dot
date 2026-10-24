import { afterEach, expect, it } from "vitest";
import { computerApproval, computerSnapshot } from "../src/computer-access.ts";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { fakeApp } from "./fake-app.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const requestId = "a".repeat(64);
const status = {
	available: true,
	platform: "linux",
	permissions: { accessibility: true, screenRecording: true, screenshotsSupported: true },
	state: { active: true, yolo: false, endsAt: 1_900_000_000_000 },
	capabilities: { backend: "hyprland", supported: true, missingDependencies: [], limitations: [] },
};
let daemon: DotDaemon | undefined;
afterEach(async () => {
	await daemon?.close();
	daemon = undefined;
});
async function setup() {
	const dir = tempDir();
	const app = fakeApp([], "allow");
	daemon = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir: dir,
		workspace: dir,
		uiDir: dir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		appChannel: app.daemonEnd,
		approvalWaitMs: 2000,
	});
	const local = daemon;
	const request = (key: string, body?: object, path = "/api/mobile/computer") =>
		fetch(`http://127.0.0.1:${local.port}${path}`, {
			method: body ? "POST" : "GET",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	const pair = async () => {
		const { code } = await (await request(local.token, {}, "/api/mobile/code")).json();
		return (await request("", { code, deviceName: "Computer test phone" }, "/api/mobile/pair")).json();
	};
	return { app, daemon: local, request, pair };
}

it("builds only the native computer approval kinds and rejects model supplied extra fields", () => {
	expect(computerApproval({ requestId, kind: "grant", message: "Control the desktop" }).connector).toBe(
		"Equipo",
	);
	for (const value of [
		null,
		[],
		{ requestId, kind: "yolo", message: "yes" },
		{ requestId, kind: "grant", message: "" },
		{ requestId, kind: "grant", message: "a", approved: true },
	])
		expect(() => computerApproval(value)).toThrow();
});

it("mobile status removes private credentials even if a native implementation adds them", () => {
	const result = computerSnapshot({
		...status,
		token: "private",
		url: "http://127.0.0.1:999/mcp",
		state: { ...status.state, token: "also-private" },
	});
	expect(result).toEqual(status);
	expect(JSON.stringify(result)).not.toContain("private");
});

it("exposes read status and stop only, with no route for granting control", async () => {
	const { app, daemon, request, pair } = await setup();
	app.nativeHandlers.set("computer_status", () => ({ ...status, token: "never exposed" }));
	let stops = 0;
	app.nativeHandlers.set("computer_stop", () => {
		stops++;
		return { ...status, state: { active: false, yolo: false } };
	});
	expect((await request("bad")).status).toBe(401);
	const device = await pair();
	expect(await (await request(device.token)).json()).toEqual(status);
	for (const body of [{ action: "grant" }, { action: "stop", yolo: true }])
		expect((await request(device.token, body)).status).toBe(400);
	expect(stops).toBe(0);
	expect((await (await request(device.token, { action: "stop" })).json()).state.active).toBe(false);
	expect(stops).toBe(1);
	expect((await request(daemon.token, { action: "stop" })).status).toBe(200);
});

it("revocation during a status request prevents delivery and later control", async () => {
	const { app, daemon, request, pair } = await setup();
	const device = await pair();
	let resolve!: (value: object) => void;
	app.nativeHandlers.set(
		"computer_status",
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	const pending = request(device.token);
	await waitFor(() => resolve);
	await request(daemon.token, { deviceId: device.deviceId }, "/api/mobile/revoke");
	resolve(status);
	expect((await pending).status).toBe(401);
	expect((await request(device.token, { action: "stop" })).status).toBe(401);
});

it("routes native computer prompts through the shared mobile broker with one exact decision", async () => {
	const { app, request, pair } = await setup();
	const device = await pair();
	app.answer("hold");
	const pending = app.request("computer_approval", {
		requestId,
		kind: "action",
		message: "Submit the current form?",
	});
	await waitFor(() => app.asked.length === 2);
	const { approvals } = await (await request(device.token, undefined, "/api/mobile/approvals")).json();
	expect(approvals).toHaveLength(1);
	expect(approvals[0].message).toContain("Submit the current form?");
	expect(
		(await request(device.token, { requestId: approvals[0].id, approved: true }, "/api/mobile/answer"))
			.status,
	).toBe(200);
	expect(await pending).toEqual({ approved: true });
	await waitFor(() => app.cancelledApprovals.length === 1);
	await expect(
		app.request("computer_approval", { requestId, kind: "yolo", message: "any action" }),
	).rejects.toThrow("Invalid computer approval");
});

it("Stop cancels a pending native approval instead of leaving a stale card on the phone", async () => {
	const { app, request, pair } = await setup();
	const device = await pair();
	app.nativeHandlers.set("computer_stop", () => ({ ...status, state: { active: false, yolo: false } }));
	for (const origin of ["native", "mobile"]) {
		app.answer("hold");
		const count = app.asked.length;
		const pending = app.request("computer_approval", {
			requestId,
			kind: "grant",
			message: "Control the desktop?",
		});
		await waitFor(() => app.asked.length > count);
		const { approvals } = await (await request(device.token, undefined, "/api/mobile/approvals")).json();
		expect(approvals).toHaveLength(1);
		if (origin === "native") await app.request("computer_approval_cancel", { requestId });
		else expect((await request(device.token, { action: "stop" })).status).toBe(200);
		expect(await pending).toEqual({ approved: false });
		expect(
			(await request(device.token, { requestId: approvals[0].id, approved: true }, "/api/mobile/answer"))
				.status,
		).toBe(409);
	}
});

it("cancels only the exact native request and leaves the next approval intact", async () => {
	const { app, request, pair } = await setup();
	const device = await pair();
	const otherId = "b".repeat(64);
	app.answer("hold", "hold");
	const first = app.request("computer_approval", { requestId, kind: "grant", message: "First" });
	const second = app.request("computer_approval", { requestId: otherId, kind: "action", message: "Second" });
	await waitFor(() => app.asked.length === 3);
	await app.request("computer_approval_cancel", { requestId });
	expect(await first).toEqual({ approved: false });
	const { approvals } = await (await request(device.token, undefined, "/api/mobile/approvals")).json();
	expect(approvals).toHaveLength(1);
	expect(approvals[0].message).toContain("Second");
	await request(device.token, { requestId: approvals[0].id, approved: true }, "/api/mobile/answer");
	expect(await second).toEqual({ approved: true });
});
