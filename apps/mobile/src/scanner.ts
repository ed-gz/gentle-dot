import { App } from "@capacitor/app";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import {
	BarcodeFormat,
	BarcodeScanner,
	type BarcodeScannerPlugin,
	LensFacing,
	Resolution,
} from "@capacitor-mlkit/barcode-scanning";

interface ScannerOverlay {
	ready(hasTorch: boolean): void;
	torch(enabled: boolean): void;
	message(value: string): void;
	destroy(): void;
}

export interface ScannerEnvironment {
	isAndroid(): boolean;
	driver: Pick<
		BarcodeScannerPlugin,
		| "isSupported"
		| "checkPermissions"
		| "requestPermissions"
		| "startScan"
		| "stopScan"
		| "addListener"
		| "isTorchAvailable"
		| "toggleTorch"
	>;
	getAppState(): Promise<{ isActive: boolean }>;
	onAppState(callback: (state: { isActive: boolean }) => void): Promise<PluginListenerHandle>;
	mount(callbacks: { cancel(): void; toggleTorch(): Promise<void> }): ScannerOverlay;
}

const cameraPermissionMessage =
	"Permite el acceso a Cámara en Ajustes → Aplicaciones → Gentle Dot → Permisos, o usa Pegar enlace.";
const cameraFailureMessage =
	"No se pudo abrir la cámara. Cierra otras apps que la usen y vuelve a intentar, o usa Pegar enlace.";
class ScannerMessageError extends Error {}

function cancelled(): Error {
	const error = new Error("Escaneo cancelado.");
	error.name = "AbortError";
	return error;
}

function cameraFailure(error: unknown): Error {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "object" && error !== null && "message" in error
				? String(error.message)
				: "";
	return new ScannerMessageError(
		/permission|denied|permiso/i.test(message) ? cameraPermissionMessage : cameraFailureMessage,
	);
}

