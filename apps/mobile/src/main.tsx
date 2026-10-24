import { App as NativeApp } from "@capacitor/app";
import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../../packages/ui/src/App.tsx";
import { RoseGlyph } from "../../../packages/ui/src/components/icons.tsx";
import { CompanionSettings } from "./CompanionSettings.tsx";
import { NotificationSettings } from "./NotificationSettings.tsx";
import { GentleMobile, nativeAndroid, setupNative } from "./native.ts";
import {
	type Connection,
	disconnectDevice,
	type Invitation,
	parseInvitation,
	redeemPairing,
} from "./pairing.ts";
import { scanPairingQr } from "./scanner.ts";
import { clearConnection, loadConnection, saveConnection } from "./storage.ts";
import "../../../packages/ui/src/styles.css";
import "./mobile.css";

setupNative();

function MobileApp() {
	const [connection, setConnection] = useState<Connection>();
	const [partialChat, setPartialChat] = useState(false);
	const [loading, setLoading] = useState(true);
	const [input, setInput] = useState("");
	const [invitation, setInvitation] = useState<Invitation>();
	const [deviceName, setDeviceName] = useState("Mi Android");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [monitoring, setMonitoring] = useState(false);
	const [confirmDisconnect, setConfirmDisconnect] = useState(false);
	const info = useMemo(
		() =>
			connection
				? {
						url: `${connection.url.replace(/^https:/, "wss:")}/ws`,
						webUrl: connection.url,
						token: connection.token,
					}
				: undefined,
		[connection],
	);
	useEffect(() => {
		if (!nativeAndroid) return;
		const theme = () => {
			try {
				const value = JSON.parse(localStorage.getItem("gentle-dot-companion-v1") ?? "{}");
				void GentleMobile.setCompanion({ theme: value.mode === "capri" ? "capri" : "gentle-dot" }).catch(
					() => {},
				);
			} catch {
				/* Keep native selection if storage is unavailable. */
			}
		};
		const refresh = () => {
			void GentleMobile.companionState()
				.then((state) => {
					setPartialChat(state.partialChat);
					document.documentElement.dataset.companionChat = String(state.partialChat);
				})
				.catch(() => {});
			theme();
		};
		refresh();
		window.addEventListener("gentledot-resume", refresh);
		window.addEventListener("gentle-dot-companion-change", theme);
		return () => {
			window.removeEventListener("gentledot-resume", refresh);
			window.removeEventListener("gentle-dot-companion-change", theme);
		};
	}, []);
	useEffect(() => {
		if (!nativeAndroid || !connection) return;
		const receive = () =>
			void GentleMobile.companionLaunchContext()
				.then((context) => {
					if (context.paneId)
						window.dispatchEvent(
							new CustomEvent("gentledot-open-session", {
								detail: { paneId: context.paneId, sessionId: context.sessionId },
							}),
						);
					if (!context.paneId && context.openChat) window.dispatchEvent(new Event("gentledot-open-chat"));
				})
				.catch(() => {});
		const timer = window.setTimeout(receive, 300);
		window.addEventListener("gentledot-resume", receive);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener("gentledot-resume", receive);
		};
	}, [connection]);
	const fail = useCallback(
		(cause: unknown) =>
			setError(cause instanceof Error ? cause.message : "No se pudo completar la operación."),
		[],
	);
	const receive = useCallback(
		(text: string) => {
			try {
				setInvitation(parseInvitation(text));
				setInput("");
				setError("");
			} catch (cause) {
				fail(cause);
			}
		},
		[fail],
	);
	useEffect(() => {
		let alive = true;
		void loadConnection()
			.then(
				(value) => {
					if (alive) setConnection(value);
				},
				(cause) => {
					if (alive) fail(cause);
				},
			)
			.finally(() => {
				if (alive) setLoading(false);
			});
		if (nativeAndroid) {
			void GentleMobile.monitorState()
				.then((value) => {
					if (alive) setMonitoring(value.active);
				})
				.catch(fail);
			void NativeApp.getLaunchUrl()
				.then((value) => {
					if (alive && value?.url) receive(value.url);
				})
				.catch(fail);
		}
		const link = nativeAndroid
			? NativeApp.addListener("appUrlOpen", (event) => receive(event.url))
			: undefined;
		const back = nativeAndroid
			? NativeApp.addListener("backButton", () => {
					// Dispatch below window so nested screens handle capture before the shell's bubble listener.
					const event = new Event("gentledot-back", { cancelable: true, bubbles: true });
					document.dispatchEvent(event);
					if (!event.defaultPrevented)
						void GentleMobile.companionState().then((state) =>
							state.partialChat ? GentleMobile.closeCompanionChat() : NativeApp.minimizeApp(),
						);
				})
			: undefined;
		const state = nativeAndroid
			? NativeApp.addListener("appStateChange", (value) => {
					if (value.isActive) window.dispatchEvent(new Event("gentledot-resume"));
					else window.dispatchEvent(new Event("gentledot-pause"));
					if (value.isActive)
						void GentleMobile.monitorState()
							.then((value) => setMonitoring(value.active))
							.catch(fail);
				})
			: undefined;
		return () => {
			alive = false;
			void link?.then((handle) => handle.remove());
			void back?.then((handle) => handle.remove());
			void state?.then((handle) => handle.remove());
		};
	}, [fail, receive]);
	const scan = async () => {
		setError("");
		setBusy(true);
		try {
			receive(await scanPairingQr());
		} catch (cause) {
			if (!(cause instanceof Error && cause.name === "AbortError")) fail(cause);
		} finally {
			setBusy(false);
		}
	};
	const pair = async () => {
		if (!invitation) return;
		if (connection) {
			setError(
				"Este teléfono ya está vinculado. Cancela esta invitación y pulsa Desvincular antes de conectar otro equipo.",
			);
			return;
		}
		setBusy(true);
		setError("");
		try {
			const result = await redeemPairing(invitation, deviceName);
			if (nativeAndroid) await GentleMobile.stopMonitor();
			await saveConnection(result);
			setMonitoring(false);
			setConnection(result);
			setInvitation(undefined);
		} catch (cause) {
			fail(cause);
		} finally {
			setBusy(false);
		}
	};
	const disconnect = async () => {
		if (!connection) return;
		setBusy(true);
		setError("");
		try {
			await disconnectDevice(connection);
			if (nativeAndroid) await GentleMobile.stopMonitor();
			await clearConnection();
			setConnection(undefined);
			setMonitoring(false);
			setConfirmDisconnect(false);
		} catch (cause) {
			fail(cause);
		} finally {
			setBusy(false);
		}
	};
	const toggleMonitor = async () => {
		if (!connection) return;
		setBusy(true);
		setError("");
		try {
			if (monitoring) await GentleMobile.stopMonitor();
			else await GentleMobile.startMonitor({ url: connection.url, token: connection.token });
			setMonitoring((await GentleMobile.monitorState()).active);
		} catch (cause) {
			fail(cause);
		} finally {
			setBusy(false);
		}
	};
	if (loading)
		return (
			<main className="pairing">
				<p role="status">Abriendo Gentle Dot…</p>
			</main>
		);
	return (
		<div className={connection && !invitation ? "mobile-shell" : "pairing"}>
			{partialChat && (
				<div className="companion-chat-bar">
					<span>Conversación</span>
					<button
						type="button"
						aria-label="Volver a la burbuja"
						onClick={() => void GentleMobile.closeCompanionChat()}
					>
						Cerrar
					</button>
				</div>
			)}
			{connection && info && !invitation ? (
				<App
					key={connection.deviceId}
					connection={info}
					mobileDraftScope={JSON.stringify([connection.url, connection.deviceId])}
					mobileControls={
						<section className="mobile-device" aria-label="Este teléfono">
							<h3>Tu equipo</h3>
							<p className="mobile-device-host">{new URL(connection.url).hostname}</p>
							<CompanionSettings />
							<NotificationSettings
								connection={connection}
								monitoring={monitoring}
								monitorBusy={busy}
								onToggleMonitor={() => void toggleMonitor()}
							/>
							{confirmDisconnect ? (
								<div className="mobile-disconnect-confirm">
									<p>¿Desvincular este teléfono?</p>
									<p className="mobile-setting-hint">Necesitarás otro QR para volver a conectarte.</p>
									<div className="mobile-disconnect-actions">
										<button type="button" onClick={() => setConfirmDisconnect(false)} disabled={busy}>
											Cancelar
										</button>
										<button
											type="button"
											className="mobile-disconnect"
											onClick={() => void disconnect()}
											disabled={busy}
										>
											{busy ? "Desvinculando…" : "Sí, desvincular"}
										</button>
									</div>
								</div>
							) : (
								<button
									type="button"
									className="mobile-disconnect"
									onClick={() => setConfirmDisconnect(true)}
									disabled={busy}
								>
									Desvincular teléfono
								</button>
							)}
							{error && (
								<p className="mobile-error" role="alert">
									{error}
								</p>
							)}
						</section>
					}
				/>
			) : (
				<main className="pairing-card">
					<div className="pairing-mark" aria-hidden="true">
						<RoseGlyph />
					</div>
					<p className="pairing-eyebrow">GENTLE DOT · MÓVIL</p>
					<h1>
						Tu equipo,
						<br />a una conversación.
					</h1>
					<p className="pairing-intro">
						Habla con tu asistente, continúa sesiones y revisa permisos desde tu teléfono.
					</p>
					{invitation ? (
						<section className="pairing-confirm">
							<h2>Vincular con {invitation.name}</h2>
							<p className="pairing-host">{invitation.url}</p>
							<p>Comprueba que es la dirección del equipo que quieres controlar.</p>
							<label htmlFor="device-name">Nombre del teléfono</label>
							<input
								id="device-name"
								value={deviceName}
								onChange={(event) => setDeviceName(event.target.value)}
								maxLength={80}
							/>
							<button type="button" className="pairing-primary" disabled={busy} onClick={() => void pair()}>
								{busy ? "Confirma en tu equipo…" : "Vincular este teléfono"}
							</button>
							<button type="button" disabled={busy} onClick={() => setInvitation(undefined)}>
								Cancelar
							</button>
						</section>
					) : (
						<>
							<div className="pairing-step">
								<strong>1</strong>
								<p>Activa Tailscale en tu equipo y en tu teléfono.</p>
							</div>
							<div className="pairing-step">
								<strong>2</strong>
								<p>Abre el QR de vinculación de Gentle Dot en tu equipo.</p>
							</div>
							<button
								type="button"
								className="pairing-primary"
								onClick={() => void scan()}
								disabled={busy || !nativeAndroid}
							>
								{busy ? "Abriendo cámara…" : "Escanear QR"}
							</button>
							<details>
								<summary>Pegar enlace de vinculación</summary>
								<form
									onSubmit={(event) => {
										event.preventDefault();
										receive(input);
									}}
								>
									<label htmlFor="pairing-link">Enlace del QR</label>
									<textarea
										id="pairing-link"
										value={input}
										onChange={(event) => setInput(event.target.value)}
										placeholder="gentledot://pair?…"
										autoCapitalize="none"
										autoCorrect="off"
										spellCheck={false}
									/>
									<button type="submit" disabled={busy || !input.trim()}>
										Revisar enlace
									</button>
								</form>
							</details>
						</>
					)}
					{error && (
						<p className="mobile-error" role="alert">
							{error}
						</p>
					)}
					<p className="pairing-note">Conexión privada por Tailscale. Tu equipo debe permanecer encendido.</p>
				</main>
			)}
		</div>
	);
}
const root = document.getElementById("root");
if (root)
	createRoot(root).render(
		<StrictMode>
			<MobileApp />
		</StrictMode>,
	);
