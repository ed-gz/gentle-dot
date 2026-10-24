import type { Ask, ServerPayload } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AppChannel } from "../src/app-channel.ts";
import { DotBridge } from "../src/bridge.ts";
import { MobileApprovals } from "../src/mobile-approvals.ts";
import { fakeApp } from "./fake-app.ts";
import { fakeSupervisor, waitFor } from "./helpers.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setup(options: { mobile?: boolean; online?: boolean; now?: () => number } = {}) {
	const app = fakeApp([], "hold");
	const channel = new AppChannel(app.daemonEnd);
	const mobile = new MobileApprovals({ waitMs: 2000, ...(options.now ? { now: options.now } : {}) });
	const { supervisor, dataDir } = fakeSupervisor();
	const bridge = new DotBridge(supervisor, {
		dataDir,
		app: channel,
		approvalWaitMs: 2000,
		...(options.mobile === false ? {} : { mobileApprovals: mobile }),
		hasApprovalClient: () => options.online === true,
	});
	channel.handler = async (method, params) => {
		if (method !== "command") throw new Error("Unexpected fixture command");
		const value = params as { clientId: string; message: unknown };
		await bridge.handleFromApp(value.clientId, value.message);
		return {};
	};
	const received: ServerPayload[] = [];
	const client = { send: (value: ServerPayload) => received.push(value) };
	const detach = bridge.attach(client);
	const ready = received.find((value) => value.type === "ready");
	if (ready?.type !== "ready" || !ready.clientId) throw new Error("Missing fixture window");
	const clientId = ready.clientId;
	const ask = (): Ask => {
		const result = received.findLast((value) => value.type === "ask");
		if (result?.type !== "ask") throw new Error("Missing fixture approval");
		return result.ask;
	};
	const answer = (id: string, approved: boolean) =>
		app.command(clientId, { type: "app_approval_reply", requestId: id, approved });
	cleanups.push(async () => {
		mobile.close();
		channel.close();
		await supervisor.stop();
	});
	return { app, channel, mobile, supervisor, bridge, received, client, clientId, detach, ask, answer };
}

const request = {
	connector: "Programa de prueba",
	action: "enviar reporte",
	summary: "Comparte únicamente el reporte revisado.",
	preview: [{ name: "Destino", value: { project: "fixture", report: "informe completo" } }],
};

