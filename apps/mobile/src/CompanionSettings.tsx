import { useEffect, useRef, useState } from "react";
import { GentleMobile, type NativeCompanionState, nativeAndroid } from "./native.ts";
import type { NativeCompanionThemeControls } from "./useNativeCompanionTheme.ts";

export function CompanionSettings({ themeControls }: { themeControls: NativeCompanionThemeControls }) {
	const [state, setState] = useState<NativeCompanionState>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [stateError, setStateError] = useState("");
	const [permissionHelp, setPermissionHelp] = useState(false);
	const permissionIntent = useRef(false);
	const changing = useRef(false);
	const latestRead = useRef(0);
	const refreshPending = useRef(false);
	const refreshState = useRef(() => {});
	const theme = useRef(themeControls);
	theme.current = themeControls;
	const lastThemeStatus = useRef([themeControls.theme, themeControls.pending, themeControls.error]);
	useEffect(() => {
		if (!nativeAndroid) return;
		let alive = true;
		const refresh = () => {
			if (changing.current) {
				refreshPending.current = true;
				return;
			}
			refreshPending.current = false;
			const read = ++latestRead.current;
			void GentleMobile.companionState()
				.then(async (value) => {
					if (!alive || read !== latestRead.current || changing.current) return;
					setState(value);
					setStateError("");
					if (!permissionIntent.current) return;
					permissionIntent.current = false;
					if (!value.permission) {
						setPermissionHelp(true);
						return;
					}
					changing.current = true;
					++latestRead.current;
					setBusy(true);
					setError("");
					try {
						await theme.current.setCompanion({ enabled: true });
						const confirmed = await GentleMobile.companionState();
						if (alive) setState(confirmed);
					} catch (cause) {
						if (alive)
							setError(cause instanceof Error ? cause.message : "No se pudo activar el acompañante.");
					} finally {
						changing.current = false;
						if (alive) setBusy(false);
						if (alive && refreshPending.current) refresh();
					}
				})
				.catch(() => {
					if (alive && read === latestRead.current)
						setStateError("No se pudo comprobar el permiso de Android. Inténtalo de nuevo.");
				});
		};
		refreshState.current = refresh;
		refresh();
		window.addEventListener("gentledot-resume", refresh);
		return () => {
			alive = false;
			refreshState.current = () => {};
			window.removeEventListener("gentledot-resume", refresh);
		};
	}, []);
	useEffect(() => {
		const status = [themeControls.theme, themeControls.pending, themeControls.error];
		const changed = status.some((value, index) => value !== lastThemeStatus.current[index]);
		lastThemeStatus.current = status;
		if (changed && !themeControls.pending) refreshState.current();
	}, [themeControls.theme, themeControls.pending, themeControls.error]);
	if (!nativeAndroid || state?.supported === false) return null;
	if (!state)
		return stateError ? (
			<section className="mobile-companion-settings" aria-label="Acompañante en Android">
				<p className="mobile-error" role="alert">
					{stateError}
				</p>
				<button
					type="button"
					className="mobile-companion-permission-help"
					onClick={() => refreshState.current()}
				>
					Comprobar de nuevo
				</button>
			</section>
		) : null;
	const change = async (options: { enabled?: boolean; pinned?: boolean }) => {
		if (changing.current) return;
		changing.current = true;
		++latestRead.current;
		setBusy(true);
		setError("");
		try {
			if (options.enabled && !state.permission) {
				permissionIntent.current = true;
				setPermissionHelp(true);
				await GentleMobile.requestCompanionPermission();
				return;
			}
			await theme.current.setCompanion(options);
			setState(await GentleMobile.companionState());
		} catch (cause) {
			permissionIntent.current = false;
			setError(cause instanceof Error ? cause.message : "No se pudo cambiar el acompañante.");
		} finally {
			changing.current = false;
			setBusy(false);
			if (refreshPending.current) refreshState.current();
		}
	};
	const openAppSettings = async () => {
		if (changing.current) return;
		changing.current = true;
		++latestRead.current;
		permissionIntent.current = false;
		setBusy(true);
		setError("");
		try {
			await GentleMobile.openCompanionAppSettings();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Abre Ajustes → Aplicaciones → Gentle Dot en tu teléfono.",
			);
		} finally {
			changing.current = false;
			setBusy(false);
			if (refreshPending.current) refreshState.current();
		}
	};
	const nativeError = error || themeControls.error || state.renderError || stateError;
	const ready = state.enabled && state.active && state.renderReady !== false;
	return (
		<section className="mobile-companion-settings" aria-label="Acompañante en Android">
			<button
				type="button"
				className="mobile-alert-switch"
				role="switch"
				aria-checked={ready}
				disabled={busy || themeControls.pending || themeControls.theme === undefined}
				onClick={() => void change({ enabled: !ready })}
			>
				<span>
					<strong>Sobre otras apps</strong>
					<small>
						{state.permission
							? "Tu personaje aparece al salir de la app. Tócalo para conversar."
							: "Android te pedirá permitir Mostrar sobre otras apps."}
					</small>
				</span>
				<span className="mobile-switch-track" aria-hidden="true">
					<span />
				</span>
			</button>
			{themeControls.pending ? (
				<p className="mobile-setting-hint" role="status">
					Aplicando el personaje en Android…
				</p>
			) : ready && !nativeError && state.theme === themeControls.theme ? (
				<p className="mobile-setting-hint" role="status">
					{state.theme === "capri" ? "Capri está lista." : "Gentle Dot está listo."} Pulsa Inicio para ver el
					personaje sobre otras apps.
				</p>
			) : null}
			{!state.permission &&
				(permissionHelp ? (
					<div className="mobile-companion-permission">
						<p role="status">Falta el permiso de Android para aparecer sobre otras apps.</p>
						<p>Si aparece «A la app se le negó el acceso»:</p>
						<ol>
							<li>Abre la información de Gentle Dot.</li>
							<li>
								En el menú ⋮, toca <strong>Permitir ajustes restringidos</strong>, si confías en esta
								instalación.
							</li>
							<li>
								Vuelve al permiso y activa <strong>Mostrar sobre otras apps</strong>.
							</li>
						</ol>
						<div className="mobile-companion-permission-actions">
							<button type="button" disabled={busy} onClick={() => void openAppSettings()}>
								Abrir información de la app
							</button>
							<button type="button" disabled={busy} onClick={() => void change({ enabled: true })}>
								Volver al permiso
							</button>
						</div>
						<p className="mobile-setting-hint">
							El menú depende del teléfono. Si no aparece esa opción, consulta la ayuda del fabricante. La app
							no puede concederse este permiso.
						</p>
					</div>
				) : (
					<button
						type="button"
						className="mobile-companion-permission-help"
						onClick={() => setPermissionHelp(true)}
					>
						¿Android no te deja activarlo?
					</button>
				))}
			{ready && (
				<button
					type="button"
					className="mobile-alert-switch"
					role="switch"
					aria-checked={state.pinned}
					disabled={busy}
					onClick={() => void change({ pinned: !state.pinned })}
				>
					<span>
						<strong>Fijar posición</strong>
						<small>También puedes mantener pulsado el personaje.</small>
					</span>
					<span className="mobile-switch-track" aria-hidden="true">
						<span />
					</span>
				</button>
			)}
			<p className="mobile-setting-hint">
				Arrástralo para colocarlo; tócalo para conversar. Se oculta al abrir la app y al bloquear el teléfono.
				En ahorro de batería permanece quieto. No lee otras aplicaciones.
			</p>
			{nativeError && (
				<p className="mobile-error" role="alert">
					{nativeError}
				</p>
			)}
			{(themeControls.error || state.renderError) && (
				<button
					type="button"
					className="mobile-companion-permission-help"
					disabled={busy || themeControls.pending}
					onClick={() => {
						setError("");
						if (state.renderError) void change({ enabled: true });
						else
							void themeControls
								.retry()
								.then(() => refreshState.current())
								.catch(() => {});
					}}
				>
					Reintentar personaje
				</button>
			)}
		</section>
	);
}
