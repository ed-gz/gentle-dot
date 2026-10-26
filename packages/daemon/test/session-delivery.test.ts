import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { createDotSession } from "../src/extensions/dot-session.ts";
import { SessionDeliveries } from "../src/orchestration/delivery.ts";
import { localRequest } from "../src/orchestration/herdr.ts";

it("does not confuse acceptance, a queued instruction, an assistant echo, or actual user consumption", () => {
	const ledger = new SessionDeliveries();
	const prepare = () =>
		ledger.prepare("message-123", ["exact instruction", "steer"], "exact instruction", "steer", false);
	expect(prepare()).toMatchObject({ duplicate: false, receipt: { status: "queued" } });
	expect(prepare()).toMatchObject({ duplicate: true, receipt: { status: "queued" } });
	expect(() => ledger.prepare("message-123", ["different"], "different", "steer", true)).toThrow("cambió");
	ledger.consume({ role: "assistant", content: [{ type: "text", text: "exact instruction" }] });
	ledger.consume({ role: "user", content: "different instruction" });
	expect(ledger.snapshot()[0]?.status).toBe("queued");
	ledger.consume({ role: "user", content: [{ type: "text", text: "exact instruction" }] });
	expect(prepare()).toMatchObject({
		duplicate: true,
		receipt: { status: "delivered", deliveredAt: expect.any(String) },
	});
	ledger.clear();
	expect(ledger.snapshot()).toEqual([]);
});

it("exposes missing consumption confirmation without calling it delivered or retrying it", () => {
	const ledger = new SessionDeliveries();
	const { receipt } = ledger.prepare("message-idle", ["hello"], "hello", "steer", true);
	expect(ledger.snapshot(true, false, Date.parse(receipt.acceptedAt) + 30_001)[0]?.status).toBe(
		"unconfirmed",
	);
	ledger.consume({ role: "user", content: "hello" });
	expect(ledger.snapshot()[0]?.status).toBe("delivered");
});

it("carries stable delivery IDs through the native socket, steers once, and confirms only on message_start", async () => {
	const directory = await mkdtemp(join(tmpdir(), "dot-delivery-"));
	const handlers = new Map<string, (event: unknown, context: ExtensionContext) => void | Promise<void>>();
	const sendUserMessage = vi.fn();
	const branch: unknown[] = [];
	const pi = {
		on: (name: string, callback: (event: unknown, context: ExtensionContext) => void) =>
			handlers.set(name, callback),
		sendUserMessage,
	} as unknown as ExtensionAPI;
	const context = {
		mode: "tui",
		cwd: directory,
		isIdle: () => false,
		ui: {
			notify: vi.fn(),
			confirm: vi.fn(),
			select: vi.fn(),
			input: vi.fn(),
			editor: vi.fn(),
			custom: vi.fn(),
		},
		sessionManager: { getSessionId: () => "session1", getSessionFile: () => undefined, getBranch: () => branch },
	} as unknown as ExtensionContext;
	const adapter = createDotSession(pi, { GENTLE_DOT_SESSION_DIR: directory });
	try {
		await handlers.get("session_start")?.({}, context);
		const name = (await readdir(directory)).find((name) => name.endsWith(".json"));
		const manifest = JSON.parse(await readFile(join(directory, name!), "utf8"));
		const request = (method: string, params = {}) =>
			localRequest(manifest.socketPath, method, {
				expectedSessionId: "session1",
				expectedInstanceId: manifest.instanceId,
				...params,
			});
		const input = { text: "prioriza la revisión", clientMessageId: "delivery-123", deliverAs: "steer" };
		await request("prompt", input);
		await request("prompt", input); // A lost HTTP response must not duplicate a human turn.
		expect(sendUserMessage).toHaveBeenCalledExactlyOnceWith(input.text, {
			deliverAs: "steer",
			expandPromptTemplates: false,
		});
		expect(await request("snapshot")).toMatchObject({
			capabilities: { deliveryReceipts: true, deliveryModes: ["steer", "followUp"] },
			deliveries: [{ id: input.clientMessageId, status: "queued" }],
		});
		await handlers.get("message_start")?.(
			{ message: { role: "user", content: [{ type: "text", text: input.text }] } },
			context,
		);
		expect(await request("snapshot")).toMatchObject({ deliveries: [{ status: "delivered" }] });
		await expect(request("prompt", { ...input, text: "replacement" })).rejects.toMatchObject({
			code: "DELIVERY_CHANGED",
		});
		await expect(request("prompt", { ...input, deliverAs: "unknown" })).rejects.toMatchObject({
			code: "INVALID_DELIVERY",
		});
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		// A client can reconnect after message_start was missed. Snapshot must recover
		// consumption from the real branch, not leave a receipt permanently unconfirmed.
		await request("prompt", {text:"Dos bugs\n\n<attachments>\n{\"name\":\"one.png\"}\n</attachments>", clientMessageId:"delivery-history"});
		branch.push({type:"message", id:"history-user", timestamp:new Date().toISOString(), message:{role:"user", content:[{type:"text", text:"Dos bugs\n\n<attachments>\n{\"name\":\"one.png\"}\n</attachments>"}]}});
		expect((await request("snapshot")).deliveries).toEqual(expect.arrayContaining([expect.objectContaining({id:"delivery-history",status:"delivered"})]));
		await request("prompt", {text:"Dos bugs\n\n<attachments>\n{\"name\":\"one.png\"}\n</attachments>", clientMessageId:"delivery-repeat"});
		for (let poll = 0; poll < 2; poll++) {
			expect((await request("snapshot")).deliveries).toEqual(expect.arrayContaining([expect.objectContaining({id:"delivery-repeat",status:"queued"})]));
		}
		// Autonomy must yield even when the next daemon poll has not observed this keystroke yet.
		await handlers.get("input")?.({source:"interactive",text:"personal"},context);
		const personal = await request("snapshot");
		expect(personal.companionActivity).toHaveProperty("humanActivityAt");
		await expect(request("prompt",{text:"watch continuation",expectedHumanActivityAt:null})).rejects.toMatchObject({code:"HUMAN_ACTIVE"});
		expect(sendUserMessage).toHaveBeenCalledTimes(3);
		await handlers.get("input")?.({source:"extension",text:"watch continuation"},context);
		expect((await request("snapshot")).companionActivity).toMatchObject({humanActivityAt:(personal.companionActivity as {humanActivityAt:string}).humanActivityAt});
	} finally {
		await adapter.close();
		await rm(directory, { recursive: true, force: true });
	}
});