/** The injected environment makes camera lifecycle and cleanup independently testable. */
export function createPairingScanner(environment: ScannerEnvironment): () => Promise<string> {
	let scanning = false;
	return async () => {
		if (!environment.isAndroid())
			throw new Error("Escanear QR está disponible en la app Android. En el navegador usa Pegar enlace.");
		if (scanning) throw new Error("Ya hay un escáner abierto. Ciérralo antes de volver a escanear.");
		scanning = true;
		const { driver } = environment;
		const listeners: PluginListenerHandle[] = [];
		let overlay: ScannerOverlay | undefined;
		let cameraRequested = false;
		let settled = false;
		let torchEnabled = false;
		type Outcome = { value: string; error?: never } | { error: Error; value?: never };
		let resolveOutcome!: (outcome: Outcome) => void;
		// Resolve an outcome object so events received during startScan cannot create
		// an unhandled rejection before the native camera startup promise settles.
		const outcome = new Promise<Outcome>((resolve) => {
			resolveOutcome = resolve;
		});
		const finish = (result: Outcome) => {
			if (settled) return;
			settled = true;
			resolveOutcome(result);
		};
		try {
			if (!(await driver.isSupported()).supported)
				throw new ScannerMessageError(
					"Este dispositivo no tiene una cámara compatible. Usa Pegar enlace para vincularlo.",
				);
			let permission = await driver.checkPermissions();
			if (permission.camera === "prompt" || permission.camera === "prompt-with-rationale")
				permission = await driver.requestPermissions();
			if (permission.camera !== "granted") throw new ScannerMessageError(cameraPermissionMessage);
			if (!(await environment.getAppState()).isActive) throw cancelled();

			overlay = environment.mount({
				cancel: () => finish({ error: cancelled() }),
				toggleTorch: async () => {
					if (settled) return;
					try {
						await driver.toggleTorch();
						if (!settled) {
							torchEnabled = !torchEnabled;
							overlay?.torch(torchEnabled);
						}
					} catch {
						if (!settled)
							overlay?.message("No se pudo cambiar la linterna. Acerca el código a una zona con más luz.");
					}
				},
			});
			listeners.push(
				await environment.onAppState(({ isActive }) => {
					if (!isActive) finish({ error: cancelled() });
				}),
			);
			listeners.push(
				await driver.addListener("barcodesScanned", ({ barcodes }) => {
					const qr = barcodes.find((barcode) => barcode.format === BarcodeFormat.QrCode);
					if (!qr) return;
					if (typeof qr.rawValue !== "string" || !qr.rawValue || qr.rawValue.length > 4096) {
						finish({
							error: new ScannerMessageError(
								"Este QR no contiene un enlace legible. Genera otro código en Gentle Dot.",
							),
						});
						return;
					}
					// Treat QR contents as untrusted text. The caller validates the private
					// host and invitation before redeeming the deliberately scanned code.
					finish({ value: qr.rawValue });
				}),
			);
			listeners.push(
				await driver.addListener("scanError", (error) => finish({ error: cameraFailure(error) })),
			);
			if (!(await environment.getAppState()).isActive) finish({ error: cancelled() });
			if (!settled) {
				cameraRequested = true;
				try {
					// startScan uses the model bundled with the APK. Do not replace this
					// with scan(), which requires the downloadable Google Play module.
					await driver.startScan({
						formats: [BarcodeFormat.QrCode],
						lensFacing: LensFacing.Back,
						resolution: Resolution["1280x720"],
					});
					if (!settled) {
						const torch = await driver.isTorchAvailable().catch(() => ({ available: false }));
						if (!settled) overlay.ready(torch.available);
					}
				} catch (error) {
					finish({ error: cameraFailure(error) });
				}
			}
			const result = await outcome;
			if (result.error) throw result.error;
			return result.value;
		} catch (error) {
			if (error instanceof ScannerMessageError || (error instanceof Error && error.name === "AbortError"))
				throw error;
			throw cameraFailure(error);
		} finally {
			settled = true;
			let stopFailed = false;
			// Await startup above before stopping: cancelling during CameraX startup
			// must not leave a late camera callback running after the overlay closes.
			if (cameraRequested) {
				try {
					await driver.stopScan();
				} catch {
					stopFailed = true;
				}
			}
			await Promise.allSettled(listeners.map((listener) => listener.remove()));
			overlay?.destroy();
			scanning = false;
			if (stopFailed)
				// biome-ignore lint/correctness/noUnsafeFinally: camera cleanup failure must prevent using the scanned result
				throw new Error(
					"No se pudo cerrar la cámara. Cierra y vuelve a abrir Gentle Dot antes de continuar.",
				);
		}
	};
}

