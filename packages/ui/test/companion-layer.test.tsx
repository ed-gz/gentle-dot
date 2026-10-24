import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
import { useCompanionLayer } from "../src/useCompanionLayer.ts";

function Fixture({ enabled = true }: { enabled?: boolean }) {
	const host = useCompanionLayer(enabled);
	const [clicks, setClicks] = useState(0);
	return createPortal(
		<button type="button" onClick={() => setClicks((value) => value + 1)}>
			Capri {clicks}
		</button>,
		host,
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	document.querySelectorAll("dialog[data-layer-test]").forEach((element) => {
		element.remove();
	});
});

it("preserves one host and React state through nested dialogs, closing and removed modals", async () => {
	const fixture = render(<Fixture />);
	const host = document.querySelector<HTMLElement>("[data-companion-layer]");
	if (!host) throw new Error("Missing companion host");
	expect(host.parentElement).toBe(document.body);
	fireEvent.click(screen.getByRole("button", { name: "Capri 0" }));
	const first = document.createElement("dialog");
	const second = document.createElement("dialog");
	// jsdom has no browser top layer. The E2E suite verifies actual showModal/popover hit testing.
	for (const dialog of [first, second])
		vi.spyOn(dialog, "matches").mockImplementation((selector) => selector === ":modal" && dialog.open);
	first.dataset.layerTest = second.dataset.layerTest = "true";
	document.body.append(first, second);
	await act(async () => first.setAttribute("open", ""));
	await waitFor(() => expect(host.parentElement).toBe(first));
	await act(async () => second.setAttribute("open", ""));
	await waitFor(() => expect(host.parentElement).toBe(second));
	expect(document.querySelectorAll("[data-companion-layer]")).toHaveLength(1);
	fireEvent.click(screen.getByRole("button", { name: "Capri 1" }));
	await act(async () => second.removeAttribute("open"));
	await waitFor(() => expect(host.parentElement).toBe(first));
	await act(async () => first.remove());
	await waitFor(() => expect(host.parentElement).toBe(document.body));
	expect(screen.getByRole("button", { name: "Capri 2" })).toBeInTheDocument();
	fixture.unmount();
	expect(document.querySelector("[data-companion-layer]")).toBeNull();
});

it("detaches a disabled layer and reuses the same instance when shown again", async () => {
	const fixture = render(<Fixture />);
	const host = document.querySelector("[data-companion-layer]");
	if (!host) throw new Error("Missing companion host");
	fireEvent.click(screen.getByRole("button", { name: "Capri 0" }));
	fixture.rerender(<Fixture enabled={false} />);
	expect(host.isConnected).toBe(false);
	fixture.rerender(<Fixture />);
	expect(host.parentElement).toBe(document.body);
	expect(screen.getByRole("button", { name: "Capri 1" })).toBeInTheDocument();
});
