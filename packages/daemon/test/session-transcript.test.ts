import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readBoundSessionEntries } from "../src/orchestration/activity-files.ts";
import { normalizeBoundMessages, projectSessionMessages } from "../src/orchestration/transcript.ts";

const nonce = "67da57d9-7fbe-47b6-9187-c31109fe4eba";
const prefix =
	"[System-generated Gentle Agents notification, not written by the user] Subagent output was delivered to this session above. Review it and continue.";
const wake = `${prefix} [gentle-agents wake: ${nonce}]`;
const identity = (sessionId = "owned", text = wake) => ({
	type: "custom",
	customType: "gentle-agents.wake-identity",
	data: { sessionId, nonce, text },
});
const message = (id: string, content: string, role = "user") => ({
	type: "message",
	id,
	message: { role, content },
});
const result = (id = "child") => ({
	type: "custom_message",
	id,
	display: true,
	customType: "gentle-agents.result",
	content: 'Subagent reviewer (task task-1, "Review") finished.\n\nThe review passed.',
	details: { gentleAgents: { agent: "reviewer", taskId: "task-1", cwd: "/PRIVATE" }, token: "PRIVATE" },
});

it("hides only the exact owned wake and preserves human quotes, whitespace and assistant words", () => {
	const inputs = [prefix, `Quoted: ${wake}`, ` ${wake}`, `${wake}\n`, "Human continuation"];
	const messages = projectSessionMessages("owned", [
		identity(),
		message("wake", wake),
		...inputs.map((text, i) => message(`human-${i}`, text)),
		message("assistant", wake, "assistant"),
	]);
	expect(messages.map((item) => item.id)).toEqual([...inputs.map((_, i) => `human-${i}`), "assistant"]);
	expect(messages.slice(0, inputs.length).map((item) => item.content[0]?.text)).toEqual(inputs);
	for (const invalid of [[], [identity("other")], [identity("owned", "Human continuation")]])
		expect(projectSessionMessages("owned", [message("unowned", wake)], invalid)).toHaveLength(1);
});

it("uses session-wide persisted identity without surfacing another branch's messages", () => {
	const visible = projectSessionMessages(
		"owned",
		[message("wake", wake)],
		[identity(), result("other-branch")],
	);
	expect(visible).toEqual([]);
});

it("shows useful child and peer results as attributed assistant messages, omitting internal notices", () => {
	const messages = projectSessionMessages("owned", [
		result(),
		{ ...result("note"), customType: "gentle-agents.message", content: "Progress" },
		{
			...result("peer"),
			customType: "gentle-agents.orchestrator-message",
			content: "Routing boilerplate",
			details: { gentleAgents: { senderLabel: "Design", message: "Ready to review" } },
		},
		{ ...result("hidden"), display: false },
		{ ...result("native-wake"), customType: "gentle-agents.wake" },
		{ ...result("unknown"), customType: "untrusted-plugin" },
		{ ...result("empty"), content: " " },
	]);
	expect(messages).toEqual([
		{
			id: "child",
			role: "assistant",
			content: [{ type: "text", text: "The review passed." }],
			provenance: { kind: "subagent", label: "reviewer" },
		},
		{
			id: "note",
			role: "assistant",
			content: [{ type: "text", text: "Progress" }],
			provenance: { kind: "subagent", label: "reviewer" },
		},
		{
			id: "peer",
			role: "assistant",
			content: [{ type: "text", text: "Ready to review" }],
			provenance: { kind: "session", label: "Design" },
		},
	]);
	expect(JSON.stringify(messages)).not.toContain("PRIVATE");
});

it("does not export reasoning, raw tool arguments or private extension state", () => {
	const entries = [
		{
			type: "message",
			id: "a",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [
					{ type: "thinking", thinking: "PRIVATE" },
					{ type: "toolCall", arguments: { key: "PRIVATE" } },
					{ type: "text", text: "Visible" },
				],
			},
		},
		{ type: "custom", id: "private", data: { key: "PRIVATE" } },
	];
	expect(projectSessionMessages("owned", entries)).toEqual([
		{ id: "a", role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Visible" }] },
	]);
});