describe("desktop chat approval over the native channel", () => {
	it.each([true, false])(
		"answers %s from the desktop while the phone is online, exactly once",
		async (approved) => {
			const h = setup({ online: true });
			const pending = h.bridge.askInApp(request);
			const ask = h.ask();
			expect(h.app.asked).toEqual([]);
			expect(ask.message).toContain(request.summary);
			expect(ask.message).toContain('"report": "informe completo"');
			expect(ask.expiresAt).toBe(h.mobile.list()[0]?.expiresAt);
			expect(ask.message).toBe(h.mobile.list()[0]?.message);
			const reconnected: ServerPayload[] = [];
			h.bridge.attach({ send: (value) => reconnected.push(value) });
			expect(reconnected).toContainEqual({ type: "ask", ask });
			await expect(h.answer(ask.requestId, approved)).resolves.toEqual({});
			expect(await pending).toBe(approved);
			expect(h.mobile.answer(ask.requestId, !approved)).toBe(false);
			await expect(h.answer(ask.requestId, !approved)).rejects.toThrow(/respondido/);
			for (const messages of [h.received, reconnected])
				expect(messages.filter((value) => value.type === "ask_resolved")).toEqual([
					{ type: "ask_resolved", requestId: ask.requestId },
				]);
		},
	);

	it.each([true, false])("a phone answer %s rejects a conflicting desktop answer", async (approved) => {
		const h = setup({ online: true });
		const pending = h.bridge.askInApp(request);
		const id = h.ask().requestId;
		expect(h.mobile.answer(id, approved)).toBe(true);
		await expect(h.answer(id, !approved)).rejects.toThrow(/respondido/);
		expect(await pending).toBe(approved);
	});

	it("the desktop card cancels only its native dialog, including without a mobile broker", async () => {
		const h = setup({ mobile: false });
		const first = h.bridge.askInApp(request);
		const firstId = h.ask().requestId;
		const second = h.bridge.askInApp({ ...request, action: "otra acción" });
		const secondId = h.ask().requestId;
		await waitFor(() => h.app.asked.length === 2);
		await h.answer(firstId, false);
		expect(await first).toBe(false);
		await waitFor(() => h.app.cancelledApprovals.length === 1);
		h.app.release(true); // Only the other dialog remains; its native answer wins.
		expect(await second).toBe(true);
		await expect(h.answer(secondId, false)).rejects.toThrow(/respondido/);
		await expect(h.answer(firstId, true)).rejects.toThrow(/respondido/);
		expect(h.app.cancelledApprovals).toHaveLength(1);
	});

	it("cancellation and the absolute deadline reject late desktop answers before the timer fires", async () => {
		let now = 1000;
		const h = setup({ online: true, now: () => now });
		const abort = new AbortController();
		const cancelled = h.bridge.askInApp(request, abort.signal);
		const cancelledId = h.ask().requestId;
		abort.abort();
		await expect(h.answer(cancelledId, true)).rejects.toThrow(/respondido/);
		expect(await cancelled).toBe(false);
		const count = h.received.length;
		expect(await h.bridge.askInApp(request, abort.signal)).toBe(false);
		expect(h.received).toHaveLength(count);
		const expired = h.bridge.askInApp(request);
		const expiredId = h.ask().requestId;
		now += 2000;
		await expect(h.answer(expiredId, true)).rejects.toThrow(/venció/);
		expect(await expired).toBe(false);
		expect(h.mobile.list()).toEqual([]);
	});

	it("neither the shared WebSocket key nor malformed native messages can answer an app approval", async () => {
		const h = setup({ online: true });
		const pending = h.bridge.askInApp(request);
		const requestId = h.ask().requestId;
		await h.bridge.handle(h.client, { type: "app_approval_reply", requestId, approved: true });
		await h.bridge.handle(h.client, { type: "ui_response", requestId, confirmed: true });
		await h.bridge.handle(h.client, { type: "ui_response", requestId, confirmed: false });
		expect(h.received.filter((value) => value.type === "error")).toHaveLength(3);
		expect(h.mobile.list()).toHaveLength(1);
		for (const approved of ["true", 1, null, undefined])
			await expect(
				h.app.command(h.clientId, { type: "app_approval_reply", requestId, approved }),
			).rejects.toThrow(/trusted/);
		await expect(
			h.app.command("missing-window", { type: "app_approval_reply", requestId, approved: true }),
		).rejects.toThrow(/window/);
		await expect(h.answer("app-missing", true)).rejects.toThrow(/respondido/);
		h.detach();
		await expect(h.answer(requestId, true)).rejects.toThrow(/window/);
		expect(h.mobile.answer(requestId, false)).toBe(true);
		expect(await pending).toBe(false);
	});

	it("stopping the run retires the desktop card and cancels the native dialog", async () => {
		const h = setup();
		await h.supervisor.start();
		const pending = h.bridge.askInApp(request);
		const id = h.ask().requestId;
		await waitFor(() => h.app.asked.length === 1);
		await h.bridge.handle(h.client, { type: "abort" });
		expect(await pending).toBe(false);
		await waitFor(() => h.app.cancelledApprovals.length === 1);
		await expect(h.answer(id, true)).rejects.toThrow(/respondido/);
	});

	it("a disconnected native app cannot grant even with an open card", async () => {
		const h = setup({ online: true });
		const pending = h.bridge.askInApp(request);
		const requestId = h.ask().requestId;
		h.channel.close();
		await expect(
			h.bridge.handleFromApp(h.clientId, { type: "app_approval_reply", requestId, approved: true }),
		).rejects.toThrow(/Open the Gentle Dot app/);
		h.mobile.cancelAll();
		expect(await pending).toBe(false);
	});
});
