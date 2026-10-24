import type { ServerPayload } from "@gentle-dot/protocol";
import { describe, expect, it, vi } from "vitest";
import { DotBridge } from "../src/bridge.ts";
import { historyFromMessages } from "../src/conversations.ts";
import type { SupervisorEvent } from "../src/supervisor.ts";
import { fakeSupervisor } from "./helpers.ts";

const id = "a".repeat(43);
const image = `![Captura del equipo](/api/files/${id}/content)`;
const publication = {
	id,
	markdown: `![Captura del navegador](/api/files/${id}/content)`,
	mime: "image/jpeg",
	image: true,
	name: "captura.jpg",
	size: 1024,
};
const contentOf = (value: unknown) => [{ type: "text", text: JSON.stringify(value) }];
const call = (name = "dot_share_screenshot", callId = "capture") => ({
	role: "assistant",
	stopReason: "toolUse",
	content: [{ type: "toolCall", id: callId, name, arguments: {} }],
});
const result = (value: unknown = publication, isError = false, callId = "capture") => ({
	role: "toolResult",
	toolCallId: callId,
	content: contentOf(value),
	isError,
});
const user = { role: "user", content: "Mándame una captura" };
const answer = (text = "Aquí tienes la captura.", stopReason = "stop") => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason,
});

function live() {
	const { supervisor, dataDir } = fakeSupervisor();
	supervisor.state = "ready";
	let emit: (event: SupervisorEvent) => void = () => {};
	vi.spyOn(supervisor, "onEvent").mockImplementation((listener) => {
		emit = listener;
		return () => {};
	});
	const request = vi
		.spyOn(supervisor, "request")
		.mockResolvedValue({ type: "response", command: "abort", success: true });
	const invalidated = vi.fn();
	const bridge = new DotBridge(supervisor, {
		dataDir,
		features: { conversations: true },
		onCaptureInvalidated: invalidated,
	});
	const received: ServerPayload[] = [];
	const client = { send: (message: ServerPayload) => received.push(message) };
	bridge.attach(client);
	const message = (value: ReturnType<typeof answer> | ReturnType<typeof call>) => {
		emit({ type: "message_start", message: value });
		if (value.content[0] && "text" in value.content[0])
			emit({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: value.content[0].text },
			});
		emit({ type: "message_end", message: value });
	};
	const tool = (value = publication, isError = false, toolName = "dot_share_screenshot") => {
		emit({ type: "tool_execution_start", toolCallId: "capture", toolName });
		emit({
			type: "tool_execution_end",
			toolCallId: "capture",
			toolName,
			result: { content: contentOf(value) },
			isError,
		});
	};
	const done = () =>
		received.filter(
			(value): value is Extract<ServerPayload, { type: "message_done" }> => value.type === "message_done",
		);
	return { bridge, client, emit, message, tool, done, received, invalidated, request };
}

