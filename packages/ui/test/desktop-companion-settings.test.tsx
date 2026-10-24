import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DesktopCompanionSettings } from "../src/components/DesktopCompanionSettings.tsx";
import { DEFAULT_DESKTOP_COMPANION, type DesktopCompanionControls } from "../src/desktop-companion.ts";

const full = { x: 0, y: 0, width: 1, height: 1 };
function controls(): DesktopCompanionControls {
	return {
		state: {
			...DEFAULT_DESKTOP_COMPANION,
			enabled: true,
			available: true,
			visible: true,
			monitors: [
				{ name: "eDP-1", x: 0, y: 0, width: 1920, height: 1080 },
				{ name: "HDMI-A-1", x: -1440, y: -100, width: 1440, height: 2560 },
			],
		},
		pending: false,
		change: vi.fn(async () => {}),
		interact: vi.fn(async () => {}),
		recall: vi.fn(async () => {}),
		move: vi.fn(async () => {}),
		hide: vi.fn(async () => {}),
		menu: vi.fn(async () => {}),
	};
}
it("pins independently from animation and resumes free movement explicitly", () => {
	const value = controls();
	render(<DesktopCompanionSettings controls={value} />);
	fireEvent.click(screen.getByRole("button", { name: "Fija aquí" }));
	expect(value.change).toHaveBeenLastCalledWith({ pinned: true });
	fireEvent.click(screen.getByRole("button", { name: "Libre" }));
	expect(value.change).toHaveBeenLastCalledWith({ pinned: false, motion: true });
	fireEvent.click(screen.getByRole("button", { name: "Ocultar por ahora" }));
	expect(value.hide).toHaveBeenCalledOnce();
});
it("materializes every current display on first exclusion without silently excluding the other", () => {
	const value = controls();
	render(<DesktopCompanionSettings controls={value} />);
	expect(
		screen
			.getAllByRole("checkbox", { name: /Permitir Capri/ })
			.every((box) => (box as HTMLInputElement).checked),
	).toBe(true);
	fireEvent.click(screen.getByRole("checkbox", { name: "Permitir Capri en HDMI-A-1" }));
	expect(value.change).toHaveBeenCalledExactlyOnceWith({
		areas: [
			{ monitor: "eDP-1", enabled: true, rect: full },
			{ monitor: "HDMI-A-1", enabled: false, rect: full },
		],
	});
});
it("edits only the selected display and preserves disconnected display choices", () => {
	const value = controls();
	value.state.areas = [
		{ monitor: "old-screen", enabled: false, rect: full },
		{ monitor: "HDMI-A-1", enabled: true, rect: full },
	];
	const view = render(<DesktopCompanionSettings controls={value} />);
	expect(screen.getByRole("checkbox", { name: "Permitir Capri en eDP-1" })).not.toBeChecked();
	fireEvent.click(screen.getByRole("button", { name: "Editar zona de HDMI-A-1" }));
	fireEvent.click(screen.getByRole("button", { name: "Izquierda" }));
	expect(value.change).toHaveBeenLastCalledWith({
		areas: [
			{ monitor: "old-screen", enabled: false, rect: full },
			{ monitor: "eDP-1", enabled: false, rect: full },
			{ monitor: "HDMI-A-1", enabled: true, rect: { ...full, width: 0.5 } },
		],
	});
	view.rerender(
		<DesktopCompanionSettings
			controls={{ ...value, state: { ...value.state, monitors: value.state.monitors.slice(0, 1) } }}
		/>,
	);
	expect(screen.getByRole("group", { name: "Zona de eDP-1" })).toBeInTheDocument();
	expect(screen.queryByRole("group", { name: "Zona de HDMI-A-1" })).not.toBeInTheDocument();
});
it("lets the user restore a deliberately empty set of allowed displays even while unavailable", () => {
	const value = controls();
	value.state.available = false;
	value.state.areas = value.state.monitors.map((monitor) => ({
		monitor: monitor.name,
		enabled: false,
		rect: full,
	}));
	render(<DesktopCompanionSettings controls={value} />);
	expect(screen.getByRole("status")).toHaveTextContent("Sin pantallas permitidas");
	fireEvent.click(screen.getByRole("checkbox", { name: "Permitir Capri en eDP-1" }));
	expect(value.change).toHaveBeenCalledWith({
		areas: [
			{ monitor: "eDP-1", enabled: true, rect: full },
			{ monitor: "HDMI-A-1", enabled: false, rect: full },
		],
	});
});
