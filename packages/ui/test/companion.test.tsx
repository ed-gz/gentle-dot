import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CapriCompanion, CompanionSwitch } from "../src/components/CapriCompanion.tsx";
import { COMPANION_KEY, parseCompanion, useCompanion } from "../src/useCompanion.ts";

afterEach(() => {
	localStorage.clear();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it("only commits a mode after acknowledgement and retains the prior mode on failure", async () => {
	const client = {
		read: vi.fn().mockResolvedValue("gentle"),
		set: vi.fn().mockRejectedValue(new Error("Sin conexión")),
	};
	const { result } = renderHook(() => useCompanion(client));
	await act(async () => {});
	await act(async () => result.current.setMode("capri"));
	expect(result.current.settings.mode).toBe("gentle");
	expect(result.current.error).toBe("Sin conexión");
	client.set.mockResolvedValue("capri");
	await act(async () => result.current.setMode("capri"));
	expect(result.current.settings.mode).toBe("capri");
	expect(JSON.parse(localStorage.getItem(COMPANION_KEY)!)).toMatchObject({ mode: "capri" });
});

it("a slow initial read cannot overwrite a newly confirmed switch", async () => {
	let resolve!: (mode: "gentle") => void;
	const client = {
		read: () =>
			new Promise<"gentle">((done) => {
				resolve = done;
			}),
		set: vi.fn().mockResolvedValue("capri"),
	};
	const { result } = renderHook(() => useCompanion(client));
	await act(async () => result.current.setMode("capri"));
	await act(async () => resolve("gentle"));
	expect(result.current.settings.mode).toBe("capri");
});

it("ignores an old computer's acknowledgement after switching computers", async () => {
	let finish!: (mode: "capri") => void;
	const first = {
		read: vi.fn().mockResolvedValue("gentle"),
		set: () =>
			new Promise<"capri">((resolve) => {
				finish = resolve;
			}),
	};
	const second = { read: vi.fn().mockResolvedValue("gentle"), set: vi.fn().mockResolvedValue("gentle") };
	const hook = renderHook(({ client }) => useCompanion(client), { initialProps: { client: first } });
	await act(async () => {});
	let pending: Promise<void>;
	act(() => {
		pending = hook.result.current.setMode("capri");
	});
	hook.rerender({ client: second });
	await act(async () => {});
	expect(hook.result.current.pending).toBe(false);
	await act(async () => {
		finish("capri");
		await pending;
	});
	expect(hook.result.current.settings.mode).toBe("gentle");
});

it("keeps an in-memory choice when storage is blocked and validates old preferences", async () => {
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new Error("denied");
	});
	const { result } = renderHook(() => useCompanion());
	await act(async () => result.current.setMode("capri"));
	expect(result.current.settings.mode).toBe("capri");
	expect(result.current.storageFailed).toBe(true);
	expect(parseCompanion({ mode: "unknown", form: "url(secret)", side: "bad" })).toMatchObject({
		mode: "gentle",
		form: "auto",
		side: "auto",
	});
});

it("reacts locally to typing without passing draft content to a client", async () => {
	function Fixture() {
		const controls = useCompanion();
		return (
			<>
				<CompanionSwitch controls={controls} />
				<textarea aria-label="Mensaje" />
				<CapriCompanion controls={controls} state="idle" connected />
			</>
		);
	}
	render(<Fixture />);
	await act(async () => fireEvent.click(screen.getByRole("switch")));
	fireEvent.input(screen.getByRole("textbox"), { target: { value: "Un borrador privado" } });
	expect(screen.getByLabelText("Capri, tu acompañante")).toHaveTextContent("A tu ritmo");
	expect(document.querySelector(".capri-float .capri-sprite")).toHaveAttribute("data-pose", "eyes");
	expect(localStorage.getItem(COMPANION_KEY)).not.toContain("borrador");
});

it("migrates old manual direction while preserving pauses, visibility and placement", () => {
	expect(
		parseCompanion({
			mode: "capri",
			form: "hands",
			scene: "crying",
			company: "rebecca",
			side: "left",
			motion: false,
			visible: false,
			position: { x: 0.25, y: 0.7 },
			ambience: "hacker",
		}),
	).toMatchObject({
		mode: "capri",
		form: "auto",
		scene: "auto",
		company: "visits",
		side: "auto",
		motion: false,
		visible: false,
		position: { x: 0.25, y: 0.7 },
		ambience: "hacker",
	});
});

it("persists independent pin and area preferences, validating corrupt input", () => {
	const { result, unmount } = renderHook(() => useCompanion());
	act(() => result.current.change({ pinned: true, space: { x: 0.5, y: 0, width: 0.5, height: 1 } }));
	expect(result.current.settings.motion).toBe(true);
	unmount();
	const restored = renderHook(() => useCompanion());
	expect(restored.result.current.settings).toMatchObject({
		pinned: true,
		space: { x: 0.5, y: 0, width: 0.5, height: 1 },
	});
	expect(parseCompanion({ space: { x: -1, y: Infinity, width: NaN, height: 8 } }).space).toEqual({
		x: 0,
		y: 0,
		width: 1,
		height: 1,
	});
});
