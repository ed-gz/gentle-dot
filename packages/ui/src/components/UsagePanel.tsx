import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderUsage, UsageClient, UsageSnapshot, UsageWindow } from "../usage.ts";
import { UsageGlyph } from "./UsageGlyph.tsx";
import "../usage.css";

const percent = (value: number) => new Intl.NumberFormat("es", { maximumFractionDigits: 1 }).format(value);
const moment = (value: string) =>
	new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const readingTime = (value: string) =>
	new Intl.DateTimeFormat("es", {
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(value));

/** Relative resets are visible; exact local timestamps remain in the reading details. */
function resetLabel(value: string, now: number): string {
	const minutes = Math.ceil((Date.parse(value) - now) / 60_000);
	if (minutes <= 0) return "Pendiente de actualizar";
	if (minutes < 60) return `En ${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `En ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
	const days = Math.floor(hours / 24);
	if (days <= 7) return `En ${days} d${hours % 24 ? ` ${hours % 24} h` : ""}`;
	return new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" }).format(
		new Date(value),
	);
}

export function UsagePanel({ client }: { client: UsageClient }) {
	const [snapshot, setSnapshot] = useState<UsageSnapshot>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(true);
	const [now, setNow] = useState(Date.now);
	const request = useRef<AbortController | undefined>(undefined);
	const nextRead = useRef(0);
	const refresh = useCallback(async () => {
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		nextRead.current = Number.POSITIVE_INFINITY;
		setLoading(true);
		try {
			const next = await client.read(controller.signal);
			if (!controller.signal.aborted) {
				setError(undefined);
				setSnapshot(next);
				nextRead.current = next.refreshAt
					? Math.max(Date.now() + 1000, Date.parse(next.refreshAt))
					: Date.now() + 60_000;
			}
		} catch (failure) {
			if (!controller.signal.aborted) {
				setError(failure instanceof Error ? failure.message : "No se pudo consultar el consumo.");
				nextRead.current = Date.now() + 60_000;
			}
		} finally {
			if (!controller.signal.aborted) {
				setLoading(false);
				setNow(Date.now());
			}
		}
	}, [client]);
	useEffect(() => {
		setSnapshot(undefined);
		setError(undefined);
		void refresh();
		const visibleTick = () => {
			if (document.visibilityState !== "visible") return;
			setNow(Date.now());
			if (Date.now() >= nextRead.current) void refresh();
		};
		const timer = setInterval(visibleTick, 1000);
		document.addEventListener("visibilitychange", visibleTick);
		return () => {
			request.current?.abort();
			clearInterval(timer);
			document.removeEventListener("visibilitychange", visibleTick);
		};
	}, [refresh]);
	const cooldown =
		!error && snapshot?.refreshAt ? Math.max(0, Math.ceil((Date.parse(snapshot.refreshAt) - now) / 1000)) : 0;
	return (
		<section className="usage-panel" aria-label="Uso de suscripciones" aria-busy={loading}>
			<div className="usage-toolbar">
				<div>
					<p className="usage-intro">Tus suscripciones</p>
					<span role="status">
						{loading
							? "Consultando…"
							: error
								? "No se pudo actualizar"
								: "Disponible en todas tus aplicaciones"}
					</span>
				</div>
				<button
					type="button"
					aria-label="Actualizar consumo"
					title={cooldown ? `Nueva consulta en ${cooldown} segundos` : "Actualizar consumo"}
					disabled={loading || cooldown > 0}
					onClick={() => void refresh()}
				>
					<UsageGlyph kind="refresh" />
					{cooldown > 0 ? <span className="usage-sr-only">Nueva consulta en {cooldown}s</span> : null}
				</button>
			</div>
			{error ? (
				<p className="usage-error" role="alert">
					{error}
					{snapshot ? " Se conserva la última lectura." : ""}
				</p>
			) : null}
			{loading && !snapshot ? (
				<div className="usage-loading" aria-hidden="true">
					<div />
					<div />
				</div>
			) : null}
			{snapshot?.providers.map((provider) => (
				<UsageCard key={provider.id} provider={provider} stale={!!error} now={now} />
			))}
			<details className="usage-about">
				<summary>
					<UsageGlyph kind="info" />
					Sobre estas cuentas
				</summary>
				<p>
					Son las suscripciones de Codex y Claude iniciadas en el equipo. Pueden ser distintas de la cuenta
					que usa Dot. El consumo incluye otras aplicaciones.
				</p>
				<p>
					Se consultan mientras esta vista está abierta, como máximo una vez por minuto. Cierra sesión o
					cambia la cuenta desde el equipo.
				</p>
			</details>
		</section>
	);
}

