import { useEffect, useRef, useState } from "react";
import type { NotificationPreferences } from "../../../packages/ui/src/mobile.ts";
import {
	GentleMobile,
	nativeAndroid,
	readNotificationPreferences,
	saveNotificationPreferences,
} from "./native.ts";
import type { Connection } from "./pairing.ts";

function AlertSwitch({
	title,
	detail,
	checked,
	disabled,
	onChange,
}: {
	title: string;
	detail?: string;
	checked: boolean;
	disabled?: boolean;
	onChange(): void;
}) {
	return (
		<button
			type="button"
			className="mobile-alert-switch"
			role="switch"
			aria-checked={checked}
			aria-label={title}
			disabled={disabled}
			onClick={onChange}
		>
			<span>
				<strong>{title}</strong>
				{detail ? <small>{detail}</small> : null}
			</span>
			<span className="mobile-switch-track" aria-hidden="true">
				<span />
			</span>
		</button>
	);
}

/** Alert delivery is phone-local; summaries use a separate, explicit computer setting. */
export function NotificationSettings({
	connection,
	monitoring,
	monitorBusy,
	onToggleMonitor,
}: {
	connection: Connection;
	monitoring: boolean;
	monitorBusy: boolean;
	onToggleMonitor(): void;
}) {
	const [preferences, setPreferences] = useState<NotificationPreferences>();
	const [enabled, setEnabled] = useState<boolean>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [reportError, setReportError] = useState<string>();
	const [retry, setRetry] = useState(0);
	const [delivery, setDelivery] = useState<{ connected?: boolean; notificationsEnabled?: boolean }>();
	const generation = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Refresh immediately after the user starts or stops monitoring.
	useEffect(() => {
		if (!nativeAndroid) return;
		let alive = true;
		const refresh = () =>
			void GentleMobile.monitorState()
				.then((value) => {
					if (alive) setDelivery(value);
				})
				.catch(() => {
					if (alive) setDelivery(undefined);
				});
		refresh();
		const timer = window.setInterval(refresh, 10_000);
		window.addEventListener("gentledot-resume", refresh);
		return () => {
			alive = false;
			window.clearInterval(timer);
			window.removeEventListener("gentledot-resume", refresh);
		};
	}, [monitoring]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Retry reloads saved settings.
	useEffect(() => {
		const controller = new AbortController();
		generation.current++;
		setError(undefined);
		setReportError(undefined);
		setEnabled(undefined);
		if (nativeAndroid)
			void readNotificationPreferences()
				.then((value) => {
					if (!controller.signal.aborted) setPreferences(value);
				})
				.catch(() => {
					if (!controller.signal.aborted) setError("No se pudieron cargar tus alertas.");
				});
		void fetch(`${connection.url}/api/mobile/completions`, {
			headers: { Authorization: `Bearer ${connection.token}` },
			redirect: "error",
			cache: "no-store",
			signal: controller.signal,
		})
			.then(async (response) => {
				if (!response.ok)
					throw new Error("No se pudieron consultar los resúmenes. Revisa la conexión con tu equipo.");
				const body = await response.json();
				if (typeof body.enabled !== "boolean") throw new Error("La configuración recibida no es válida.");
				if (!controller.signal.aborted) setEnabled(body.enabled);
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted)
					setReportError(cause instanceof Error ? cause.message : "No se pudo consultar la configuración.");
			});
		return () => {
			controller.abort();
			generation.current++;
		};
	}, [connection, retry]);
	const change = async (key: keyof NotificationPreferences) => {
		if (!preferences || busy) return;
		const current = generation.current;
		setBusy(true);
		setError(undefined);
		try {
			const saved = await saveNotificationPreferences({ ...preferences, [key]: !preferences[key] });
			if (current === generation.current) setPreferences(saved);
		} catch {
			if (current === generation.current) setError("No se pudo guardar el cambio. Inténtalo de nuevo.");
		} finally {
			if (current === generation.current) setBusy(false);
		}
	};
	const changeReports = async () => {
		if (enabled === undefined || busy) return;
		const current = generation.current;
		setBusy(true);
		setReportError(undefined);
		try {
			const response = await fetch(`${connection.url}/api/mobile/completions`, {
				method: "POST",
				headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: !enabled }),
				redirect: "error",
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) throw new Error("No se pudo guardar la opción de resúmenes.");
			const body = await response.json();
			if (typeof body.enabled !== "boolean") throw new Error("La configuración recibida no es válida.");
			if (current === generation.current) setEnabled(body.enabled);
		} catch (cause) {
			if (current === generation.current)
				setReportError(cause instanceof Error ? cause.message : "No se pudo guardar la configuración.");
		} finally {
			if (current === generation.current) setBusy(false);
		}
	};
	const toggle = (key: keyof NotificationPreferences, title: string, detail?: string) => (
		<AlertSwitch
			key={key}
			title={title}
			detail={detail}
			checked={preferences?.[key] ?? false}
			disabled={busy || preferences === undefined}
			onChange={() => void change(key)}
		/>
	);
	return (
		<section className="mobile-notification-settings" aria-label="Alertas">
			<h3>Alertas</h3>
			{nativeAndroid ? (
				<>
					<AlertSwitch
						title="Con la app cerrada"
						detail="Recibe avisos con la pantalla apagada. Se reconecta al recuperar la red."
						checked={monitoring}
						disabled={monitorBusy}
						onChange={onToggleMonitor}
					/>
					<p className="mobile-setting-hint" role="status">
						{delivery?.notificationsEnabled === false
							? "Android tiene bloqueadas las notificaciones. Actívalas en Ajustes de Android."
							: monitoring
								? delivery?.connected
									? "Avisos conectados con tu equipo."
									: "Reconectando avisos. Comprueba que Tailscale esté activo y el equipo encendido."
								: "Activa esta opción para recibir respuestas fuera de la app."}
					</p>
					{toggle("inApp", "Mientras uso Dot", "Avisos breves que desaparecen solos.")}
					<p className="mobile-setting-hint">
						Esto cambia tus avisos. Dot sigue trabajando en el equipo según las instrucciones que le des.
					</p>
					<details className="mobile-alert-group">
						<summary>Dot</summary>
						{toggle("dotReplies", "Respuestas de Dot")}
						{toggle("dotErrors", "Problemas de Dot", "Cuando necesita que intervengas.")}
						{toggle(
							"permissions",
							"Solicitudes de permiso",
							"De Dot y tus sesiones. Si lo silencias, podrás resolverlas desde sus tarjetas.",
						)}
					</details>
					<details className="mobile-alert-group">
						<summary>Sesiones</summary>
						{toggle("agentCompleted", "Nuevas respuestas", "Cuando un agente termina su turno.")}
						{toggle("agentAttention", "Necesita tu atención")}
						{toggle("agentErrors", "Errores de conexión")}
						{toggle(
							"agentAvailable",
							"Cambios de disponibilidad",
							"Avisos de estado sin una nueva respuesta.",
						)}
					</details>
					<details className="mobile-alert-group">
						<summary>Sonido y privacidad</summary>
						{toggle("sound", "Sonido")}
						{toggle("vibration", "Vibración")}
						{toggle("preview", "Contenido en pantalla bloqueada")}
						<p className="mobile-setting-hint">
							Android y el modo No molestar tienen la última palabra sobre sonido y vibración.
						</p>
						<button
							type="button"
							className="mobile-alert-system"
							onClick={() =>
								void GentleMobile.openNotificationSettings().catch(() =>
									setError("No se pudieron abrir los ajustes de Android."),
								)
							}
						>
							Ajustes de Android
						</button>
					</details>
				</>
			) : null}
			<details className="mobile-alert-group">
				<summary>Resúmenes de sesiones</summary>
				<AlertSwitch
					title="Resúmenes en Dot"
					detail="Dot revisa las respuestas de tus agentes y te propone cómo seguir."
					checked={enabled === true}
					disabled={busy || enabled === undefined}
					onChange={() => void changeReports()}
				/>
				<p className="mobile-setting-hint">
					Se aplica al equipo y usa el modelo de Dot. La continuación automática depende del objetivo y de lo
					que hayas autorizado.
				</p>
				{reportError ? (
					<p role="alert" className="mobile-error">
						{reportError}
						<button type="button" disabled={busy} onClick={() => setRetry((value) => value + 1)}>
							Reintentar
						</button>
					</p>
				) : null}
			</details>
			{error ? (
				<p role="alert" className="mobile-error">
					{error}
					{!preferences ? (
						<button type="button" disabled={busy} onClick={() => setRetry((value) => value + 1)}>
							Reintentar
						</button>
					) : null}
				</p>
			) : null}
		</section>
	);
}