it("repairs an older running adapter, restores omitted results and retains live socket content", () => {
	const entries = [
		message("human", "Do the review"),
		result(),
		message("wake", wake),
		message("parent", "Done", "assistant"),
	];
	const raw = [
		{ id: "human", role: "user", content: [{ type: "text", text: "Do the review" }] },
		{ id: "wake", role: "user", content: [{ type: "text", text: wake }] },
		{ id: "parent", role: "assistant", content: [{ type: "text", text: "Current parent text" }] },
		{ id: "streaming", role: "assistant", content: [{ type: "text", text: "Still writing" }] },
	];
	const fixed = normalizeBoundMessages("owned", raw, {
		entries,
		allEntries: [identity(), ...entries],
		truncated: false,
	});
	expect(fixed).toEqual([raw[0], projectSessionMessages("owned", [result()])[0], raw[2], raw[3]]);
	expect(normalizeBoundMessages("owned", raw, undefined)).toBe(raw);
});

it("reclassifies a result already included by a legacy adapter without duplicating it", () => {
	const entries = [result(), message("wake", wake)];
	const raw = [
		{ id: "child", role: "user", content: [{ type: "text", text: "Old result" }] },
		{ id: "wake", role: "user", content: [{ type: "text", text: wake }] },
	];
	expect(
		normalizeBoundMessages("owned", raw, { entries, allEntries: [identity(), ...entries], truncated: false }),
	).toEqual(projectSessionMessages("owned", [result()]));
	// A one-message legacy page can still recover the custom result immediately before its wake.
	expect(
		normalizeBoundMessages("owned", raw.slice(1), {
			entries,
			allEntries: [identity(), ...entries],
			truncated: false,
		}),
	).toEqual(projectSessionMessages("owned", [result()]));
});

it("retains a human image attachment even when its caption exactly quotes an owned wake", () => {
	const entry = {
		type: "message",
		id: "image",
		message: {
			role: "user",
			content: [
				{ type: "text", text: wake },
				{ type: "image", data: "owned-image", mimeType: "image/png" },
			],
		},
	};
	expect(projectSessionMessages("owned", [entry], [identity()])).toHaveLength(1);
	const raw = [{ id: "image", role: "user", content: entry.message.content }];
	expect(
		normalizeBoundMessages("owned", raw, {
			entries: [entry],
			allEntries: [identity(), entry],
			truncated: false,
		}),
	).toEqual(raw);
});

it("finds the owned wake identity outside an 8 MiB chat tail and revalidates its cached location", () => {
	const directory = mkdtempSync(join(tmpdir(), "dot-large-wake-"));
	try {
		const path = join(directory, "session.jsonl");
		const header = { type: "session", id: "owned", cwd: directory };
		const ownership = { ...identity(), id: "identity", parentId: "large-before" };
		const filler = (id: string, parentId: string) => ({
			type: "custom",
			id,
			parentId,
			data: "x".repeat(9 * 1024 * 1024),
		});
		const persisted = [
			header,
			filler("large-before", "header"),
			ownership,
			filler("large-after", "identity"),
			{ ...message("wake", wake), parentId: "large-after" },
			{ ...message("human", `Quoted: ${wake}`), parentId: "wake" },
		];
		writeFileSync(path, `${persisted.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
		const bound = { sessionId: "owned", sessionFile: path, cwd: directory };
		const raw = [
			{ id: "wake", role: "user", content: [{ type: "text", text: wake }] },
			{ id: "human", role: "user", content: [{ type: "text", text: `Quoted: ${wake}` }] },
		];
		const page = { sessionId: "owned", messages: raw };
		const inspect = () => normalizeBoundMessages("owned", raw, readBoundSessionEntries(bound, page));
		expect(inspect()).toEqual([raw[1]]);
		// Append advances the file signature; its independently validated identity line remains valid.
		appendFileSync(
			path,
			`${JSON.stringify({ type: "custom", id: "new-entry", parentId: "human", data: {} })}\n`,
		);
		expect(inspect()).toEqual([raw[1]]);
		// Editing the old prefix invalidates its ownership even though the chat tail is unchanged.
		const bytes = readFileSync(path, "utf8").replace(
			JSON.stringify(ownership),
			JSON.stringify({ ...ownership, data: { ...ownership.data, sessionId: "other" } }),
		);
		writeFileSync(path, bytes);
		expect(inspect()).toEqual(raw);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
