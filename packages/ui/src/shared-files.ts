import type { ConnectionInfo } from "./client.ts";
import { mobileBridge } from "./mobile.ts";
import { uploadBase } from "./uploads.ts";

export const MAX_SHARED_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_PREVIEW_BYTES = 8 * 1024 * 1024;
const FILE_PATH = /^\/api\/files\/([A-Za-z0-9_-]{32,128})\/content$/;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface SharedFileInfo {
	id: string;
	name: string;
	size: number;
	mime: string;
	image: boolean;
}
export type ReceiveResult = { status: "saved" | "shared" | "cancelled" };
export interface SharedFileClient {
	idFromHref(href: string): string | undefined;
	metadata(id: string, signal: AbortSignal): Promise<SharedFileInfo>;
	preview(file: SharedFileInfo, signal: AbortSignal): Promise<Blob>;
	receive(file: SharedFileInfo, action: "save" | "share", signal: AbortSignal): Promise<ReceiveResult>;
	canShare(): boolean;
}

function checkId(id: string): string {
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(id)) throw new Error("El enlace del archivo no es válido.");
	return id;
}

/** Only published file IDs from this connected computer receive its access key. */
export function sharedFileId(href: string, origin: string): string | undefined {
	try {
		const url = new URL(href, origin);
		if (url.origin !== origin || url.username || url.password || url.search || url.hash) return;
		return FILE_PATH.exec(url.pathname)?.[1];
	} catch {
		return;
	}
}

function metadata(value: unknown, id: string): SharedFileInfo {
	if (!value || typeof value !== "object") throw new Error("El equipo devolvió un archivo no válido.");
	const file = value as Partial<SharedFileInfo>;
	if (
		file.id !== id ||
		typeof file.name !== "string" ||
		!file.name.trim() ||
		file.name.length > 255 ||
		/[\\/\p{Cc}]/u.test(file.name) ||
		typeof file.size !== "number" ||
		!Number.isSafeInteger(file.size) ||
		file.size < 0 ||
		file.size > MAX_SHARED_FILE_BYTES ||
		typeof file.mime !== "string" ||
		!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(file.mime) ||
		typeof file.image !== "boolean" ||
		(file.image && !IMAGE_TYPES.has(file.mime))
	)
		throw new Error("El equipo devolvió un archivo no válido.");
	return file as SharedFileInfo;
}

async function responseError(response: Response): Promise<Error> {
	if (response.status === 401 || response.status === 403)
		return new Error("Este teléfono ya no tiene acceso. Revisa la conexión con tu equipo.");
	if (response.status === 404) return new Error("El archivo ya no está disponible en el equipo.");
	return new Error("No se pudo recibir el archivo. Revisa la conexión e inténtalo de nuevo.");
}

/** Streaming limits also protect the browser when Content-Length is absent or misleading. */
async function boundedBlob(response: Response, file: SharedFileInfo, signal: AbortSignal): Promise<Blob> {
	const declared = response.headers.get("content-length");
	if (declared !== null && Number(declared) !== file.size)
		throw new Error("El tamaño del archivo cambió. Pídele a Dot que lo comparta de nuevo.");
	if (!response.body) throw new Error("El archivo llegó vacío o incompleto.");
	const reader = response.body.getReader();
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let size = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > file.size || size > MAX_SHARED_FILE_BYTES)
				throw new Error("El archivo supera el tamaño permitido.");
			chunks.push(new Uint8Array(value));
		}
		if (size !== file.size) throw new Error("La descarga quedó incompleta. Inténtalo de nuevo.");
		return new Blob(chunks, { type: file.mime });
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export function createSharedFileClient(info: ConnectionInfo): SharedFileClient {
	const origin = uploadBase(info.url);
	const urlFor = (id: string, part: "meta" | "content") => `${origin}/api/files/${checkId(id)}/${part}`;
	const request = async (id: string, part: "meta" | "content", signal: AbortSignal) => {
		const response = await fetch(urlFor(id, part), {
			headers: { Authorization: `Bearer ${info.token}` },
			credentials: "omit",
			redirect: "error",
			cache: "no-store",
			signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
		});
		if (!response.ok) throw await responseError(response);
		return response;
	};
	return {
		idFromHref: (href) => sharedFileId(href, origin),
		metadata: async (id, signal) => metadata(await (await request(id, "meta", signal)).json(), id),
		preview: async (file, signal) => {
			if (!file.image || !IMAGE_TYPES.has(file.mime) || file.size > MAX_IMAGE_PREVIEW_BYTES)
				throw new Error("Guarda esta imagen para verla a tamaño completo.");
			return boundedBlob(await request(file.id, "content", signal), file, signal);
		},
		canShare: () => Boolean(mobileBridge()?.receiveFile || navigator.share),
		receive: async (file, action, signal) => {
			signal.throwIfAborted();
			const bridge = mobileBridge();
			if (bridge?.receiveFile) {
				const cancel = () => void bridge.cancelReceiveFile?.().catch(() => {});
				signal.addEventListener("abort", cancel, { once: true });
				try {
					return await bridge.receiveFile({
						url: urlFor(file.id, "content"),
						token: info.token,
						name: file.name,
						mime: file.mime,
						action,
					});
				} finally {
					signal.removeEventListener("abort", cancel);
				}
			}
			const blob = await boundedBlob(await request(file.id, "content", signal), file, signal);
			signal.throwIfAborted();
			const shared = new File([blob], file.name, { type: file.mime });
			if (action === "share") {
				if (!navigator.canShare?.({ files: [shared] }))
					throw new Error("Este navegador no permite compartir archivos. Usa Guardar archivo.");
				try {
					await navigator.share({ files: [shared], title: file.name });
					return { status: "shared" };
				} catch (error) {
					if (error instanceof DOMException && error.name === "AbortError") return { status: "cancelled" };
					throw error;
				}
			}
			const objectUrl = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = objectUrl;
			anchor.download = file.name;
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
			setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
			return { status: "saved" };
		},
	};
}
