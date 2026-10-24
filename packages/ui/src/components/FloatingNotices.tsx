import { useEffect, useRef, useState } from "react";
import {
	DEFAULT_NOTIFICATION_PREFERENCES,
	type MobileNotification,
	mobileBridge,
	type NotificationEvent,
	type NotificationPreferences,
} from "../mobile.ts";
import type { Notice } from "../store.ts";
import "../floating-notices.css";

const PREFERENCE: Record<NotificationEvent, keyof NotificationPreferences> = {
	dotReply: "dotReplies",
	dotError: "dotErrors",
	agentCompleted: "agentCompleted",
	agentAttention: "agentAttention",
	agentError: "agentErrors",
	agentAvailable: "agentAvailable",
	permission: "permissions",
};
export type NoticeSession = { paneId: string; sessionId?: string };
const COMPLETION = new Set<NotificationEvent>(["agentCompleted", "agentAvailable"]);
function alreadyReading(
	event: NotificationEvent | undefined,
	target?: NoticeSession,
	visible?: NoticeSession,
) {
	return Boolean(
		event &&
			COMPLETION.has(event) &&
			target?.sessionId &&
			target.paneId === visible?.paneId &&
			target.sessionId === visible.sessionId,
	);
}

const COMPACT_TITLES: Partial<Record<NotificationEvent, string>> = {
	agentCompleted: "Respuesta lista",
	agentAvailable: "Sesión disponible",
	agentError: "Sesión desconectada",
	agentAttention: "Una sesión te necesita",
	permission: "Permiso pendiente",
};
// Omit only our known boilerplate; meaningful permission/error text stays visible.
const GENERIC_COPY = new Set([
	"La respuesta está lista en Sesiones.",
	"El agente está listo para continuar.",
	"Revisa su conexión en Sesiones.",
	"Abre Sesiones para ver qué necesita.",
	"Puedes responder desde Sesiones.",
	"Hay una nueva respuesta en tu sesión.",
	"Puedes continuar la conversación.",
	"Abre Sesiones para revisar el estado.",
]);
export function noticeEnabled(
	event: NotificationEvent | undefined,
	prefs: NotificationPreferences,
	chatVisible: boolean,
) {
	return prefs.inApp && (!event || prefs[PREFERENCE[event]]) && !(event === "dotReply" && chatVisible);
}

/** Ephemeral overlays never change the chat's layout or scroll position. */
export function FloatingNotices({
	notices,
	dismiss,
	mobile,
	chatVisible = false,
	visibleSession,
	onOpenSession,
}: {
	notices: Notice[];
	dismiss(id: number): void;
	mobile: boolean;
	chatVisible?: boolean;
	visibleSession?: NoticeSession | undefined;
	onOpenSession?: (session: NoticeSession) => void;
}) {
	const [preferences, setPreferences] = useState(DEFAULT_NOTIFICATION_PREFERENCES);
	const [ready, setReady] = useState(!mobileBridge()?.notificationPreferences);
	const [external, setExternal] = useState<MobileNotification>();
	const seen = useRef(new Set<string>());
	const presented = useRef<string | undefined>(undefined);
	const dismissRef = useRef(dismiss);
	dismissRef.current = dismiss;
	useEffect(() => {
		let live = true;
		const bridge = mobileBridge();
		let updated = false;
		const unsubscribe = bridge?.subscribeNotificationPreferences?.((next) => {
			updated = true;
			if (live) {
				setPreferences(next);
				setReady(true);
			}
		});
		void bridge
			?.notificationPreferences?.()
			.then((next) => {
				if (live && !updated) setPreferences(next);
			})
			.catch(() => {})
			.finally(() => {
				if (live) setReady(true);
			});
		if (!bridge?.notificationPreferences) setReady(true);
		const receive = (event: Event) => {
			const detail = (event as CustomEvent<MobileNotification>).detail;
			if (
				!detail ||
				typeof detail.id !== "string" ||
				typeof detail.title !== "string" ||
				typeof detail.body !== "string" ||
				(detail.event !== undefined && !Object.hasOwn(PREFERENCE, detail.event)) ||
				(detail.session !== undefined &&
					(typeof detail.session?.paneId !== "string" ||
						(detail.session.sessionId !== undefined && typeof detail.session.sessionId !== "string"))) ||
				seen.current.has(detail.id)
			)
				return;
			seen.current.add(detail.id);
			if (seen.current.size > 512) seen.current.delete(seen.current.values().next().value as string);
			if (document.visibilityState !== "hidden") setExternal(detail);
		};
		window.addEventListener("gentledot-notification", receive);
		return () => {
			live = false;
			unsubscribe?.();
			window.removeEventListener("gentledot-notification", receive);
		};
	}, []);
	const eligible =
		ready && document.visibilityState !== "hidden"
			? notices.filter(
					(notice) =>
						noticeEnabled(notice.notificationEvent, preferences, chatVisible) &&
						!alreadyReading(notice.notificationEvent, notice.session, visibleSession) &&
						(!notice.notificationId ||
							!seen.current.has(notice.notificationId) ||
							presented.current === notice.notificationId),
				)
			: [];
	const latest = eligible.at(-1);
	const visibleExternal =
		ready &&
		external &&
		noticeEnabled(external.event, preferences, chatVisible) &&
		!alreadyReading(external.event, external.session, visibleSession)
			? external
			: undefined;
	useEffect(() => {
		if (!ready) return;
		presented.current = visibleExternal ? undefined : latest?.notificationId;
		if (presented.current) {
			seen.current.add(presented.current);
			if (seen.current.size > 512) seen.current.delete(seen.current.values().next().value as string);
		}
		for (const notice of notices) {
			if (notice.id !== latest?.id || visibleExternal) {
				// A reply already being read is consumed too; another delivery must not replay it after navigation.
				if (notice.notificationId) seen.current.add(notice.notificationId);
				dismissRef.current(notice.id);
			}
		}
		while (seen.current.size > 512) seen.current.delete(seen.current.values().next().value as string);
		if (external && !visibleExternal) setExternal(undefined);
	}, [notices, latest?.id, latest?.notificationId, ready, external, visibleExternal]);
	const notice = visibleExternal
		? {
				key: visibleExternal.id,
				title: visibleExternal.title,
				message: visibleExternal.body,
				event: visibleExternal.event,
				session: visibleExternal.session,
				level: "info" as const,
				close: () => setExternal(undefined),
			}
		: latest
			? {
					key: String(latest.id),
					title: latest.title,
					message: latest.message,
					event: latest.notificationEvent,
					session: latest.session,
					level: latest.level,
					close: () => dismissRef.current(latest.id),
				}
			: undefined;
	if (!notice) return null;
	return (
		<div className={`floating-notices${mobile ? " floating-notices-mobile" : ""}`}>
			<NoticePopup
				mobile={mobile}
				key={notice.key}
				title={notice.event ? (COMPACT_TITLES[notice.event] ?? notice.title) : notice.title}
				message={notice.event && GENERIC_COPY.has(notice.message) ? "" : notice.message}
				event={notice.event}
				level={notice.level}
				open={
					notice.session && onOpenSession
						? () => {
								onOpenSession(notice.session as NoticeSession);
								notice.close();
							}
						: undefined
				}
				close={notice.close}
			/>
		</div>
	);
}

