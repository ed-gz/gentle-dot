import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { FollowedWorkPanel } from "../src/components/FollowedWorkPanel.tsx";
import type { OrchestrationClient } from "../src/orchestration.ts";
import { type FollowedWork, type FollowedWorkSnapshot, parseFollowedWork } from "../src/workflows.ts";

const snapshot: FollowedWorkSnapshot = {
	pending: 0,
	workflows: [
		{
			id: "work-a",
			objective: "Coordinar revisión y pruebas",
			state: "waiting",
			sessions: [{ paneId: "pane-a", sessionId: "session-a", label: "Revisión" }],
			createdAt: "2026-10-11T06:00:00Z",
			updatedAt: "2026-10-11T06:00:00Z",
			expiresAt: "2026-10-12T06:00:00Z",
			runs: 2,
			maxRuns: 40,
			pending: 0,
		},
	],
};
function fixture() {
	return {
		snapshot: vi.fn(),
		act: vi.fn(),
		inspect: vi.fn(),
		followedWork: vi.fn(async () => snapshot),
		controlFollowedWork: vi.fn(async () => {}),
	} satisfies OrchestrationClient;
}
function continuous(state: FollowedWork["state"]): FollowedWorkSnapshot {
	return {
		pending: 0,
		workflows: snapshot.workflows.map((entry) => {
			const work = { ...entry, state, runs: 500 };
			delete work.maxRuns;
			delete work.expiresAt;
			return work;
		}),
	};
}
it("starts collapsed and lets the person pause a specific workflow without changing the agent", async () => {
	const client = fixture();
	const { container } = render(<FollowedWorkPanel client={client} connected />);
	await screen.findByText("1 en curso");
	expect(container.querySelector("details")?.open).toBe(false);
	fireEvent.click(screen.getByText("Seguimiento de Dot"));
	fireEvent.click(screen.getByRole("button", { name: "Pausar seguimiento" }));
	await screen.findByText("Seguimiento en pausa.");
	expect(client.controlFollowedWork).toHaveBeenCalledExactlyOnceWith({
		action: "pause",
		workflowId: "work-a",
	});
	expect(client.act).not.toHaveBeenCalled();
});
it("aborts the active status request when the panel closes", async () => {
	const client = fixture();
	let signal: AbortSignal | undefined;
	client.followedWork = vi.fn((s?: AbortSignal) => {
		signal = s;
		return new Promise(() => {});
	});
	const { unmount } = render(<FollowedWorkPanel client={client} connected />);
	await waitFor(() => expect(client.followedWork).toHaveBeenCalledOnce());
	unmount();
	expect(signal?.aborted).toBe(true);
});
it("allows closing an exhausted paused workflow but never resuming it", async () => {
	const client = fixture();
	client.followedWork.mockResolvedValue({
		pending: 1,
		workflows: snapshot.workflows.map((work) => ({ ...work, state: "paused", runs: 40 })),
	});
	render(<FollowedWorkPanel client={client} connected />);
	await screen.findByText("Requiere atención");
	fireEvent.click(screen.getByText("Seguimiento de Dot"));
	expect(screen.queryByRole("button", { name: "Reanudar seguimiento" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Finalizar seguimiento" }));
	await waitFor(() =>
		expect(client.controlFollowedWork).toHaveBeenCalledExactlyOnceWith({
			action: "stop",
			workflowId: "work-a",
		}),
	);
});
it("shows a storage failure even when the status panel is collapsed", async () => {
	const client = fixture();
	client.followedWork.mockResolvedValue({ ...snapshot, error: "No se pudo guardar el seguimiento." });
	const { container } = render(<FollowedWorkPanel client={client} connected />);
	await screen.findByText("Requiere revisión");
	expect(container.querySelector("details")?.open).toBe(false);
	expect(screen.queryByText("1 en curso")).toBeNull();
	fireEvent.click(screen.getByText("Seguimiento de Dot"));
	expect(screen.getByRole("button", { name: "Pausar seguimiento" })).toBeDisabled();
});
it("rejects duplicate workflow IDs, unknown states and malformed scope", () => {
	expect(parseFollowedWork(snapshot)).toEqual(snapshot);
	expect(() =>
		parseFollowedWork({ ...snapshot, workflows: [snapshot.workflows[0], snapshot.workflows[0]] }),
	).toThrow();
	expect(() =>
		parseFollowedWork({ ...snapshot, workflows: [{ ...snapshot.workflows[0], state: "anything" }] }),
	).toThrow();
	expect(() =>
		parseFollowedWork({
			...snapshot,
			workflows: [{ ...snapshot.workflows[0], sessions: [{ paneId: null }] }],
		}),
	).toThrow();
});
it("accepts continuous objectives and validates optional limits only when present", () => {
	const value = continuous("paused");
	expect(parseFollowedWork(value)).toEqual(value);
	for (const limit of [
		{ expiresAt: null },
		{ expiresAt: "invalid" },
		{ maxRuns: null },
		{ maxRuns: 0 },
		{ maxRuns: -1 },
		{ maxRuns: 1.5 },
	]) {
		expect(() =>
			parseFollowedWork({ ...value, workflows: value.workflows.map((work) => ({ ...work, ...limit })) }),
		).toThrow();
	}
});
it.each(["paused", "failed"] as const)(
	"resumes a continuous %s objective without an arbitrary time or run cap",
	async (state) => {
		const client = fixture();
		client.followedWork.mockResolvedValue(continuous(state));
		render(<FollowedWorkPanel client={client} connected />);
		await screen.findByText("Requiere atención");
		fireEvent.click(screen.getByText("Seguimiento de Dot"));
		expect(screen.getByRole("article", { name: "Coordinar revisión y pruebas" })).toBeVisible();
		expect(screen.queryByText(/continuaciones|Límite acordado|Invalid Date/i)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Reanudar seguimiento" }));
		await waitFor(() =>
			expect(client.controlFollowedWork).toHaveBeenCalledExactlyOnceWith({
				action: "resume",
				workflowId: "work-a",
			}),
		);
	},
);
it("keeps existing time and run limits in details rather than the objective summary", async () => {
	const client = fixture();
	render(<FollowedWorkPanel client={client} connected />);
	await screen.findByText("1 en curso");
	fireEvent.click(screen.getByText("Seguimiento de Dot"));
	expect(screen.getByText("1 agente")).toBeVisible();
	expect(screen.getByText("Continuaciones acordadas: 2 de 40")).not.toBeVisible();
	expect(screen.getByText(/Límite acordado:/)).not.toBeVisible();
	fireEvent.click(screen.getByText("Ver detalles"));
	expect(screen.getByText("Continuaciones acordadas: 2 de 40")).toBeVisible();
	expect(screen.getByText(/Límite acordado:/)).toBeVisible();
});