function UsageCard({ provider, stale, now }: { provider: ProviderUsage; stale: boolean; now: number }) {
	const historical =
		stale || provider.stale === true || (provider.status !== "ok" && provider.windows.length > 0);
	const available = provider.status === "ok";
	const state = historical
		? "Datos anteriores"
		: available
			? undefined
			: provider.status === "expired"
				? "Sesión vencida"
				: provider.status === "unauthenticated"
					? "Sin conectar"
					: "No disponible";
	const resetGroups = new Map<
		string,
		{ expiresAt?: string; state: string; count: number; expired: boolean }
	>();
	let newlyExpired = 0;
	for (const credit of provider.resetCredits?.credits ?? []) {
		const expired = credit.expiresAt !== undefined && Date.parse(credit.expiresAt) <= now;
		if (credit.state === "available" && expired) newlyExpired++;
		const state = credit.state === "available" && expired ? "expired" : credit.state;
		const key = `${state}:${credit.expiresAt ?? "unknown"}`;
		const group = resetGroups.get(key);
		if (group) group.count++;
		else resetGroups.set(key, { expiresAt: credit.expiresAt, state, expired, count: 1 });
	}
	return (
		<article
			className={`usage-card usage-provider-${provider.id}${historical ? " usage-card-stale" : ""}`}
			aria-label={`Consumo de ${provider.label}`}
		>
			<header>
				<div className="usage-provider-heading">
					<span className="usage-provider-icon">
						<UsageGlyph kind={provider.id} />
					</span>
					<div>
						<h3>{provider.label}</h3>
						<span className="usage-plan">{provider.plan ?? "Suscripción"}</span>
					</div>
				</div>
				<div className="usage-reading">
					{state ? <span className="usage-state">{state}</span> : null}
					<time dateTime={provider.checkedAt} title={moment(provider.checkedAt)}>
						<span className="usage-sr-only">Última lectura:</span>
						<UsageGlyph kind="clock" />
						{readingTime(provider.checkedAt)}
					</time>
				</div>
			</header>
			{provider.error ? <p className="usage-provider-note">{provider.error}</p> : null}
			{!provider.windows.length && !provider.error && !provider.credits ? (
				<p className="usage-provider-note">Esta cuenta no informa sus límites de suscripción.</p>
			) : null}
			<div className="usage-windows">
				{provider.windows.slice(0, 2).map((window) => (
					<QuotaWindow
						key={window.id}
						window={window}
						provider={provider.label}
						historical={historical}
						now={now}
					/>
				))}
			</div>
			{provider.windows.length > 2 ? (
				<details className="usage-more">
					<summary>
						<UsageGlyph kind="layers" />
						Otros límites ({provider.windows.length - 2})
					</summary>
					<div className="usage-windows">
						{provider.windows.slice(2).map((window) => (
							<QuotaWindow
								key={window.id}
								window={window}
								provider={provider.label}
								historical={historical}
								now={now}
								compact
							/>
						))}
					</div>
				</details>
			) : null}
			{provider.credits &&
			(provider.credits.unlimited === true ||
				provider.credits.balance !== undefined ||
				provider.credits.hasCredits !== undefined) ? (
				<div className="usage-credits">
					<span>
						<UsageGlyph kind="layers" />
						Créditos adicionales
					</span>
					<strong>
						{provider.credits.unlimited
							? "Sin límite"
							: provider.credits.balance !== undefined
								? new Intl.NumberFormat("es", { maximumFractionDigits: 2 }).format(provider.credits.balance)
								: provider.credits.hasCredits
									? "Disponibles"
									: "Sin saldo"}
					</strong>
					<small>
						{historical ? "Saldo de la última lectura" : "Saldo independiente de tus límites de suscripción"}
					</small>
				</div>
			) : null}
			{provider.resetCredits ? (
				<details className="usage-reset-bank">
					<summary>
						<UsageGlyph kind="refresh" />
						Reinicios disponibles
						<strong>{Math.max(0, provider.resetCredits.availableCount - newlyExpired)}</strong>
					</summary>
					{historical ? <p>Inventario de la última lectura.</p> : null}
					{provider.resetCredits.credits.length ? (
						<ul>
							{[...resetGroups].map(([key, credit]) => {
								const { expired, state } = credit;
								const labels: Record<string, string> = {
									available: "Disponible",
									unavailable: "No disponible",
									expired: "Caducado",
									used: "Utilizado",
								};
								return (
									<li key={key}>
										<span className={`usage-reset-state usage-reset-state-${state}`}>
											{credit.count > 1 ? `${credit.count} × ` : ""}
											{labels[state]}
										</span>
										{credit.expiresAt ? (
											<span>
												<span>
													{expired ? "Caducidad" : "Caduca"}
													{!expired ? ` · ${resetLabel(credit.expiresAt, now).toLowerCase()}` : ""}
												</span>
												<time dateTime={credit.expiresAt}>{moment(credit.expiresAt)}</time>
											</span>
										) : (
											<span>Caducidad no informada</span>
										)}
									</li>
								);
							})}
						</ul>
					) : (
						<p>Sin reinicios acumulados.</p>
					)}
				</details>
			) : null}
		</article>
	);
}

