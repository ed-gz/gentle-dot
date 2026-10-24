import type { Tool } from "@earendil-works/pi-mcp";
import { describe, expect, it, vi } from "vitest";
import { MailWatch, type MailWatchOptions } from "../src/mail-watch.ts";
import type { ProxiedConnector } from "../src/mcp-proxy.ts";
import type { WatchCursor } from "../src/watchers.ts";

const tools: Tool[] = [
	{
		name: "search_threads",
		annotations: { readOnlyHint: true },
		inputSchema: {
			type: "object",
			properties: {
				pageSize: { type: "integer" },
				pageToken: { type: "string" },
				query: { type: "string" },
				includeTrash: { type: "boolean" },
				view: { type: "string", enum: ["THREAD_VIEW_MINIMAL", "THREAD_VIEW_METADATA_ONLY"] },
			},
		},
	},
];
const start = Date.parse("2026-10-11T10:00:00Z");
const message = (id: string, overrides: Record<string, unknown> = {}) => ({
	id,
	subject: `Subject ${id}`,
	sender: "sender@example.test",
	snippet: "A short preview",
	date: "2026-10-11",
	labelIds: ["INBOX"],
	...overrides,
});
function setup() {
	let now = start;
	let view: ProxiedConnector | undefined = {
		id: "gmail",
		name: "Gmail",
		enabled: true,
		mode: "read_only",
		revision: "r1",
		readOnlyTools: ["search_threads"],
		server: { url: "https://gmailmcp.googleapis.com/mcp/v1" },
	};
	const state: { messages: Array<Record<string, unknown>>; next?: string } = { messages: [message("old")] };
	const readOnly = vi.fn<MailWatchOptions["proxy"]["readOnly"]>(
		async (_id: string, _tool: string, _args: Record<string, unknown>, _signal: AbortSignal) => ({
			structuredContent: {
				threads: [{ id: "thread", messages: state.messages }],
				...(state.next ? { nextPageToken: state.next } : {}),
			},
		}),
	);
	const readOnlyTools = vi.fn(async () => tools);
	const prepareRead = vi.fn(async () => {});
	const options = { proxy: { prepareRead, readOnly, readOnlyTools }, connector: () => view, now: () => now };
	const source = new MailWatch(options);
	const signal = new AbortController().signal;
	return {
		source,
		options,
		signal,
		state,
		readOnly,
		readOnlyTools,
		prepareRead,
		advance: (ms = 60_000) => {
			now += ms;
		},
		set: (change: Partial<ProxiedConnector> | undefined) => {
			view = change ? { ...(view as ProxiedConnector), ...change } : undefined;
		},
	};
}

