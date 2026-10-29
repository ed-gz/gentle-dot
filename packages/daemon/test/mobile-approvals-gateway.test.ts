import { once } from "node:events";
import { PROTOCOL_VERSION, type ServerPayload } from "@gentle-dot/protocol";
import { afterEach, expect, it } from "vitest";
import WebSocket from "ws";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { fakeApp } from "./fake-app.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

let daemon: DotDaemon | undefined;
afterEach(async () => {
	await daemon?.close();
	daemon = undefined;
});

it("requires native trust at pairing and accepts only the trusted device's exact pending answer", async () => {
	const dir = tempDir();
	const app = fakeApp([], "hold");
	daemon = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir: dir,
		workspace: dir,
		uiDir: dir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		appChannel: app.daemonEnd,
		approvalWaitMs: 5000,
	});
	const base = `http://127.0.0.1:${daemon.port}`;
	const request = (path: string, key: string, body?: object) =>
		fetch(base + path, {
			method: body ? "POST" : "GET",
			headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	const code = (await (await request("/api/mobile/code", daemon.token, {})).json()).code;
	const bad = await request("/api/mobile/pair", "", { code: "bad", deviceName: "Phone" });
	expect(bad.status).toBe(410);
	expect(app.asked).toHaveLength(0);
	const rejected = request("/api/mobile/pair", "", { code, deviceName: "Phone" });
	await waitFor(() => app.asked.length === 1);
	app.release(false);
	expect((await rejected).status).toBe(403);
	const pairing = request("/api/mobile/pair", "", { code, deviceName: "Phone" });
	await waitFor(() => app.asked.length === 2);
	expect((await request("/api/mobile/pair", "", { code, deviceName: "Duplicate" })).status).toBe(409);
	app.release(true);
	const paired = await pairing;
	expect(paired.status).toBe(200);
	const device = (await paired.json()) as { token: string; deviceId: string };
	expect((await request("/api/mobile/approvals", daemon.token)).status).toBe(403);
	const phone = new WebSocket(`${base.replace("http", "ws")}/ws`);
	await once(phone, "open");
	const welcome = once(phone, "message");
	phone.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, token: device.token }));
	await welcome;
	const allowed = daemon.bridge.askInApp({
		connector: "GitHub",
		action: "merge",
		preview: [{ name: "PR", value: "repo#1" }],
	});
	expect(app.asked).toHaveLength(2); // Mobile delivery does not leave an unanswered native dialog.
	const pending = (await (await request("/api/mobile/approvals", device.token)).json()) as {
		approvals: { id: string; title: string; message: string; expiresAt: string; revision: string }[];
	};
	expect(pending.approvals).toHaveLength(1);
	const approval = pending.approvals[0];
	if (!approval) throw new Error("Missing mobile approval");
	expect(approval.message).toContain("repo#1");
	expect((await request("/api/mobile/answer-v1", daemon.token, {requestId:approval.id,approved:true,review:approval})).status).toBe(403);
	expect((await request("/api/mobile/answer-v1", device.token, {requestId:approval.id,approved:true})).status).toBe(400);
	expect((await request("/api/mobile/answer-v1", device.token, {requestId:approval.id,approved:true,review:approval})).status).toBe(403);
	expect((await request("/api/mobile/answer-v1", device.token, {requestId:approval.id,approved:false,review:{...approval,message:"changed"}})).status).toBe(409);
	expect((await request("/api/mobile/answer-v1", device.token, {requestId:approval.id,approved:false,review:{...approval,revision:"wrong"}})).status).toBe(409);
	expect((await (await request("/api/mobile/approvals", device.token)).json()).approvals).toHaveLength(1);
	expect(
		(await request("/api/mobile/answer", daemon.token, { requestId: approval.id, approved: true })).status,
	).toBe(403);
	expect(
		(await request("/api/mobile/answer-v1", device.token, { requestId: approval.id, approved: false, review: approval })).status,
	).toBe(200);
	expect(await allowed).toBe(false);
	expect(
		(await request("/api/mobile/answer", device.token, { requestId: approval.id, approved: true })).status,
	).toBe(409);
	// A connected phone must not force the desktop user to switch devices. The same request is
	// answered over the native private channel; the phone's later answer cannot reverse it.
	const desktopMessages: ServerPayload[] = [];
	const detachDesktop = daemon.bridge.attach({ send: (message) => desktopMessages.push(message) });
	const desktopReady = desktopMessages.find((message) => message.type === "ready");
	if (desktopReady?.type !== "ready" || !desktopReady.clientId) throw new Error("Missing desktop window");
	for (const approved of [true, false]) {
		const desktopAnswer = daemon.bridge.askInApp({ connector: "Fixture", action: "share", preview: [] });
		const card = desktopMessages.findLast((message) => message.type === "ask");
		if (card?.type !== "ask") throw new Error("Missing desktop card");
		await app.command(desktopReady.clientId, {
			type: "app_approval_reply",
			requestId: card.ask.requestId,
			approved,
		});
		expect(await desktopAnswer).toBe(approved);
		expect(
			(
				await request("/api/mobile/answer", device.token, {
					requestId: card.ask.requestId,
					approved: !approved,
				})
			).status,
		).toBe(409);
		expect(desktopMessages).toContainEqual({ type: "ask_resolved", requestId: card.ask.requestId });
	}
	detachDesktop();

	const controller = new AbortController();
	const cancelled = daemon.bridge.askInApp(
		{ connector: "GitHub", action: "push", preview: [] },
		controller.signal,
	);
	expect(app.asked).toHaveLength(2);
	controller.abort();
	expect(await cancelled).toBe(false);
	expect(await (await request("/api/mobile/approvals", device.token)).json()).toEqual({ approvals: [] });
	const disconnected = daemon.bridge.askInApp({ connector: "GitHub", action: "merge", preview: [] });
	phone.close();
	await once(phone, "close");
	const afterReconnect = await (await request("/api/mobile/approvals", device.token)).json();
	expect(afterReconnect.approvals).toHaveLength(1);
	await request("/api/mobile/answer", device.token, {
		requestId: afterReconnect.approvals[0].id,
		approved: true,
	});
	expect(await disconnected).toBe(true);
	const native = daemon.bridge.askInApp({ connector: "GitHub", action: "merge", preview: [] });
	await waitFor(() => app.asked.length === 3);
	const latePhone = await (await request("/api/mobile/approvals", device.token)).json();
	expect(latePhone.approvals).toHaveLength(1);
	await request("/api/mobile/answer", device.token, { requestId: latePhone.approvals[0].id, approved: true });
	expect(await native).toBe(true);
	await waitFor(() => app.cancelledApprovals.length === 1);
	app.release(false); // A later native response cannot reverse the phone decision.
	await request("/api/mobile/revoke", daemon.token, { deviceId: device.deviceId });
	expect((await request("/api/mobile/approvals", device.token)).status).toBe(401);
});
