import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import type { OrchestrationClient } from "../src/orchestration.ts";
import { initialState } from "../src/store.ts";

it("opens the exact notified session and returns to the existing chat without sending anything", async () => {
	const send = vi.fn();
	const client: OrchestrationClient = {
		snapshot: vi.fn<OrchestrationClient["snapshot"]>(async () => ({
			available: true,
			approvals: [],
			policies: [],
			events: [],
			sessions: [
				{
					paneId: "pane-current",
					sessionId: "session-current",
					terminalId: "terminal",
					workspaceId: "workspace",
					label: "Notified session",
					state: "idle",
					connected: true,
					managed: true,
				},
			],
		})),
		act: vi.fn(async () => {}),
		inspect: vi.fn<OrchestrationClient["inspect"]>(async () => ({
			sessionId: "session-current",
			status: "idle",
			question: null,
			messages: [
				{
					id: "remote-message",
					role: "assistant",
					content: [{ type: "text", text: "The notified session is open." }],
				},
			],
		})),
	};
	render(
		<ChatSurface
			variant="web"
			mobileControls={<span>Device settings</span>}
			state={{ ...initialState, connection: "open", agentState: "idle" }}
			send={send}
			dismiss={vi.fn()}
			orchestration={client}
		/>,
	);
	await waitFor(() => expect(client.snapshot).toHaveBeenCalled());
	act(() =>
		window.dispatchEvent(
			new CustomEvent("gentledot-open-session", {
				detail: { paneId: "pane-current", sessionId: "recycled-session" },
			}),
		),
	);
	await act(async () => {});
	expect(client.inspect).not.toHaveBeenCalled();
	act(() =>
		window.dispatchEvent(
			new CustomEvent("gentledot-open-session", {
				detail: { paneId: "pane-current", sessionId: "session-current" },
			}),
		),
	);
	await screen.findByText("The notified session is open.");
	expect(client.inspect).toHaveBeenCalledWith(
		"pane-current",
		"session-current",
		expect.any(AbortSignal),
	);
	act(() => window.dispatchEvent(new Event("gentledot-open-chat")));
	expect(screen.getByRole("button", { name: /^Dot$/ })).toHaveAttribute("aria-pressed", "true");
	expect(client.act).not.toHaveBeenCalled();
	expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send" }));
});