function QuotaWindow({
	window,
	provider,
	historical,
	now,
	compact = false,
}: {
	window: UsageWindow;
	provider: string;
	historical: boolean;
	now: number;
	compact?: boolean;
}) {
	const expired = window.resetAt !== undefined && Date.parse(window.resetAt) <= now;
	const previous = historical || expired;
	const low = window.remainingPercent <= 15;
	const label = `${provider}, ${window.label}: ${percent(window.remainingPercent)}% disponible${previous ? " en la última lectura" : ""}`;
	return (
		<div
			className={`usage-window${compact ? " usage-window-compact" : ""}${low && !previous ? " usage-window-low" : ""}${previous ? " usage-window-previous" : ""}`}
		>
			<h4>
				<UsageGlyph
					kind={window.windowDurationMins && window.windowDurationMins >= 1440 ? "calendar" : "clock"}
				/>
				{window.label}
			</h4>
			<div className="usage-gauge">
				{!compact ? (
					<svg className="usage-ring" viewBox="0 0 120 120" aria-hidden="true">
						<circle className="usage-ring-track" cx="60" cy="60" r="52" />
						<circle
							className="usage-ring-fill"
							cx="60"
							cy="60"
							r="52"
							pathLength="100"
							strokeDasharray={`${window.remainingPercent} 100`}
							transform="rotate(-90 60 60)"
						/>
					</svg>
				) : null}
				<p className="usage-remaining">
					<strong>
						{percent(window.remainingPercent)}
						<span>%</span>
					</strong>
					<span>{previous ? "lectura anterior" : "disponible"}</span>
				</p>
				<progress
					className={compact ? "usage-bar" : "usage-sr-only"}
					max={100}
					value={window.remainingPercent}
					aria-label={label}
				/>
			</div>
			<p className="usage-spent">
				{percent(window.usedPercent)}% usado
				{low && !previous ? <span> · {window.remainingPercent === 0 ? "Agotado" : "Queda poco"}</span> : null}
			</p>
			<div className="usage-reset">
				<span>
					<UsageGlyph kind="refresh" />
					{expired ? "Ventana terminada" : "Se renueva"}
				</span>
				{window.resetAt ? (
					<>
						<time className="usage-reset-countdown" dateTime={window.resetAt}>
							{resetLabel(window.resetAt, now)}
						</time>
						<time className="usage-reset-date" dateTime={window.resetAt}>
							{moment(window.resetAt)}
						</time>
					</>
				) : (
					<span className="usage-reset-countdown">No informado</span>
				)}
			</div>
		</div>
	);
}