describe("Gmail mail source", () => {
	it("prepares a cold existing connection only on a probe and compares persisted identity after unlocking", async () => {
		const h = setup();
		const baseline = await h.source.email("gmail", undefined, h.signal);
		h.set({ unavailable: "Secret cache cold", revision: "cold" });
		const calls = h.prepareRead.mock.calls.length;
		expect(h.source.available()).toMatchObject([{ configured: true, available: false }]);
		expect(h.prepareRead).toHaveBeenCalledTimes(calls);
		h.prepareRead.mockImplementationOnce(async () => {
			h.set({ unavailable: undefined, revision: "r1" });
		});
		expect((await h.source.email("gmail", baseline.cursor, h.signal)).events).toEqual([]);
		expect(h.prepareRead).toHaveBeenCalledTimes(calls + 1);
	});
	it("accepts omitted empty protobuf lists without accepting an explicit error or malformed list", async () => {
		const h = setup();
		h.readOnly.mockResolvedValueOnce({ structuredContent: {} });
		const baseline = await h.source.email("gmail", undefined, h.signal);
		expect(baseline.events).toEqual([]);
		h.state.messages = [message("unlabelled", { labelIds: undefined })];
		expect((await h.source.email("gmail", baseline.cursor, h.signal)).events).toMatchObject([
			{ id: "gmail:unlabelled" },
		]);
		h.readOnly.mockResolvedValueOnce({ isError: true, structuredContent: {} });
		await expect(h.source.email("gmail", baseline.cursor, h.signal)).rejects.toMatchObject({
			code: "MAIL_SOURCE",
		});
		h.readOnly.mockResolvedValueOnce({ structuredContent: { threads: "invalid" } });
		await expect(h.source.email("gmail", baseline.cursor, h.signal)).rejects.toMatchObject({
			code: "MAIL_FORMAT",
		});
		h.readOnly.mockResolvedValueOnce({ structuredContent: { error: "permission denied" } });
		await expect(h.source.email("gmail", baseline.cursor, h.signal)).rejects.toMatchObject({
			code: "MAIL_FORMAT",
		});
	});
	it("does not consult accounts when constructed or listed, and accepts only configured official Gmail", async () => {
		const h = setup();
		expect(h.source.available()).toMatchObject([{ id: "gmail", available: true }]);
		expect(h.readOnly).not.toHaveBeenCalled();
		expect(h.readOnlyTools).not.toHaveBeenCalled();
		h.set(undefined);
		expect(h.source.available()[0]?.available).toBe(false);
		await expect(h.source.email("gmail", undefined, h.signal)).rejects.toMatchObject({
			code: "MAIL_UNSUPPORTED",
		});
		h.set({
			id: "custom-mail",
			enabled: true,
			server: { url: "https://custom.test" },
			readOnlyTools: ["search_threads"],
		});
		await expect(h.source.email("custom-mail", undefined, h.signal)).rejects.toMatchObject({
			code: "MAIL_UNSUPPORTED",
		});
		expect(h.readOnly).not.toHaveBeenCalled();
	});
	it("takes a quiet baseline, detects stable message IDs including replies, and stays quiet on repeated polls", async () => {
		const h = setup();
		const baseline = await h.source.email("gmail", undefined, h.signal);
		expect(baseline.events).toEqual([]);
		expect(h.readOnly).toHaveBeenLastCalledWith(
			"gmail",
			"search_threads",
			{ query: "newer_than:2d", pageSize: 50, includeTrash: false, view: "THREAD_VIEW_MINIMAL" },
			h.signal,
		);
		h.advance();
		h.state.messages.push(message("reply"));
		const next = await h.source.email("gmail", baseline.cursor, h.signal);
		expect(next.events).toMatchObject([
			{ id: "gmail:reply", messageId: "reply", kind: "email", title: "Subject reply" },
		]);
		const restarted = new MailWatch(h.options);
		expect(
			(await restarted.email("gmail", JSON.parse(JSON.stringify(next.cursor)), h.signal)).events,
		).toEqual([]);
	});
	it("retains overflow in its durable cursor and drains only20 events without another mailbox request", async () => {
		const h = setup();
		const baseline = await h.source.email("gmail", undefined, h.signal);
		h.advance();
		h.state.messages.push(...Array.from({ length: 35 }, (_, n) => message(`new-${n}`)));
		const first = await h.source.email("gmail", baseline.cursor, h.signal);
		expect(first.events).toHaveLength(20);
		const calls = h.readOnly.mock.calls.length;
		const second = await new MailWatch(h.options).email("gmail", first.cursor, h.signal);
		expect(second.events).toHaveLength(15);
		expect(new Set([...first.events, ...second.events].map((event) => event.id)).size).toBe(35);
		expect(h.readOnly).toHaveBeenCalledTimes(calls);
		expect((await h.source.email("gmail", second.cursor, h.signal)).events).toEqual([]);
	});
	it("follows bounded pages and refuses partial or looping scans without modifying the saved cursor", async () => {
		const h = setup();
		const baseline = await h.source.email("gmail", undefined, h.signal);
		const saved = JSON.stringify(baseline.cursor);
		h.readOnly.mockImplementation(async (_id, _tool, args) => ({
			structuredContent: {
				threads: [{ id: "thread", messages: [message(args.pageToken ? "second" : "first")] }],
				...(args.pageToken ? {} : { nextPageToken: "page2" }),
			},
		}));
		const next = await h.source.email("gmail", baseline.cursor, h.signal);
		expect(next.events.map((event) => event.id)).toEqual(["gmail:first", "gmail:second"]);
		h.readOnly.mockImplementation(async () => ({
			structuredContent: { threads: [], nextPageToken: "loop" },
		}));
		await expect(h.source.email("gmail", baseline.cursor, h.signal)).rejects.toMatchObject({
			code: "MAIL_FORMAT",
		});
		expect(JSON.stringify(baseline.cursor)).toBe(saved);
		let page = 0;
		h.readOnly.mockImplementation(async () => ({
			structuredContent: { threads: [], nextPageToken: `page${++page}` },
		}));
		await expect(h.source.email("gmail", baseline.cursor, h.signal)).rejects.toMatchObject({
			code: "MAIL_LIMIT",
		});
		expect(page).toBe(4);
	});
	it("requires the observed input schema and read-only annotation before invoking the tool", async () => {
		const h = setup();
		h.readOnlyTools.mockResolvedValueOnce([
			{ name: "search_threads", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
		]);
		await expect(h.source.email("gmail", undefined, h.signal)).rejects.toMatchObject({ code: "MAIL_SCHEMA" });
		h.readOnlyTools.mockResolvedValueOnce([{ ...(tools[0] as Tool), annotations: { readOnlyHint: false } }]);
		await expect(h.source.email("gmail", undefined, h.signal)).rejects.toMatchObject({ code: "MAIL_SCHEMA" });
		expect(h.readOnly).not.toHaveBeenCalled();
	});
	it("extracts only safe bounded metadata and excludes sent/draft/old messages returned inside a matching thread", async () => {
		const h = setup();
		const baseline = await h.source.email("gmail", undefined, h.signal);
		h.advance();
		h.state.messages = [
			message("fresh", {
				subject: "\u0000Hello\u202e!",
				snippet: "x".repeat(2000),
				plaintextBody: "PRIVATE BODY",
				htmlBody: "PRIVATE HTML",
			}),
			message("sent", { labelIds: ["SENT"] }),
			message("draft", { labelIds: ["DRAFT"] }),
			message("past", { date: "2025-01-01" }),
			message("before", { date: "2026-10-11T09:59:00Z" }),
		];
		const next = await h.source.email("gmail", baseline.cursor, h.signal);
		expect(next.events).toHaveLength(1);
		expect(next.events[0]?.title).toBe("Hello !");
		expect(next.events[0]?.summary?.length).toBeLessThan(800);
		expect(JSON.stringify(next)).not.toMatch(/PRIVATE BODY|PRIVATE HTML/);
	});
	it("stops before I/O on stale/corrupt cursors, revoked connectors, account changes or cancellation", async () => {
		const h = setup();
		const baseline = await h.source.email("gmail", undefined, h.signal);
		await expect(h.source.email("gmail", { v: 1 }, h.signal)).rejects.toMatchObject({ code: "MAIL_CURSOR" });
		await expect(h.source.email("gmail", baseline.cursor, AbortSignal.abort())).rejects.toMatchObject({
			code: "MAIL_CANCELLED",
		});
		h.set({ revision: "r2" });
		await expect(h.source.email("gmail", baseline.cursor, h.signal)).rejects.toMatchObject({
			code: "MAIL_ACCOUNT_CHANGED",
		});
		h.set({ revision: "r1", enabled: false });
		await expect(h.source.email("gmail", baseline.cursor, h.signal)).rejects.toMatchObject({
			code: "MAIL_UNAVAILABLE",
		});
		h.set({ enabled: true });
		h.advance(2 * 86_400_000);
		await expect(h.source.email("gmail", baseline.cursor, h.signal)).rejects.toMatchObject({
			code: "MAIL_GAP",
		});
		expect(h.readOnly).toHaveBeenCalledTimes(1);
	});
	it("rechecks connector changes during reads, sanitizes source errors and refuses missing dates", async () => {
		const h = setup();
		h.readOnly.mockImplementationOnce(async () => {
			h.set({ enabled: false });
			return { structuredContent: { threads: [] } };
		});
		await expect(h.source.email("gmail", undefined, h.signal)).rejects.toMatchObject({
			code: "MAIL_UNAVAILABLE",
		});
		h.set({ enabled: true });
		h.readOnly.mockRejectedValueOnce(new Error("secret-token https://private.invalid private message"));
		await expect(h.source.email("gmail", undefined, h.signal)).rejects.toThrow(
			"No se pudo consultar Gmail. Revisa la conexión del conector.",
		);
		h.state.messages = [message("missing-date", { date: undefined })];
		await expect(h.source.email("gmail", undefined, h.signal)).rejects.toMatchObject({ code: "MAIL_FORMAT" });
	});
	it("rejects excessive IDs or pending events rather than silently truncating the mailbox", async () => {
		const h = setup();
		h.state.messages = Array.from({ length: 513 }, (_, n) => message(`many-${n}`));
		await expect(h.source.email("gmail", undefined, h.signal)).rejects.toMatchObject({ code: "MAIL_FORMAT" });
		h.state.messages = [];
		const baseline = await h.source.email("gmail", undefined, h.signal);
		h.state.messages = Array.from({ length: 61 }, (_, n) => message(`new-${n}`));
		await expect(h.source.email("gmail", baseline.cursor as WatchCursor, h.signal)).rejects.toMatchObject({
			code: "MAIL_LIMIT",
		});
	});
});