describe("explicit screenshot delivery", () => {
	it("appends the omitted image to the final live answer and reconstructs the same history", () => {
		const chat = live();
		chat.emit({ type: "message_start", message: user });
		chat.message(call());
		chat.tool();
		chat.message(answer());
		expect(chat.done()[0]).toMatchObject({ text: "", intermediate: true });
		expect(chat.done()[1]).toMatchObject({ text: `Aquí tienes la captura.\n\n${image}` });
		expect(chat.received.filter((value) => value.type === "message_delta")).toEqual([
			expect.objectContaining({ delta: "Aquí tienes la captura." }),
		]);
		expect(historyFromMessages([user, call(), result(), answer()]).at(-1)?.text).toBe(chat.done()[1]?.text);
	});

	it("deduplicates an image included by the model with its original label", () => {
		const text = `Aquí tienes.\n\n${publication.markdown}`;
		const chat = live();
		chat.message(call());
		chat.tool();
		chat.message(answer(text));
		expect(chat.done().at(-1)?.text).toBe(text);
		expect(historyFromMessages([user, call(), result(), answer(text)]).at(-1)?.text).toBe(text);
	});

	it("does not duplicate an image already delivered during a continuation", () => {
		const chat = live();
		chat.message(call());
		chat.tool();
		chat.message(answer(publication.markdown, "toolUse"));
		chat.message(answer("Listo."));
		expect(chat.done().at(-1)?.text).toBe("Listo.");
		expect(
			historyFromMessages([
				user,
				call(),
				result(),
				answer(publication.markdown, "toolUse"),
				answer("Listo."),
			]).at(-1)?.text,
		).toBe(`${publication.markdown}\n\nListo.`);
	});

	it.each(["error", "aborted"])("discards a publication when the answer ends as %s", (reason) => {
		const chat = live();
		chat.message(call());
		chat.tool();
		chat.message(answer("No terminé.", reason));
		chat.message(answer("Otra respuesta."));
		expect(chat.done().every((value) => !value.text.includes("/api/files/"))).toBe(true);
		expect(
			historyFromMessages([
				user,
				call(),
				result(),
				answer("No terminé.", reason),
				answer("Otra respuesta."),
			]).at(-1)?.text,
		).toBe("No terminé.\n\nOtra respuesta.");
	});

	it("drops a pending result when the user stops, even when a late result arrives", async () => {
		const chat = live();
		chat.message(call());
		chat.emit({ type: "tool_execution_start", toolCallId: "capture", toolName: "dot_share_screenshot" });
		await chat.bridge.handle(chat.client, { type: "abort" });
		expect(chat.invalidated).toHaveBeenCalledOnce();
		expect(chat.invalidated.mock.invocationCallOrder[0]).toBeLessThan(
			chat.request.mock.invocationCallOrder[0] as number,
		);
		chat.emit({
			type: "tool_execution_end",
			toolCallId: "capture",
			result: { content: contentOf(publication) },
		});
		chat.message(answer());
		expect(chat.done().at(-1)?.text).toBe("Aquí tienes la captura.");
	});

	it("invalidates private pixels before switching sessions without clearing them after ordinary tools", async () => {
		const chat = live();
		chat.message(call());
		chat.tool();
		expect(chat.invalidated).not.toHaveBeenCalled();
		await chat.bridge.handle(chat.client, { type: "new_conversation" });
		expect(chat.invalidated).toHaveBeenCalledOnce();
		expect(chat.invalidated.mock.invocationCallOrder[0]).toBeLessThan(
			chat.request.mock.invocationCallOrder[0] as number,
		);
		chat.message(answer("Nueva conversación."));
		expect(chat.done().at(-1)?.text).toBe("Nueva conversación.");
	});

	it("never carries an unfinished publication into another user turn or a restart", () => {
		for (const boundary of [
			{ type: "message_start", message: user },
			{ type: "supervisor_state", state: "restarting" },
			{ type: "interrupted" },
		] satisfies SupervisorEvent[]) {
			const chat = live();
			chat.message(call());
			chat.tool();
			chat.emit(boundary);
			chat.message(answer("Siguiente turno."));
			expect(chat.done().at(-1)?.text).toBe("Siguiente turno.");
		}
		expect(historyFromMessages([user, call(), result(), user, answer("Siguiente turno.")]).at(-1)?.text).toBe(
			"Siguiente turno.",
		);
	});

	it("only accepts matched, successful explicit sharing calls, not internal screenshots or arbitrary tools", () => {
		for (const toolName of ["computer_screenshot", "mcp_computer_screenshot", "dot_share_file", "bash"]) {
			const chat = live();
			chat.tool(publication, false, toolName);
			chat.message(answer());
			expect(chat.done().at(-1)?.text).toBe("Aquí tienes la captura.");
			expect(historyFromMessages([user, call(toolName), result(), answer()]).at(-1)?.text).toBe(
				"Aquí tienes la captura.",
			);
		}
		expect(historyFromMessages([user, result(), answer()]).at(-1)?.text).toBe("Aquí tienes la captura.");
		expect(historyFromMessages([user, call(), result(publication, true), answer()]).at(-1)?.text).toBe(
			"Aquí tienes la captura.",
		);
		expect(
			historyFromMessages([user, call(), result(publication, false, "unmatched"), answer()]).at(-1)?.text,
		).toBe("Aquí tienes la captura.");
	});

	it("does not render untrusted tool markdown or invalid publication metadata", () => {
		for (const changed of [
			{ id: "../../secret" },
			{ mime: "text/html" },
			{ image: false },
			{ size: 0 },
			{ size: 2 * 1024 * 1024 + 1 },
			{ markdown: "![x](https://example.com/track)" },
			{ markdown: `![x](/api/files/${"b".repeat(43)}/content)` },
			{ markdown: `${publication.markdown}\n<script>alert(1)</script>` },
		]) {
			expect(
				historyFromMessages([user, call(), result({ ...publication, ...changed }), answer()]).at(-1)?.text,
			).toBe("Aquí tienes la captura.");
		}
		const changedLabel = {
			...publication,
			markdown: `![<script>untrusted</script>](/api/files/${id}/content)`,
		};
		expect(historyFromMessages([user, call(), result(changedLabel), answer("")]).at(-1)?.text).toBe(image);
	});
});
