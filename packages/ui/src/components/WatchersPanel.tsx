import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { WatchersAction, WatchersClient, WatchersSnapshot, WatchStatus } from "../watchers.ts";
import "../watchers.css";

const moment = (value: string) =>
	new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

/** Reads status only while visible. Monitoring itself belongs to the computer, never this screen. */
export function WatchersPanel({ client, connected = true }: { client: WatchersClient; connected?: boolean }) {
	const [stored, setStored] = useState<{ client: WatchersClient; value: WatchersSnapshot }>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState<string>();
	const [adding, setAdding] = useState(false);
	const request = useRef<AbortController | undefined>(undefined);
	const mutation = useRef<AbortController | undefined>(undefined);
	const generation = useRef(0);
	const snapshot = stored?.client === client ? stored.value : undefined;
	const refresh = useCallback(async () => {
		if (!connected || mutation.current || document.visibilityState === "hidden") return;
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setLoading(true);
		try {
			const value = await client.read(controller.signal);
			if (!controller.signal.aborted) {
				setStored({ client, value });
				setError(undefined);
			}
		} catch (failure) {
			if (!controller.signal.aborted)
				setError(failure instanceof Error ? failure.message : "No se pudo consultar el estado.");
		} finally {
			if (!controller.signal.aborted) setLoading(false);
		}
	}, [client, connected]);
	useEffect(() => {
		setError(undefined);
		setAdding(false);
		setBusy(undefined);
		setLoading(false);
		void refresh();
		const visible = () => {
			if (document.visibilityState === "visible") void refresh();
			else request.current?.abort();
		};
		const timer = setInterval(() => void refresh(), 20_000);
		document.addEventListener("visibilitychange", visible);
		return () => {
			generation.current++;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", visible);
			request.current?.abort();
			mutation.current?.abort();
			mutation.current = undefined;
		};
	}, [refresh]);
	const control = async (action: WatchersAction) => {
		if (mutation.current || !connected) return false;
		const controller = new AbortController();
		const epoch = generation.current;
		const current = () => epoch === generation.current && !controller.signal.aborted;
		mutation.current = controller;
		request.current?.abort();
		setBusy(action.action === "start" ? "new" : action.watchId);
		try {
			await client.control(action, controller.signal);
			if (current()) {
				mutation.current = undefined;
				await refresh();
				return current();
			}
		} catch (failure) {
			if (current())
				setError(
					failure instanceof Error
						? failure.message
						: "No se pudo confirmar el cambio. Actualiza antes de reintentar.",
				);
			return false;
		} finally {
			if (current()) {
				mutation.current = undefined;
				setBusy(undefined);
				setLoading(false);
			}
		}
	};
	const stale = !connected || !!error || !!snapshot?.error;
	return (
		<section className="watchers-panel" aria-label="Dot 24/7" aria-busy={loading}>
			<div className="watchers-toolbar">
				<p>Decide qué revisa Dot por ti.</p>
				<button type="button" disabled={!connected || loading || !!busy} onClick={() => void refresh()}>
					Actualizar
				</button>
			</div>
			{!connected ? (
				<p className="watchers-error" role="status">
					Sin conexión con tu equipo.
				</p>
			) : null}
			{error || snapshot?.error ? (
				<p className="watchers-error" role="alert">
					{error || snapshot?.error}
					{snapshot ? " El estado puede haber cambiado." : ""}
				</p>
			) : null}
			{loading && !snapshot ? (
				<p className="watchers-empty" role="status">
					Consultando tu configuración…
				</p>
			) : null}
			<p className="watchers-explanation">
				Con tu equipo encendido, funciona aunque cierres la app. La espera no usa IA; Dot interviene cuando
				hay cambios.
			</p>
			{snapshot?.watches.length === 0 && !stale ? (
				<p className="watchers-empty">Aún no hay tareas automáticas.</p>
			) : null}
			{snapshot && client.setup && !adding ? (
				<button
					className="watchers-add"
					type="button"
					disabled={stale || !!busy || snapshot.watches.length >= 16}
					onClick={() => setAdding(true)}
				>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
						<path d="M12 5v14M5 12h14" />
					</svg>
					Añadir tarea
				</button>
			) : null}
			{adding ? (
				<CreateWatch
					client={client}
					disabled={stale || !!busy}
					busy={busy === "new"}
					control={control}
					cancel={() => setAdding(false)}
				/>
			) : null}
			{snapshot?.watches.map((watch) => (
				<WatchCard
					key={watch.id}
					watch={watch}
					stale={stale}
					disabled={stale || !!busy}
					busy={busy === watch.id}
					control={control}
				/>
			))}
		</section>
	);
}

