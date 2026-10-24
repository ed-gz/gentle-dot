import { type CompanionMode, isCompanionMode } from "@gentle-dot/protocol";
import type { ConnectionInfo } from "./client.ts";
import { uploadBase } from "./uploads.ts";

export type { CompanionMode } from "@gentle-dot/protocol";
export interface CompanionClient {
	read(signal?: AbortSignal): Promise<CompanionMode>;
	set(mode: CompanionMode, signal?: AbortSignal): Promise<CompanionMode>;
}
export function createCompanionClient(info: ConnectionInfo): CompanionClient {
	const request = async (mode?: CompanionMode, signal?: AbortSignal): Promise<CompanionMode> => {
		const response = await fetch(`${uploadBase(info.url)}/api/mobile/companion`, {
			method: mode ? "POST" : "GET",
			headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
			...(mode ? { body: JSON.stringify({ mode }) } : {}),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000),
		});
		if (!response.ok)
			throw new Error(
				response.status === 404
					? "El equipo necesita la actualización de Capri para cambiar la personalidad."
					: "No se pudo guardar el modo en el equipo. Vuelve a intentar.",
			);
		const body = await response.json();
		if (!isCompanionMode(body.mode)) throw new Error("Respuesta de modo inválida.");
		return body.mode;
	};
	return { read: (signal) => request(undefined, signal), set: (mode, signal) => request(mode, signal) };
}
