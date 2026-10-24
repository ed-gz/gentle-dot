import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ComputerEntry } from "../src/components/Computer.tsx";
import { RemoteComputerCard } from "../src/components/RemoteComputerCard.tsx";
import type { ComputerSnapshot, OrchestrationClient } from "../src/orchestration.ts";

const status: ComputerSnapshot = {
	available: true,
	platform: "linux",
	permissions: { accessibility: true, screenRecording: true, screenshotsSupported: true },
	state: { active: false, yolo: false },
};
function client(): OrchestrationClient &
	Required<Pick<OrchestrationClient, "computerStatus" | "stopComputer">> {
	return {
		snapshot: vi.fn(),
		act: vi.fn(),
		inspect: vi.fn(),
		computerStatus: vi.fn(async () => status),
		stopComputer: vi.fn(async () => status),
	};
}
it("keeps stop usable when a status request fails", async () => {
	const api = client();
	vi.mocked(api.computerStatus).mockRejectedValue(new Error("Conexión interrumpida"));
	render(<RemoteComputerCard client={api} />);
	await screen.findByText("Conexión interrumpida");
	await userEvent.click(screen.getByRole("button", { name: "Detener control del equipo" }));
	expect(api.stopComputer).toHaveBeenCalledOnce();
	await screen.findByText("Listo cuando lo necesites");
});
it("ignores an old active status that finishes after Stop", async () => {
	const api = client();
	let resolve!: (status: ComputerSnapshot) => void;
	vi.mocked(api.computerStatus).mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	render(<RemoteComputerCard client={api} />);
	await waitFor(() => expect(resolve).toBeTypeOf("function"));
	await userEvent.click(screen.getByRole("button", { name: "Detener control del equipo" }));
	await screen.findByText("Listo cuando lo necesites");
	await act(async () => resolve({ ...status, state: { active: true, yolo: false } }));
	expect(screen.queryByText("Dot está controlando el escritorio")).not.toBeInTheDocument();
});
it("cancels the status request when leaving the settings section", async () => {
	const api = client();
	const view = render(<RemoteComputerCard client={api} />);
	await screen.findByText("Listo cuando lo necesites");
	const signal = vi.mocked(api.computerStatus).mock.calls[0]?.[0];
	view.unmount();
	expect(signal?.aborted).toBe(true);
});
it("Linux setup explains missing helpers instead of offering macOS system permissions", async () => {
	render(
		<ComputerEntry
			controls={{
				available: true,
				stop: vi.fn(),
				setYolo: vi.fn(),
				requestPermission: vi.fn(),
				permissions: vi.fn(async () => ({ accessibility: false, screenRecording: true })),
				capabilities: vi.fn(async () => ({
					platform: "linux",
					backend: "hyprland",
					supported: true,
					missingDependencies: ["wtype"],
					limitations: [],
				})),
			}}
		/>,
	);
	await screen.findByText("Missing on this computer: wtype");
	expect(screen.queryByRole("button", { name: /Grant/ })).not.toBeInTheDocument();
	expect(screen.queryByText(/Debug builds lose/)).not.toBeInTheDocument();
});

it("does not show an outdated network error after Stop succeeds", async () => {
	const api = client();
	let reject!: (error: Error) => void;
	vi.mocked(api.computerStatus).mockImplementation(
		() =>
			new Promise((_done, fail) => {
				reject = fail;
			}),
	);
	render(<RemoteComputerCard client={api} />);
	await waitFor(() => expect(reject).toBeTypeOf("function"));
	await userEvent.click(screen.getByRole("button", { name: "Detener control del equipo" }));
	await screen.findByText("Listo cuando lo necesites");
	await act(async () => reject(new Error("Old status error")));
	expect(screen.queryByText("Old status error")).not.toBeInTheDocument();
});
