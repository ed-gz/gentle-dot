import { expect, it } from "vitest";
import { ComputerCaptureStore } from "../src/computer-capture.ts";
import { SharedFileError } from "../src/shared-files.ts";
import type { SupervisorEvent } from "../src/supervisor.ts";

import { CAPTURE_JPEG as JPEG } from "./fixtures/capture-image.ts";

const image = { type: "image", mimeType: "image/jpeg", data: JPEG.toString("base64") };
const start = (name = "screenshot", id = "capture") => ({
	type: "tool_execution_start",
	toolName: `mcp__computer__${name}`,
	toolCallId: id,
});
const end = (name = "screenshot", id = "capture", result: unknown = { content: [image] }) => ({
	type: "tool_execution_end",
	toolName: `mcp__computer__${name}`,
	toolCallId: id,
	isError: false,
	result,
});
function setup() {
	const store = new ComputerCaptureStore();
	store.observe({ type: "agent_start" });
	store.observe({ type: "message_start", message: { role: "user", content: "Comparte la captura" } });
	return store;
}
function capture(store: ComputerCaptureStore) {
	store.observe(start());
	store.observe(end());
}
function missing(store: ComputerCaptureStore) {
	expect(() => store.latest()).toThrow(SharedFileError);
	expect(() => store.latest()).toThrow("Toma una nueva captura");
}

it.each(["screenshot", "click", "move", "drag", "scroll", "type", "key", "open_app", "wait", "batch"])(
	"keeps the exact image from the correlated native %s result, without retaining mutable buffers",
	(name) => {
		const store = setup();
		store.observe(start(name));
		store.observe(end(name));
		const received = store.latest();
		expect(received).toEqual(JPEG);
		received.fill(0);
		expect(store.latest()).toEqual(JPEG);
	},
);

it("ignores unsolicited, replayed and foreign tool results, and model text that imitates a capture", () => {
	const store = setup();
	store.observe(end());
	missing(store);
	store.observe({ ...start(), toolName: "foreign__screenshot" });
	store.observe({ ...end(), toolName: "foreign__screenshot" });
	store.observe({
		type: "message_end",
		message: { role: "toolResult", toolName: "mcp__computer__screenshot", content: [image] },
	});
	store.observe({ type: "message_end", message: { role: "assistant", content: [image] } });
	missing(store);
	store.observe(start());
	store.observe(end("screenshot", "other"));
	store.observe(end("click"));
	missing(store);
	store.observe(end());
	expect(store.latest()).toEqual(JPEG);
	store.observe({ ...end(), result: { content: [] } });
	expect(store.latest()).toEqual(JPEG);
});

it("invalidates the prior view when another native action begins, including a failed or unknown action", () => {
	const store = setup();
	capture(store);
	store.observe(start("click", "new"));
	missing(store);
	store.observe({ ...end("click", "new"), isError: true });
	missing(store);
	capture(store);
	store.observe(start("unknown_action", "unknown"));
	store.observe(end("unknown_action", "unknown"));
	missing(store);
});

it("accepts only the newest overlapping native call and never restores an older late result", () => {
	const store = setup();
	store.observe(start("screenshot", "old"));
	store.observe(start("click", "new"));
	store.observe(end("screenshot", "old"));
	missing(store);
	store.observe(end("click", "new"));
	expect(store.latest()).toEqual(JPEG);
	store.observe(end("screenshot", "old", { content: [] }));
	expect(store.latest()).toEqual(JPEG);
});

it.each([
	undefined,
	null,
	[],
	{ content: [] },
	{ isError: true, content: [image] },
	{ isError: "false", content: [image] },
	{ content: [image, image] },
	{ content: [{ ...image, mimeType: "image/png" }] },
	{ content: [{ ...image, data: "not-an-image" }] },
	{ content: [{ ...image, data: `data:image/jpeg;base64,${image.data}` }] },
	{ content: [{ ...image, data: `${image.data}\n` }] },
	{ content: [{ ...image, data: Buffer.from("private data").toString("base64") }] },
	{ content: [{ ...image, data: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64") }] },
])("refuses malformed, errored or oversized native image results %#", (result) => {
	const store = setup();
	store.observe(start());
	store.observe({ ...end(), result });
	missing(store);
});

it.each<SupervisorEvent>([
	{ type: "agent_start" },
	{ type: "agent_end" },
	{ type: "agent_settled" },
	{ type: "interrupted" },
	{ type: "supervisor_state", state: "restarting" },
	{ type: "supervisor_state", state: "stopped" },
	{ type: "supervisor_state", state: "starting" },
	{ type: "message_start", message: { role: "user", content: "Otra solicitud" } },
])("clears screenshots and pending results at the lifecycle boundary %#", (boundary) => {
	const store = setup();
	capture(store);
	store.observe(boundary);
	missing(store);
	store.observe({ type: "agent_start" });
	store.observe(start());
	store.observe(boundary);
	store.observe(end());
	missing(store);
});

it("preserves the observed capture through model iterations, other tools, and read-only native diagnostics", () => {
	const store = setup();
	capture(store);
	for (const event of [
		{ type: "turn_end" },
		{ type: "turn_start" },
		{ type: "supervisor_state", state: "ready" },
		{ type: "message_start", message: { role: "assistant" } },
		{ type: "message_end", message: { role: "assistant" } },
		{ ...start(), toolName: "dot_share_screenshot" },
		start("capabilities"),
		end("capabilities"),
		start("list_apps"),
		end("list_apps"),
	])
		store.observe(event);
	expect(store.latest()).toEqual(JPEG);
});

it("clear stops accepting images until a new run, including delayed results after disconnect or Stop", () => {
	const store = setup();
	capture(store);
	store.clear();
	missing(store);
	capture(store);
	missing(store);
	store.observe({ type: "agent_start" });
	capture(store);
	expect(store.latest()).toEqual(JPEG);
});