function WatchCard({
	watch,
	stale,
	disabled,
	busy,
	control,
}: {
	watch: WatchStatus;
	stale: boolean;
	disabled: boolean;
	busy: boolean;
	control: (action: WatchersAction) => Promise<unknown>;
}) {
	const [confirmDelete, setConfirmDelete] = useState(false);
	const source = watch.source.kind === "email" ? "Correo" : "Sesiones";
	const status = stale
		? "Estado no actualizado"
		: watch.state === "paused"
			? "Pausado"
			: watch.lastError
				? "Revisar conexión"
				: watch.pending
					? "Novedades pendientes"
					: "En espera";
	return (
		<article className="watcher-card" aria-label={watch.instruction}>
			<header>
				<span className="watcher-source">{source}</span>
				<span
					className={`watcher-state${watch.lastError && watch.state === "active" ? " watcher-state-error" : ""}`}
				>
					{status}
				</span>
			</header>
			<h3>{watch.instruction}</h3>
			{watch.lastError ? <p className="watcher-issue">{watch.lastError}</p> : null}
			<div className="watcher-actions">
				<button
					type="button"
					disabled={disabled}
					onClick={() =>
						void control({ action: watch.state === "paused" ? "resume" : "pause", watchId: watch.id })
					}
				>
					{busy ? "Guardando…" : watch.state === "paused" ? "Reanudar" : "Pausar"}
				</button>
			</div>
			<details className="watcher-details">
				<summary>Ver detalles</summary>
				<p className="watcher-instruction">{watch.instruction}</p>
				<dl>
					{watch.source.kind === "email" ? (
						<>
							<dt>Cuenta</dt>
							<dd>{watch.source.connectorId}</dd>
							<dt>Frecuencia</dt>
							<dd>Cada {(watch.intervalMs ?? 120_000) / 60_000} minutos</dd>
						</>
					) : (
						<>
							<dt>Sesiones</dt>
							<dd>
								{watch.source.sessions ? watch.source.sessions.length : "Todas las sesiones conectadas"}
							</dd>
						</>
					)}
					<dt>Última comprobación</dt>
					<dd>
						{watch.lastCheckedAt ? (
							<time dateTime={watch.lastCheckedAt}>{moment(watch.lastCheckedAt)}</time>
						) : (
							"Aún sin comprobar"
						)}
					</dd>
					{watch.lastEventAt ? (
						<>
							<dt>Última novedad</dt>
							<dd>
								<time dateTime={watch.lastEventAt}>{moment(watch.lastEventAt)}</time>
							</dd>
						</>
					) : null}
				</dl>
				{confirmDelete ? (
					<div className="watcher-delete-confirm">
						<p>¿Eliminar esta tarea automática?</p>
						<div className="watcher-actions">
							<button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>
								Cancelar
							</button>
							<button
								type="button"
								disabled={disabled}
								onClick={() => void control({ action: "delete", watchId: watch.id })}
							>
								Sí, eliminar tarea
							</button>
						</div>
					</div>
				) : (
					<button type="button" disabled={disabled} onClick={() => setConfirmDelete(true)}>
						Eliminar tarea
					</button>
				)}
			</details>
		</article>
	);
}