function NoticePopup({
	title,
	message,
	close,
	mobile,
	event,
	level,
	open,
}: {
	title?: string;
	message: string;
	close(): void;
	mobile: boolean;
	event?: NotificationEvent | undefined;
	level: Notice["level"];
	open?: (() => void) | undefined;
}) {
	const closeRef = useRef(close);
	closeRef.current = close;
	const [paused, setPaused] = useState(false);
	useEffect(() => {
		if (paused) return;
		const timer = setTimeout(
			() => closeRef.current(),
			event === "permission" || level !== "info" ? 5_000 : 3_500,
		);
		return () => clearTimeout(timer);
	}, [paused, event, level]);
	useEffect(() => {
		const hide = () => {
			if (document.visibilityState === "hidden") closeRef.current();
		};
		document.addEventListener("visibilitychange", hide);
		return () => document.removeEventListener("visibilitychange", hide);
	}, []);
	const tone =
		event === "agentCompleted" || event === "dotReply"
			? "success"
			: event === "agentError" || event === "dotError" || level === "error"
				? "error"
				: event === "permission" || event === "agentAttention" || level === "warning"
					? "attention"
					: "info";
	const copy = (
		<span className="floating-notice-copy" role="status" aria-live="polite" aria-atomic="true">
			{title ? <strong>{title}</strong> : null}
			{message ? <span className="floating-notice-message">{message}</span> : null}
		</span>
	);
	return (
		<section
			className={`floating-notice floating-notice-${tone}`}
			aria-label="Aviso"
			onPointerEnter={(event) => {
				if (event.pointerType === "mouse") setPaused(true);
			}}
			onPointerLeave={() => setPaused(false)}
			onFocus={() => setPaused(true)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
			}}
		>
			<span className="floating-notice-icon" aria-hidden="true">
				<svg
					aria-hidden="true"
					viewBox="0 0 24 24"
					width="20"
					height="20"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.8"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					{tone === "success" ? (
						<path d="m5 12 4 4L19 6" />
					) : tone === "attention" ? (
						<>
							<path d="M8 10V7a4 4 0 0 1 8 0v3" />
							<rect x="5" y="10" width="14" height="11" rx="3" />
							<path d="M12 14v3" />
						</>
					) : tone === "error" ? (
						<>
							<circle cx="12" cy="12" r="9" />
							<path d="M12 7v6m0 4h.01" />
						</>
					) : (
						<>
							<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z" />
							<path d="M8 11h8" />
						</>
					)}
				</svg>
			</span>
			{open ? (
				<button
					type="button"
					className="floating-notice-open"
					onClick={open}
					aria-label={`${title ?? "Aviso"} · Abrir sesión`}
				>
					{copy}
				</button>
			) : (
				copy
			)}
			<button
				className="floating-notice-dismiss"
				type="button"
				aria-label={mobile ? "Descartar aviso" : "Dismiss"}
				onClick={close}
			>
				<svg
					aria-hidden="true"
					viewBox="0 0 24 24"
					width="20"
					height="20"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.8"
				>
					<path d="m6 6 12 12M6 18 18 6" />
				</svg>
			</button>
		</section>
	);
}
