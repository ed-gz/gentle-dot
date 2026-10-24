import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { AgentPermissionCard } from "../src/components/AgentPermissionCard.tsx";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import type { AgentApproval, OrchestrationClient, OrchestrationSnapshot } from "../src/orchestration.ts";
import { initialState } from "../src/store.ts";
import type { OrchestrationControls } from "../src/useOrchestration.ts";

const consent = {
	schema: "gentle-ai.review-integration.consent/v3", agent: "pi", target_identity: "sha256:frozen-candidate", projection: "workspace",
	headline: "Review this exact candidate?", reason: "Process boundary changed.", value: "Independent checks before completion.",
	risk_level: "high", changed_files: 2, changed_lines: 12, risk_evidence: ["Full original evidence\nSecond line"],
	choices: [
		{ answer: "granted", label: "Run the review now", effect: "Only this frozen candidate; no later permission.", invocation: "gentle-ai review start --target sha256:frozen-candidate --consent granted" },
		{ answer: "declined", label: "Not now, just this once", effect: "No lineage or receipt. Not the kill switch.", invocation: "gentle-ai review start --target sha256:frozen-candidate --consent declined" },
	],
	off_path: { note: "Manual setting, never executed by this card.", command: "gentle-ai review mode disable" },
};
const approval: AgentApproval = {
	id: "review-1", paneId: "p1", sessionId: "s1", title: consent.headline, message: JSON.stringify(consent, null, 2), action: "question", kind: "select", answerable: true,
	options: consent.choices.map(choice => ({ id: choice.answer, label: `${choice.label}\nEffect: ${choice.effect}` })),
	createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
};
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeAll(() => {
	Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
	Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
});
afterAll(() => {
	for (const [key, descriptor] of [["showModal", originalShow], ["close", originalClose]] as const) {
		if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, key, descriptor);
		else Reflect.deleteProperty(HTMLDialogElement.prototype, key);
	}
});
afterEach(() => localStorage.clear());

function api() {
	let snapshot: OrchestrationSnapshot = { available: true, sessions: [{ paneId: "p1", sessionId: "s1", terminalId: "t1", workspaceId: "w", label: "Review owner", state: "blocked", connected: true, managed: true }], approvals: [approval], policies: [], events: [] };
	const act = vi.fn(async () => { snapshot = { ...snapshot, approvals: [] }; });
	return { snapshot: vi.fn(async () => snapshot), act, inspect: vi.fn(async () => ({ sessionId: "s1", status: "waiting" as const, question: null, messages: [] })), dotApprovals: vi.fn(async () => ({ allowed: true, approvals: [] })), answerDotApproval: vi.fn() } satisfies OrchestrationClient;
}

it.each(["inline", "popup"])("shows full RDD content and exact two choices in %s presentation", async mode => {
	localStorage.setItem("gentledot.request-presentation", mode);
	const client = api();
	render(<ChatSurface variant="web" state={{ ...initialState, connection: "open", agentState: "idle" }} send={vi.fn()} dismiss={vi.fn()} mobileControls={<span>Phone</span>} orchestration={client} />);
	if (mode === "inline") {
		await userEvent.click(screen.getByRole("button", { name: "Sesiones" }));
		await userEvent.click(await screen.findByRole("button", { name: /Review owner ·/ }));
	} else {
		const dialog = await screen.findByRole("dialog", { name: "Solicitudes pendientes" });
		expect(within(dialog).getByRole("button", { name: "Cerrar sin responder" })).toHaveFocus();
		await userEvent.click(within(dialog).getByRole("button", { name: "Cerrar sin responder" }));
		expect(client.act).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: /Ver solicitudes pendientes/ }));
	}
	const detail = await screen.findByRole("region", { name: "Detalle de la solicitud" });
	expect(detail.querySelector("pre")?.textContent).toBe(approval.message);
	expect(screen.getAllByRole("radio")).toHaveLength(2);
	expect(screen.queryByText("Review and allow this session")).toBeNull();
	await userEvent.click(screen.getByRole("radio", { name: /Not now, just this once/ }));
	await userEvent.click(screen.getByRole("button", { name: "Enviar respuesta" }));
	await waitFor(() => expect(client.act).toHaveBeenCalledExactlyOnceWith({ action: "answer", paneId: "p1", sessionId: "s1", requestId: "review-1", optionId: "declined" }));
});

it("sends the exact grant only after explicit selection and waits for accepted delivery", async () => {
	let acknowledge: (accepted: boolean) => void = () => {};
	const act = vi.fn(() => new Promise<boolean>(resolve => { acknowledge = resolve; }));
	render(<AgentPermissionCard approval={approval} controls={{ act, busy: false } as unknown as OrchestrationControls} disabled={false} />);
	expect(screen.getByRole("button", { name: "Enviar respuesta" })).toBeDisabled();
	await userEvent.click(screen.getByRole("radio", { name: /Run the review now/ }));
	await userEvent.click(screen.getByRole("button", { name: "Enviar respuesta" }));
	expect(act).toHaveBeenCalledExactlyOnceWith({ action: "answer", paneId: "p1", sessionId: "s1", requestId: "review-1", optionId: "granted" });
	expect(screen.queryByText("Respuesta enviada")).toBeNull();
	expect(screen.getByRole("button", { name: "Enviar respuesta" })).toBeDisabled();
	acknowledge(false);
	await waitFor(() => expect(screen.getByRole("button", { name: "Enviar respuesta" })).toBeEnabled());
	expect(screen.queryByText("Respuesta enviada")).toBeNull();
});

it.each(["disconnected", "expired", "unanswerable"])("does not submit RDD consent when %s", async reason => {
	const act = vi.fn(async () => true);
	render(<AgentPermissionCard approval={{ ...approval, ...(reason === "expired" ? { expiresAt: "2000-01-01T00:00:00Z" } : {}), ...(reason === "unanswerable" ? { answerable: false } : {}) }} controls={{ act, busy: false } as unknown as OrchestrationControls} disabled={reason === "disconnected"} />);
	fireEvent.click(screen.getByRole("radio", { name: /Run the review now/ }));
	fireEvent.click(screen.getByRole("button", { name: "Enviar respuesta" }));
	expect(act).not.toHaveBeenCalled();
});
