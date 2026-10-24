import { useEffect, useRef, useState } from "react";
import type { ComputerSnapshot, OrchestrationClient } from "../orchestration.ts";

/** Mounted only in the expanded settings section; no background desktop polling while chatting. */
export function RemoteComputerCard({ client }: { client: OrchestrationClient }) {
	const [status, setStatus] = useState<ComputerSnapshot>();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [revision, setRevision] = useState(0);
	const current = useRef(client);
	const epoch = useRef(0);
	const stopping = useRef(false);
	current.current = client;
	useEffect(() => {
		void revision;
		setBusy(false);
		stopping.current = false;
		setStatus(undefined);
		setError(undefined);
		const abort = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const read = async () => {
			const generation = epoch.current;
			try {
				if (document.visibilityState === "hidden" || stopping.current) return;
				const next = await client.computerStatus?.(abort.signal);
				if (!abort.signal.aborted && generation === epoch.current) {
					setStatus(next);
					setError(undefined);
				}
			} catch (problem) {
				if (!abort.signal.aborted && generation === epoch.current)
					setError(problem instanceof Error ? problem.message : "No se pudo consultar el equipo.");
			} finally {
				if (!abort.signal.aborted) timer = setTimeout(() => void read(), 5000);
			}
		};
		void read();
		return () => {
			abort.abort();
			clearTimeout(timer);
		};
	}, [client, revision]);
	async function stop() {
		if (stopping.current || !client.stopComputer) return;
		stopping.current = true;
		epoch.current++;
		setBusy(true);
		try {
			const next = await client.stopComputer();
			if (current.current === client) {
				setStatus(next);
				setError(undefined);
			}
		} catch (problem) {
			if (current.current === client)
				setError(problem instanceof Error ? problem.message : "No se pudo detener el control.");
		} finally {
			if (current.current === client) {
				stopping.current = false;
				setBusy(false);
			}
		}
	}
	const ready =
		status?.available &&
		status.permissions.accessibility &&
		status.permissions.screenRecording &&
		status.permissions.screenshotsSupported &&
		status.capabilities?.supported !== false;
	return (
		<section className="orchestration-section card" aria-label="Control del equipo">
			<div className="orchestration-heading">
				<div>
					<h3>Control del equipo</h3>
					<p className="muted" role="status">
						{status?.state.active
							? "Dot está controlando el escritorio"
							: ready
								? "Listo cuando lo necesites"
								: status
									? "Requiere preparación en el equipo"
									: "Comprobando conexión…"}
					</p>
				</div>
			</div>
			<p className="muted">
				Pide en el chat que use una aplicación o tu navegador abierto. Las solicitudes de acceso aparecerán en
				tu teléfono.
			</p>
			{status?.capabilities?.missingDependencies.length ? (
				<p className="muted">
					Falta instalar en el equipo: {status.capabilities.missingDependencies.join(", ")}
				</p>
			) : null}
			{status?.platform === "macos" && !ready ? (
				<p className="muted">En el Mac, permite Accesibilidad y Grabación de pantalla para Gentle Dot.</p>
			) : null}
			{status?.capabilities?.limitations.length ? (
				<details>
					<summary>Compatibilidad</summary>
					{status.capabilities.limitations.map((message) => (
						<p className="muted" key={message}>
							{message}
						</p>
					))}
				</details>
			) : null}
			{error ? (
				<p className="orchestration-error" role="alert">
					{error}
				</p>
			) : null}
			<div className="provider-actions">
				<button type="button" disabled={busy} onClick={() => setRevision((value) => value + 1)}>
					Comprobar
				</button>
				<button type="button" className="browser-stop" disabled={busy} onClick={() => void stop()}>
					{busy ? "Deteniendo…" : "Detener control del equipo"}
				</button>
			</div>
		</section>
	);
}
