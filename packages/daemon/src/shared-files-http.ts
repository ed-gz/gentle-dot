import type { IncomingMessage, ServerResponse } from "node:http";
import { allowApi, bearer, jsonResponse, readJson } from "./mobile.ts";
import {
	fileDisposition,
	SharedFileError,
	type SharedFilePublication,
	type SharedFileStore,
} from "./shared-files.ts";

interface SharedFilesGatewayOptions {
	store?: SharedFileStore;
	/** Shares only a real desktop capture observed during the engine's current turn. */
	shareComputerCapture?(): SharedFilePublication;
	acceptsHuman(key: string): boolean;
	acceptsAgent(key: string): boolean;
	origins(): Set<string>;
}

/** This is publication of private snapshots, never a web mount of the computer's folders. */
export class SharedFilesGateway {
	private readonly options: SharedFilesGatewayOptions;
	private downloads = 0;
	private closed = false;
	constructor(options: SharedFilesGatewayOptions) {
		this.options = options;
	}
	close(): void {
		this.closed = true;
	}
	async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			if (!allowApi(req, res, this.options.origins())) return;
			const path = new URL(req.url ?? "/", "http://localhost").pathname;
			const key = bearer(req);
			if (path === "/api/files/agent") {
				if (this.closed || !this.options.acceptsAgent(key)) {
					req.resume();
					return jsonResponse(res, 401, { error: "Unauthorized" });
				}
				const peer = req.socket.remoteAddress;
				if (
					!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "") ||
					req.headers.origin ||
					Object.keys(req.headers).some((name) => name === "forwarded" || name.startsWith("x-forwarded-"))
				)
					return jsonResponse(res, 403, { error: "File publication is local to the assistant engine" });
				if (!this.options.store)
					return jsonResponse(res, 503, { error: "File sharing is unavailable in VPS mode" });
				if (req.method !== "POST") return jsonResponse(res, 405, { error: "Use POST" });
				const input = await readJson(req);
				if (this.closed || res.destroyed || !this.options.acceptsAgent(key))
					return jsonResponse(res, 401, { error: "Unauthorized" });
				if (input.action !== undefined) {
					if (input.action !== "share_computer_screenshot" || Object.keys(input).length !== 1)
						return jsonResponse(res, 400, { error: "La solicitud de captura no es válida." });
					if (!this.options.shareComputerCapture)
						return jsonResponse(res, 503, { error: "No está disponible el envío de capturas del equipo." });
					return jsonResponse(res, 200, this.options.shareComputerCapture());
				}
				return jsonResponse(res, 200, this.options.store.publish(input));
			}
			const authorized = () => !this.closed && this.options.acceptsHuman(key);
			if (!authorized()) {
				req.resume();
				return jsonResponse(res, 401, { error: "Unauthorized" });
			}
			if (!this.options.store)
				return jsonResponse(res, 503, { error: "File sharing is unavailable in VPS mode" });
			if (req.method !== "GET") return jsonResponse(res, 405, { error: "Use GET" });
			const match = /^\/api\/files\/([A-Za-z0-9_-]{43})\/(meta|content)$/.exec(path);
			if (!match?.[1]) return jsonResponse(res, 404, { error: "File not found" });
			if (match[2] === "meta") return jsonResponse(res, 200, this.options.store.meta(match[1]));
			if (this.downloads >= 4)
				return jsonResponse(res, 429, { error: "Hay varias descargas en curso. Espera a que termine una." });
			const { meta, bytes } = this.options.store.read(match[1]);
			if (!authorized()) return jsonResponse(res, 401, { error: "Unauthorized" });
			this.downloads++;
			res.once("close", () => {
				this.downloads--;
			});
			res.writeHead(200, {
				"Content-Type": meta.mime,
				"Content-Length": meta.size,
				"Content-Disposition": fileDisposition(meta.name),
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "no-store",
				"Content-Security-Policy": "sandbox; default-src 'none'",
				"Access-Control-Expose-Headers": "Content-Disposition, Content-Length, Content-Type",
			});
			let offset = 0;
			const send = () => {
				if (res.destroyed) return;
				if (!authorized()) {
					res.destroy();
					return;
				}
				if (offset >= bytes.length) {
					res.end();
					return;
				}
				const end = Math.min(offset + 64 * 1024, bytes.length);
				const ready = res.write(bytes.subarray(offset, end));
				offset = end;
				if (ready) setImmediate(send);
				else res.once("drain", () => setImmediate(send));
			};
			send();
		} catch (error) {
			jsonResponse(res, error instanceof SharedFileError ? error.status : 400, {
				error:
					error instanceof SharedFileError ? error.message : "No se pudo preparar el archivo compartido.",
				...(error instanceof SharedFileError ? { code: error.code } : {}),
			});
		}
	}
}
