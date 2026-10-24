import { useEffect, useRef, useState } from "react";
import { GentleMobile, type NativeCompanionState, nativeAndroid } from "./native.ts";

export function CompanionSettings() {
	const [state, setState] = useState<NativeCompanionState>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const permissionIntent = useRef(false);
	useEffect(() => {
		if (!nativeAndroid) return;
		let alive = true;
		const refresh = () =>
			void GentleMobile.companionState()
				.then(async (value) => {
					if (!alive) return;
					setState(value);
					if (!permissionIntent.current) return;
					permissionIntent.current = false;
					if (!value.permission) return;
					setBusy(true);
					try {
						await GentleMobile.setCompanion({ enabled: true });
						if (alive) setState(await GentleMobile.companionState());
					} catch (cause) {
						if (alive)
							setError(cause instanceof Error ? cause.message : "No se pudo activar el acompañante.");
					} finally {
						if (alive) setBusy(false);
					}
				})
				.catch(() => {});
		refresh();
		window.addEventListener("gentledot-resume", refresh);
		return () => {
			alive = false;
			window.removeEventListener("gentledot-resume", refresh);
		};
	}, []);
	if (!nativeAndroid || !state?.supported) return null;
	const change = async (options: { enabled?: boolean; pinned?: boolean }) => {
		setBusy(true);
		setError("");
		try {
			if (options.enabled && !state.permission) {
				permissionIntent.current = true;
				await GentleMobile.requestCompanionPermission();
				return;
			}
			await GentleMobile.setCompanion(options);
			setState(await GentleMobile.companionState());
		} catch (cause) {
			permissionIntent.current = false;
			setError(cause instanceof Error ? cause.message : "No se pudo cambiar el acompañante.");
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="mobile-companion-settings" aria-label="Acompañante en Android">
			<button
				type="button"
				className="mobile-alert-switch"
				role="switch"
				aria-checked={state.enabled && state.active}
				disabled={busy}
				onClick={() => void change({ enabled: !(state.enabled && state.active) })}
			>
				<span>
					<strong>Sobre otras apps</strong>
					<small>
						{state.permission
							? "Tu personaje abre la conversación con un toque."
							: "Android te pedirá permitir Mostrar sobre otras apps."}
					</small>
				</span>
				<span className="mobile-switch-track" aria-hidden="true">
					<span />
				</span>
			</button>
			{state.enabled && state.active && (
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
			{error && (
				<p className="mobile-error" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}
