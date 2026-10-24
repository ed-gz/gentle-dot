import { useEffect, useId, useRef, useState } from "react";
import type {
	BrowserHumanAction,
	BrowserInstallation,
	BrowserPage,
	BrowserStatus,
	OrchestrationClient,
} from "../orchestration.ts";

export function BrowserCard({ client }: { client: OrchestrationClient }) {
	const [status, setStatus] = useState<BrowserStatus>();
	const [page, setPage] = useState<BrowserPage>();
	const [error, setError] = useState<string>();
	const [connectionError, setConnectionError] = useState<string>();
	const [expanded, setExpanded] = useState(false);
	const [minutes, setMinutes] = useState(0);
	const [window, setWindow] = useState(false);
	const [consent, setConsent] = useState(false);
	const [busy, setBusy] = useState<string>();
	const [installation, setInstallation] = useState<BrowserInstallation>();
	const [cancelling, setCancelling] = useState(false);
	const [cancelRequested, setCancelRequested] = useState(false);
	const operation = useRef<AbortController | undefined>(undefined);
	const cancellingNow = useRef(false);
	const pendingNow = useRef(false);
	const activeClient = useRef(client);
	const verified = useRef<OrchestrationClient | undefined>(undefined);
	activeClient.current = client;
	const installing = busy === "install_browser" || installation?.status === "pending";
	const sequence = useRef(0);
	const id = useId();
	useEffect(() => {
		if (activeClient.current === client) {
			setStatus(undefined);
			setPage(undefined);
			setInstallation(undefined);
			setConsent(false);
			setError(undefined);
			setConnectionError(undefined);
			setBusy(undefined);
			setCancelling(false);
			setCancelRequested(false);
			pendingNow.current = false;
			cancellingNow.current = false;
		}
		return () => {
			operation.current?.abort();
			sequence.current++;
		};
	}, [client]);

	useEffect(() => {
		if (!client.browserStatus || busy) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		const refresh = async () => {
			try {
				const next = await client.browserStatus?.(controller.signal);
				if (!controller.signal.aborted && activeClient.current === client && next) {
					verified.current = client;
					setStatus(next);
					if (next.installation) setInstallation(next.installation);
					setConnectionError(undefined);
					if (!next.active) setPage(undefined);
				}
			} catch (problem) {
				if (!controller.signal.aborted)
					setConnectionError(
						problem instanceof Error ? problem.message : "No se pudo consultar el navegador.",
					);
			} finally {
				if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 5000);
			}
		};
		void refresh();
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [client, busy]);

	async function act(action: BrowserHumanAction) {
		if (
			!client.browserAction ||
			verified.current !== client ||
			(pendingNow.current && action.action !== "stop")
		)
			return;
		if (installing && action.action !== "stop") return;
		pendingNow.current = true;
		const controller = new AbortController();
		operation.current = controller;
		const current = ++sequence.current;
		setBusy(action.action);
		setError(undefined);
		if (action.action === "install_browser") {
			setInstallation(undefined);
			setCancelRequested(false);
		}
		if (action.action === "stop") {
			setPage(undefined);
			setConsent(false);
		}
		try {
			const next = await client.browserAction(action, controller.signal);
			if (sequence.current !== current || activeClient.current !== client || controller.signal.aborted)
				return;
			if (action.action === "start") setConsent(false);
			if ("active" in next) setStatus(next);
			else if ("status" in next) setInstallation(next);
			else setPage(next);
		} catch (problem) {
			if (sequence.current === current && activeClient.current === client && !controller.signal.aborted)
				setError(problem instanceof Error ? problem.message : "No se pudo completar la acción.");
		} finally {
			if (sequence.current === current && activeClient.current === client) {
				pendingNow.current = false;
				setBusy(undefined);
			}
		}
	}

	async function cancelInstallation() {
		if (!client.browserAction || verified.current !== client || cancellingNow.current) return;
		cancellingNow.current = true;
		setCancelling(true);
		try {
			const next = await client.browserAction({ action: "stop" });
			if (activeClient.current !== client) return;
			if ("active" in next) {
				setStatus(next);
				if (next.installation) setInstallation(next.installation);
			}
			setCancelRequested(true);
		} catch (problem) {
			if (activeClient.current === client)
				setError(
					problem instanceof Error
						? problem.message
						: "No se pudo solicitar la cancelación. Revisa el equipo.",
				);
		} finally {
			if (activeClient.current === client) {
				cancellingNow.current = false;
				setCancelling(false);
			}
		}
	}

	return (
		<section className="orchestration-section card browser-card" aria-label="Navegador de Gentle Dot">
			<div className="orchestration-heading">
				<div>
					<h3>Navegación web</h3>
					<p className="muted" role="status">
						{installing
							? "Instalación en curso"
							: busy === "start"
								? "Abriendo navegador…"
								: status?.active
									? status.expiresAt
										? `Activo hasta ${new Date(status.expiresAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}`
										: "Acceso activado"
									: status?.available
										? "Listo para activar"
										: status
											? "No disponible"
											: "Comprobando conexión…"}
					</p>
				</div>
				<button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
					{expanded ? "Ocultar navegador" : "Ver navegador"}
				</button>
			</div>
			{error || connectionError ? (
				<p className="orchestration-error" role="alert">
					{error || connectionError}
				</p>
			) : null}
			{status?.reason ? <p className="muted">{status.reason}</p> : null}
			{installing ? (
				<section className="browser-installation" aria-label="Instalación en el equipo">
					<p role="status">
						{cancelRequested
							? "Cancelación solicitada. Si la instalación ya comenzó, el sistema terminará ese paso."
							: "Confirma la instalación en el equipo. La contraseña se escribe únicamente en el diálogo del sistema; Dot no la recibe."}
					</p>
					<button
						type="button"
						disabled={cancelling || cancelRequested}
						onClick={() => void cancelInstallation()}
					>
						{cancelling ? "Solicitando cancelación…" : "Cancelar solicitud"}
					</button>
				</section>
			) : installation ? (
				<p className="browser-installation-result" role="status">
					{installation.message}
				</p>
			) : null}
			{status?.active || (busy && busy !== "install_browser") ? (
				<button
					type="button"
					className="browser-stop"
					disabled={busy === "stop"}
					onClick={() => void act({ action: "stop" })}
				>
					{busy === "stop" ? "Deteniendo…" : "Detener navegador y revocar acceso"}
				</button>
			) : null}
			{expanded ? (
				<>
					<p className="orchestration-intro">
						Permite a Dot abrir páginas y completar tareas web. Puedes revocar el acceso cuando quieras.
					</p>
					{!status?.available && !installing && status?.canRequestInstall ? (
						<div className="browser-installation">
							<p className="muted">
								Chromium se instala en tu equipo. Si el sistema pide una contraseña, introdúcela allí.
							</p>
							<button
								type="button"
								disabled={Boolean(busy) || Boolean(connectionError)}
								onClick={() =>
									void act({
										action: "install_browser",
										reason: "Quiero habilitar el navegador de Gentle Dot.",
									})
								}
							>
								Instalar Chromium en el equipo
							</button>
						</div>
					) : null}
					{!status?.active && status?.available && !installing ? (
						<form
							className="orchestration-form"
							onSubmit={(event) => {
								event.preventDefault();
								if (consent && status?.available && !connectionError)
									void act({ action: "start", ...(minutes ? { minutes } : {}), window });
							}}
						>
							<details className="browser-about">
								<summary>Limitar duración</summary>
								<label htmlFor={`${id}-duration`}>Desactivar automáticamente</label>
								<select
									id={`${id}-duration`}
									value={minutes}
									disabled={Boolean(busy)}
									onChange={(event) => setMinutes(Number(event.target.value))}
								>
									<option value={0}>Cuando yo lo desactive</option>
									<option value={30}>30 minutos</option>
									<option value={60}>1 hora</option>
									<option value={480}>8 horas</option>
								</select>
							</details>
							<label className="agent-consent">
								<input
									type="checkbox"
									checked={window}
									disabled={Boolean(busy)}
									onChange={(event) => setWindow(event.target.checked)}
								/>
								Mostrar una ventana en el equipo para iniciar sesión
							</label>
							<label className="agent-consent">
								<input
									type="checkbox"
									checked={consent}
									disabled={Boolean(busy)}
									onChange={(event) => setConsent(event.target.checked)}
								/>
								Permitir que Dot use este navegador.
							</label>
							<button
								type="submit"
								className="primary"
								disabled={
									!consent || !status?.available || Boolean(connectionError) || Boolean(busy) || installing
								}
							>
								Activar navegador
							</button>
						</form>
					) : status?.active ? (
						<>
							<p className="muted">Pide la tarea en el chat. Puedes revisar las páginas aquí.</p>
							<ul className="browser-tabs">
								{status.tabs.map((tab) => (
									<li key={tab.id}>
										<div>
											<strong>{tab.title}</strong>
											<span className="agent-folder">{tab.url}</span>
										</div>
										<button
											type="button"
											disabled={Boolean(busy) || Boolean(connectionError)}
											onClick={() => void act({ action: "snapshot", tabId: tab.id, screenshot: true })}
										>
											Ver página<span className="sr-only">: {tab.title}</span>
										</button>
									</li>
								))}
							</ul>
							{page ? (
								<figure className="browser-preview">
									<figcaption>{page.title}</figcaption>
									{page.image ? (
										<img
											src={`data:${page.image.mime};base64,${page.image.data}`}
											alt={`Vista de ${page.title}`}
										/>
									) : null}
									<details>
										<summary>Texto de la página</summary>
										<p>{page.text || "Esta página no tiene texto visible."}</p>
									</details>
									<p className="muted">
										Vista tomada al solicitarla. Vuelve a pulsar «Ver página» para actualizar.
									</p>
								</figure>
							) : null}
						</>
					) : null}
					<details className="browser-about">
						<summary>Qué puede controlar</summary>
						<p className="muted">
							Puede leer páginas y completar formularios. Usa un perfil separado de tus pestañas personales.
							El control general del escritorio depende de la aplicación de escritorio y su sistema operativo.
						</p>
					</details>
				</>
			) : null}
		</section>
	);
}
