import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FloatingNotices } from "../src/components/FloatingNotices.tsx";
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from "../src/mobile.ts";
import type { Notice } from "../src/store.ts";

afterEach(() => {
	vi.useRealTimers();
	delete window.__GENTLE_MOBILE__;
});
const done: Notice = {
	id: 1,
	level: "info",
	message: "Tu revisión terminó.",
	notificationEvent: "agentCompleted",
};
it("floats briefly and dismisses without repeating snapshot notices", () => {
	vi.useFakeTimers();
	const dismiss = vi.fn();
	const view = render(<FloatingNotices notices={[done]} dismiss={dismiss} mobile />);
	expect(screen.getByRole("status")).toHaveTextContent("Tu revisión terminó.");
	act(() => vi.advanceTimersByTime(2_500));
	expect(dismiss).not.toHaveBeenCalled();
	view.rerender(<FloatingNotices notices={[{ ...done }]} dismiss={dismiss} mobile />);
	act(() => vi.advanceTimersByTime(1_000));
	expect(dismiss).toHaveBeenCalledWith(1);
});

it("keeps completion silent for the session being read, but preserves permissions and other sessions", () => {
	const session = { paneId: "pane-a", sessionId: "session-a" };
	const dismiss = vi.fn();
	const view = render(
		<FloatingNotices notices={[{ ...done, session }]} dismiss={dismiss} mobile visibleSession={session} />,
	);
	expect(screen.queryByRole("status")).toBeNull();
	expect(dismiss).toHaveBeenCalledWith(1);
	view.rerender(
		<FloatingNotices
			notices={[{ ...done, id: 2, session: { ...session, sessionId: "session-b" } }]}
			dismiss={dismiss}
			mobile
			visibleSession={session}
		/>,
	);
	expect(screen.getByRole("status")).toHaveTextContent("Respuesta lista");
	view.rerender(
		<FloatingNotices
			notices={[{ ...done, id: 3, session, notificationEvent: "permission" }]}
			dismiss={dismiss}
			mobile
			visibleSession={session}
		/>,
	);
	expect(screen.getByRole("status")).toHaveTextContent("Permiso pendiente");
	view.rerender(
		<FloatingNotices
			notices={[{ ...done, id: 4, session, notificationEvent: "agentAttention" }]}
			dismiss={dismiss}
			mobile
			visibleSession={session}
		/>,
	);
	// Session questions arrive as agentAttention; name them as questions, not finished work.
	expect(screen.getByRole("status")).toHaveTextContent("Pregunta pendiente");
});