function CreateWatch({
	client,
	disabled,
	busy,
	control,
	cancel,
}: {
	client: WatchersClient;
	disabled: boolean;
	busy: boolean;
	control: (action: WatchersAction) => Promise<unknown>;
	cancel: () => void;
}) {
	const prefix = useId();
	const [setup, setSetup] = useState<WatchersSnapshot>();
	const [error, setError] = useState<string>();
	const [kind, setKind] = useState<"agents" | "email">("agents");
	const [sourceId, setSourceId] = useState("");
	const [scope, setScope] = useState("selected");
	const [selected, setSelected] = useState<string[]>([]);
	const [instruction, setInstruction] = useState("");
	const [intervalMs, setIntervalMs] = useState(300_000);
	useEffect(() => {
		const controller = new AbortController();
		void client
			.setup?.(controller.signal)
			.then((next) => {
				if (controller.signal.aborted) return;
				setSetup(next);
				setSourceId(next.sources?.find((item) => item.kind === "email" && item.available)?.id ?? "");
			})
			.catch((failure) => {
				if (!controller.signal.aborted)
					setError(failure instanceof Error ? failure.message : "No se pudieron consultar las opciones.");
			});
		return () => controller.abort();
	}, [client]);
	const sources = setup?.sources ?? [];
	const mail = sources.filter((source) => source.kind === "email");
	const sessions = setup?.sessions ?? [];
	const available =
		kind === "agents"
			? sources.some((source) => source.kind === "agents" && source.available)
			: mail.some((source) => source.id === sourceId && source.available);
	return (
		<form
			className="watcher-create"
			aria-label="Nueva tarea automática"
			onSubmit={async (event) => {
				event.preventDefault();
				if (
					disabled ||
					!available ||
					!instruction.trim() ||
					(kind === "agents" && scope === "selected" && !selected.length)
				)
					return;
				const source =
					kind === "email"
						? { kind, connectorId: sourceId }
						: {
								kind,
								...(scope === "selected"
									? {
											sessions: sessions
												.filter((session) =>
													selected.includes(JSON.stringify([session.paneId, session.sessionId])),
												)
												.map(({ paneId, sessionId }) => ({ paneId, sessionId })),
										}
									: {}),
							};
				if (
					await control({
						action: "start",
						source,
						instruction: instruction.trim(),
						...(kind === "email" ? { intervalMs } : {}),
					})
				)
					cancel();
			}}
		>
			<h3>Nueva tarea</h3>
			{error ? (
				<p className="watchers-error" role="alert">
					{error}
				</p>
			) : null}
			{!setup && !error ? (
				<p className="watchers-empty" role="status">
					Consultando opciones…
				</p>
			) : null}
			<fieldset disabled={disabled || !setup}>
				<legend>Qué revisar</legend>
				<div className="watcher-kind">
					<label>
						<input
							type="radio"
							name={`${prefix}-kind`}
							checked={kind === "agents"}
							onChange={() => setKind("agents")}
						/>
						Sesiones
					</label>
					<label>
						<input
							type="radio"
							name={`${prefix}-kind`}
							checked={kind === "email"}
							onChange={() => setKind("email")}
						/>
						Correo
					</label>
				</div>
				{kind === "agents" ? (
					<>
						<label className="watcher-field" htmlFor={`${prefix}-scope`}>
							Sesiones que seguirá
							<select id={`${prefix}-scope`} value={scope} onChange={(event) => setScope(event.target.value)}>
								<option value="selected">Elegir sesiones</option>
								<option value="all">Todas, incluidas las que abra después</option>
							</select>
						</label>
						{scope === "selected" ? (
							<fieldset className="watcher-session-choices" aria-label="Sesiones disponibles">
								{sessions.length ? (
									sessions.map((session) => {
										const key = JSON.stringify([session.paneId, session.sessionId]);
										return (
											<label key={key}>
												<input
													type="checkbox"
													checked={selected.includes(key)}
													disabled={!selected.includes(key) && selected.length >= 32}
													onChange={(event) =>
														setSelected((current) =>
															event.target.checked ? [...current, key] : current.filter((id) => id !== key),
														)
													}
												/>
												<span>{session.label}</span>
											</label>
										);
									})
								) : (
									<p className="watchers-empty">
										No hay sesiones conectadas. Puedes seguir las que abras después.
									</p>
								)}
							</fieldset>
						) : null}
					</>
				) : (
					<>
						<label className="watcher-field" htmlFor={`${prefix}-mail`}>
							Cuenta
							<select
								id={`${prefix}-mail`}
								value={sourceId}
								onChange={(event) => setSourceId(event.target.value)}
							>
								<option value="">Selecciona una cuenta</option>
								{mail.map((source) => (
									<option key={source.id} value={source.id} disabled={!source.available}>
										{source.label}
										{source.available ? "" : " · No disponible"}
									</option>
								))}
							</select>
						</label>
						{!mail.some((source) => source.available) ? (
							<p className="watchers-empty">
								{mail.some((source) => source.configured)
									? "Gmail no está disponible. Revisa su conexión en Conexiones."
									: "Conecta Gmail en Conexiones para habilitar esta opción."}
							</p>
						) : null}
						<label className="watcher-field" htmlFor={`${prefix}-interval`}>
							Revisar correo
							<select
								id={`${prefix}-interval`}
								value={intervalMs}
								onChange={(event) => setIntervalMs(Number(event.target.value))}
							>
								{[2, 5, 15, 30, 60].map((minutes) => (
									<option key={minutes} value={minutes * 60_000}>
										Cada {minutes} minutos
									</option>
								))}
							</select>
						</label>
					</>
				)}
				<label className="watcher-field" htmlFor={`${prefix}-instruction`}>
					Qué debe identificar Dot
					<textarea
						id={`${prefix}-instruction`}
						value={instruction}
						onChange={(event) => setInstruction(event.target.value)}
						maxLength={4000}
						rows={3}
						required
						placeholder={
							kind === "email"
								? "Avísame de correos urgentes o que requieran respuesta."
								: "Resume lo que terminen y avísame si necesitan mi ayuda."
						}
					/>
				</label>
				<p className="watchers-explanation">
					Esta tarea revisa y resume. Los objetivos y permisos se acuerdan por separado con Dot.
				</p>
			</fieldset>
			<div className="watcher-actions">
				<button type="button" disabled={busy} onClick={cancel}>
					Cancelar
				</button>
				<button
					type="submit"
					className="watchers-primary"
					disabled={
						disabled ||
						!setup ||
						!available ||
						!instruction.trim() ||
						(kind === "agents" && scope === "selected" && !selected.length)
					}
				>
					{busy ? "Activando…" : "Activar tarea"}
				</button>
			</div>
		</form>
	);
}

export function WatchersSettings({ client, connected }: { client: WatchersClient; connected: boolean }) {
	const [open, setOpen] = useState(false);
	return (
		<details className="watchers-settings" onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>Dot 24/7</summary>
			{open ? <WatchersPanel client={client} connected={connected} /> : null}
		</details>
	);
}