function mountOverlay(callbacks: { cancel(): void; toggleTorch(): Promise<void> }): ScannerOverlay {
	const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	const root = document.getElementById("root");
	const rootWasInert = root?.inert ?? false;
	const style = document.createElement("style");
	style.textContent = `
html.gentledot-scanning-qr,body.gentledot-scanning-qr{background:transparent!important}
body.gentledot-scanning-qr *{visibility:hidden!important}
body.gentledot-scanning-qr #gentledot-qr-overlay,body.gentledot-scanning-qr #gentledot-qr-overlay *{visibility:visible!important}
#gentledot-qr-overlay{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;overflow:hidden;color:#fff;font-family:inherit;padding:max(24px,var(--safe-area-inset-top,env(safe-area-inset-top,0px))) 24px max(28px,var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)));box-sizing:border-box}
#gentledot-qr-overlay header,#gentledot-qr-overlay footer{position:relative;z-index:1;text-align:center}
#gentledot-qr-overlay header{display:flex;justify-content:space-between;align-items:center;gap:12px}
#gentledot-qr-overlay h2{font-size:20px;margin:0;font-weight:700}
#gentledot-qr-overlay p{font-size:15px;line-height:1.6;margin:14px 0}
#gentledot-qr-overlay button{appearance:none;min-height:48px;border:1px solid #ffffff45;border-radius:14px;background:#10171bdd;color:#fff;font:inherit;padding:12px 18px;cursor:pointer}
#gentledot-qr-overlay button:focus-visible{outline:3px solid #c2f970;outline-offset:4px}
#gentledot-qr-overlay button[aria-pressed=true]{background:#c2f970;color:#10200c}
#gentledot-qr-overlay [hidden]{display:none!important}
#gentledot-qr-overlay .gentledot-qr-center{flex:1;display:grid;place-items:center;min-height:180px;padding:28px 0}
#gentledot-qr-overlay .gentledot-qr-frame{width:min(68vw,300px,46dvh);aspect-ratio:1;border:3px solid #c2f970;border-radius:22px;box-shadow:0 0 0 150vmax #060c12a8}
`;
	const overlay = document.createElement("section");
	overlay.id = "gentledot-qr-overlay";
	overlay.setAttribute("role", "dialog");
	overlay.setAttribute("aria-modal", "true");
	overlay.setAttribute("aria-labelledby", "gentledot-qr-title");
	overlay.innerHTML =
		'<header><h2 id="gentledot-qr-title">Escanear QR</h2><button type="button" data-cancel>Cancelar</button></header><div class="gentledot-qr-center" aria-hidden="true"><div class="gentledot-qr-frame"></div></div><footer><p>Apunta al QR de Gentle Dot en tu computadora.</p><p role="status" data-status>Preparando cámara…</p><button type="button" data-torch aria-pressed="false" hidden>Encender linterna</button></footer>';
	const cancel = overlay.querySelector<HTMLButtonElement>("[data-cancel]");
	const torch = overlay.querySelector<HTMLButtonElement>("[data-torch]");
	const status = overlay.querySelector<HTMLElement>("[data-status]");
	if (!cancel || !torch || !status) throw new Error("No se pudo mostrar el escáner.");
	const back = (event: Event) => {
		event.preventDefault();
		event.stopImmediatePropagation();
		callbacks.cancel();
	};
	const visibility = () => {
		if (document.visibilityState === "hidden") callbacks.cancel();
	};
	const keydown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			callbacks.cancel();
		}
		if (event.key === "Tab") {
			const controls = [cancel, ...(!torch.hidden && !torch.disabled ? [torch] : [])];
			const index = controls.indexOf(document.activeElement as HTMLButtonElement);
			const next = event.shiftKey
				? (index - 1 + controls.length) % controls.length
				: (index + 1) % controls.length;
			event.preventDefault();
			controls[next]?.focus();
		}
	};
	cancel.addEventListener("click", callbacks.cancel);
	torch.addEventListener("click", async () => {
		torch.disabled = true;
		try {
			await callbacks.toggleTorch();
		} finally {
			torch.disabled = false;
		}
	});
	overlay.addEventListener("keydown", keydown);
	window.addEventListener("gentledot-back", back, true);
	document.addEventListener("visibilitychange", visibility);
	document.head.append(style);
	document.documentElement.classList.add("gentledot-scanning-qr");
	document.body.classList.add("gentledot-scanning-qr");
	if (root) root.inert = true;
	document.body.append(overlay);
	cancel.focus();
	return {
		ready: (hasTorch) => {
			torch.hidden = !hasTorch;
			status.textContent = "Mantén el código dentro del marco.";
		},
		torch: (enabled) => {
			torch.setAttribute("aria-pressed", String(enabled));
			torch.textContent = enabled ? "Apagar linterna" : "Encender linterna";
		},
		message: (value) => {
			status.textContent = value;
		},
		destroy: () => {
			window.removeEventListener("gentledot-back", back, true);
			document.removeEventListener("visibilitychange", visibility);
			overlay.remove();
			style.remove();
			document.documentElement.classList.remove("gentledot-scanning-qr");
			document.body.classList.remove("gentledot-scanning-qr");
			if (root) root.inert = rootWasInert;
			if (previousFocus?.isConnected) previousFocus.focus();
		},
	};
}

/** Returns untrusted QR text; never navigates, fetches, or redeems it. */
export const scanPairingQr = createPairingScanner({
	isAndroid: () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android",
	driver: BarcodeScanner,
	getAppState: () => App.getState(),
	onAppState: (callback) => App.addListener("appStateChange", callback),
	mount: mountOverlay,
});