it("opens the specific notified session and hides only repetitive generic copy", () => {
	const session = { paneId: "pane-a", sessionId: "session-a" };
	const open = vi.fn();
	const dismiss = vi.fn();
	render(
		<FloatingNotices
			notices={[{ ...done, session, message: "La respuesta está lista en Sesiones." }]}
			dismiss={dismiss}
			mobile
			onOpenSession={open}
		/>,
	);
	expect(screen.queryByText("La respuesta está lista en Sesiones.")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Respuesta lista · Abrir sesión" }));
	expect(open).toHaveBeenCalledWith(session);
	expect(dismiss).toHaveBeenCalledWith(1);
});

it("does not replay a reply already read when the native delivery arrives after navigation", () => {
	const session = { paneId: "pane-a", sessionId: "session-a" };
	const dismiss = vi.fn();
	const view = render(
		<FloatingNotices
			notices={[{ ...done, notificationId: "reply-a", session }]}
			dismiss={dismiss}
			mobile
			visibleSession={session}
		/>,
	);
	expect(screen.queryByRole("status")).toBeNull();
	view.rerender(<FloatingNotices notices={[]} dismiss={dismiss} mobile chatVisible />);
	act(() =>
		window.dispatchEvent(
			new CustomEvent("gentledot-notification", {
				detail: {
					id: "reply-a",
					event: "agentCompleted",
					title: "Una sesión terminó",
					body: "La respuesta está lista en Sesiones.",
					session,
				},
			}),
		),
	);
	expect(screen.queryByRole("status")).toBeNull();
});

it("keeps the popup readable while focused and dismisses after focus leaves", () => {
	vi.useFakeTimers();
	const dismiss = vi.fn();
	render(<FloatingNotices notices={[done]} dismiss={dismiss} mobile />);
	fireEvent.focus(screen.getByRole("button", { name: "Descartar aviso" }));
	act(() => vi.advanceTimersByTime(10_000));
	expect(dismiss).not.toHaveBeenCalled();
	fireEvent.blur(screen.getByRole("button", { name: "Descartar aviso" }));
	act(() => vi.advanceTimersByTime(3_500));
	expect(dismiss).toHaveBeenCalledWith(1);
});
it("respects source preferences, defaults availability off, and doesn't announce a reply being read", async () => {
	let update!: (next: NotificationPreferences) => void;
	window.__GENTLE_MOBILE__ = {
		transcribe: vi.fn(),
		notificationPreferences: async () => ({ ...DEFAULT_NOTIFICATION_PREFERENCES, agentCompleted: false }),
		subscribeNotificationPreferences: (listener) => {
			update = listener;
			return vi.fn();
		},
	};
	const dismiss = vi.fn();
	const view = render(<FloatingNotices notices={[done]} dismiss={dismiss} mobile />);
	await act(async () => {});
	expect(screen.queryByRole("status")).toBeNull();
	expect(dismiss).toHaveBeenCalledWith(1);
	act(() => update(DEFAULT_NOTIFICATION_PREFERENCES));
	expect(screen.getByRole("status")).toBeVisible();
	view.rerender(
		<FloatingNotices
			notices={[{ ...done, id: 2, notificationEvent: "agentAvailable" }]}
			dismiss={dismiss}
			mobile
		/>,
	);
	expect(screen.queryByRole("status")).toBeNull();
	view.rerender(
		<FloatingNotices
			notices={[{ ...done, id: 3, notificationEvent: "dotReply" }]}
			dismiss={dismiss}
			mobile
			chatVisible
		/>,
	);
	expect(screen.queryByRole("status")).toBeNull();
});
it.each([
	["agentCompleted", "agentCompleted"],
	["agentAttention", "agentAttention"],
	["agentError", "agentErrors"],
	["dotError", "dotErrors"],
	["permission", "permissions"],
] as const)("gates native foreground %s by its event preference and inApp", async (event, preference) => {
	let update!: (next: NotificationPreferences) => void;
	window.__GENTLE_MOBILE__ = {
		transcribe: vi.fn(),
		notificationPreferences: async () => DEFAULT_NOTIFICATION_PREFERENCES,
		subscribeNotificationPreferences: (listener) => { update = listener; return vi.fn(); },
	};
	render(<FloatingNotices notices={[]} dismiss={vi.fn()} mobile />);
	await act(async () => {});
	const deliver = (id: string) => act(() => window.dispatchEvent(new CustomEvent("gentledot-notification", {
		detail: { id, title: "Aviso", body: "Detalle del evento", event, session: { paneId: "p", sessionId: "s" } },
	})));
	deliver("enabled");
	expect(screen.getByRole("status")).toHaveTextContent("Detalle del evento");
	act(() => update({ ...DEFAULT_NOTIFICATION_PREFERENCES, [preference]: false }));
	deliver("event-off");
	expect(screen.queryByRole("status")).toBeNull();
	act(() => update({ ...DEFAULT_NOTIFICATION_PREFERENCES, inApp: false }));
	deliver("in-app-off");
	expect(screen.queryByRole("status")).toBeNull();
});
it("deduplicates permission delivery from the native and web monitor and keeps controls independent", () => {
	const view = render(<FloatingNotices notices={[]} dismiss={vi.fn()} mobile />);
	const detail = {
		id: "dot-approval:1",
		title: "Dot necesita tu autorización",
		body: "Abrir navegador",
		event: "permission",
	};
	act(() => window.dispatchEvent(new CustomEvent("gentledot-notification", { detail })));
	expect(screen.getByRole("status")).toHaveTextContent("Abrir navegador");
	fireEvent.click(screen.getByRole("button", { name: "Descartar aviso" }));
	act(() => window.dispatchEvent(new CustomEvent("gentledot-notification", { detail })));
	expect(screen.queryByRole("status")).toBeNull();
	view.unmount();
});
it("does not replay a popup when returning from the background", () => {
	render(<FloatingNotices notices={[]} dismiss={vi.fn()} mobile />);
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
	act(() =>
		window.dispatchEvent(
			new CustomEvent("gentledot-notification", {
				detail: { id: "hidden", title: "Permiso", body: "Revisar", event: "permission" },
			}),
		),
	);
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
	fireEvent(document, new Event("visibilitychange"));
	expect(screen.queryByRole("status")).toBeNull();
});

it("deduplicates one app permission across the chat stream and the foreground broker", () => {
	const dismiss = vi.fn();
	const notice: Notice = { ...done, notificationEvent: "permission", notificationId: "dot-approval:one" };
	const view = render(<FloatingNotices notices={[notice]} dismiss={dismiss} mobile />);
	act(() =>
		window.dispatchEvent(
			new CustomEvent("gentledot-notification", {
				detail: {
					id: "dot-approval:one",
					title: "Broker",
					body: "Duplicate permission",
					event: "permission",
				},
			}),
		),
	);
	expect(screen.getByRole("status")).not.toHaveTextContent("Broker");
	fireEvent.click(screen.getByRole("button", { name: "Descartar aviso" }));
	view.rerender(<FloatingNotices notices={[]} dismiss={dismiss} mobile />);
	act(() =>
		window.dispatchEvent(
			new CustomEvent("gentledot-notification", {
				detail: {
					id: "dot-approval:one",
					title: "Broker",
					body: "Duplicate permission",
					event: "permission",
				},
			}),
		),
	);
	expect(screen.queryByRole("status")).toBeNull();
});
