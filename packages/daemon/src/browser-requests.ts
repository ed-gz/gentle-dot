import { randomUUID } from "node:crypto";
import type { AppApproval } from "./app-channel.ts";
import { type BrowserController, BrowserError, type BrowserSnapshot } from "./browser.ts";
import type { SharedFileStore } from "./shared-files.ts";

interface Options {
	browser: BrowserController;
	files: SharedFileStore;
	ask: (request: AppApproval, signal?: AbortSignal) => Promise<boolean>;
	install?: (requestId: string) => Promise<unknown>;
	installAvailable?: () => boolean;
	cancelInstall?: (requestId: string) => Promise<unknown>;
}

const installMessages: Record<string, string> = {
	pending:
		"Instalación pendiente en el equipo. La autenticación se completa allí; no escribas contraseñas en el chat.",
	succeeded: "Chromium está instalado. Ya puedes activar el navegador.",
	denied: "El sistema no autorizó la instalación.",
	cancelled: "La autenticación fue cancelada; no se inició la instalación.",
	failed: "No se pudo completar la instalación. Revisa el gestor de aplicaciones en el equipo.",
	unsupported: "Esta instalación automática no está disponible en tu sistema.",
	helper_unavailable:
		"Falta instalar el auxiliar de Gentle Dot en el equipo para abrir la autenticación del sistema.",
	busy: "Ya hay una instalación pendiente en el equipo.",
	unknown:
		"No se pudo confirmar el resultado de la instalación. Revisa el equipo antes de volver a intentarlo.",
};

export interface BrowserInstallation {
	requestId: string;
	status:
		| "pending"
		| "succeeded"
		| "denied"
		| "cancelled"
		| "failed"
		| "unsupported"
		| "helper_unavailable"
		| "busy"
		| "unknown";
	message: string;
}

/** Consent is resolved by the human broker, never by an agent-provided boolean. */
export class BrowserRequests {
	private pending = false;
	private pendingCancellation?: AbortController;
	private installation?: BrowserInstallation;
	private readonly options: Options;
	constructor(options: Options) {
		this.options = options;
	}

	status() {
		return {
			...this.options.browser.status(),
			canRequestInstall: Boolean(this.options.install) && (this.options.installAvailable?.() ?? true),
			...(this.installation ? { installation: { ...this.installation } } : {}),
		};
	}

	close(): void {
		this.pendingCancellation?.abort();
	}

	async action(
		input: Record<string, unknown>,
		actor: "human" | "agent",
		authorize = () => true,
		signal?: AbortSignal,
	): Promise<unknown> {
		const { browser } = this.options;
		let currentSignal = signal;
		const valid = () => authorize() && !currentSignal?.aborted;
		if (!valid()) throw new BrowserError("UNAUTHORIZED", "La solicitud fue cancelada.", 401);
		if (input.action === "status" || input.action === "tabs") return this.status();
		if (input.action === "stop" && actor === "human") this.pendingCancellation?.abort();
		if (input.action === "share_screenshot") {
			const result = (await browser.action(
				{ action: "snapshot", tabId: input.tabId, screenshot: true },
				actor,
				valid,
			)) as BrowserSnapshot;
			if (!valid()) throw new BrowserError("CANCELLED", "La captura fue cancelada.", 409);
			if (!result.image) throw new BrowserError("CAPTURE_UNAVAILABLE", "No se pudo generar la captura.", 409);
			const file = this.options.files.publishCapture(Buffer.from(result.image.data, "base64"));
			return {
				...result,
				file,
				instruction:
					"Incluye file.markdown exacto en tu respuesta para mostrar la captura en el chat y pregunta qué debe cambiar.",
			};
		}
		if (input.action !== "request_access" && input.action !== "install_browser") {
			const result = await browser.action(input, actor, valid);
			return input.action === "stop" || input.action === "start" ? this.status() : result;
		}
		if (input.action === "request_access" && browser.status().active) return browser.status();
		if (this.pending)
			throw new BrowserError("REQUEST_PENDING", "Ya hay una solicitud de navegador pendiente.", 409);
		if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000)
			throw new BrowserError("INVALID_INPUT", "Explica brevemente para qué necesitas el navegador.");
		const install = input.action === "install_browser";
		if (install && (!this.options.install || this.options.installAvailable?.() === false))
			throw new BrowserError(
				"APP_REQUIRED",
				"Abre la app de escritorio para instalar Chromium con la autorización del sistema.",
				503,
			);
		this.pending = true;
		const cancellation = new AbortController();
		this.pendingCancellation = cancellation;
		currentSignal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
		try {
			const approved =
				actor === "human" ||
				(await this.options.ask(
					{
						connector: "Navegador",
						action: install ? "instalar Chromium" : "navegar",
						title: install ? "¿Instalar Chromium en el equipo?" : "¿Permitir a Dot usar el navegador?",
						summary: install
							? "La contraseña se escribe únicamente en el diálogo del sistema en tu equipo. Dot no la recibe."
							: "Dot usará su navegador dedicado. Puedes desconectarlo en Ajustes en cualquier momento. El acceso termina al cerrar el navegador o reiniciar el equipo.",
						preview: [{ name: "Motivo", value: input.reason }],
					},
					currentSignal,
				));
			if (!approved || !valid()) throw new BrowserError("DECLINED", "No se autorizó esta solicitud.", 403);
			if (!install)
				return await browser.action({ action: "start", window: input.window === true }, "human", valid);
			const requestId = randomUUID();
			this.installation = { requestId, status: "pending", message: installMessages.pending as string };
			const cancel = () => {
				void this.options.cancelInstall?.(requestId).catch(() => {});
			};
			currentSignal.addEventListener("abort", cancel, { once: true });
			try {
				const result = (await this.options.install?.(requestId)) as { requestId?: unknown; status?: unknown };
				const status =
					result?.requestId === requestId &&
					typeof result.status === "string" &&
					Object.hasOwn(installMessages, result.status) &&
					!["pending", "unknown"].includes(result.status)
						? (result.status as BrowserInstallation["status"])
						: "unknown";
				this.installation = { requestId, status, message: installMessages[status] as string };
				return { ...this.installation };
			} catch {
				cancel();
				this.installation = { requestId, status: "unknown", message: installMessages.unknown as string };
				return { ...this.installation };
			} finally {
				currentSignal.removeEventListener("abort", cancel);
			}
		} finally {
			this.pendingCancellation = undefined;
			this.pending = false;
		}
	}
}
