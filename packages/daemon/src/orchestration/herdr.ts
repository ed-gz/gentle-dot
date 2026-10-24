import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

export class OrchestrationError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 409) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

export function defaultHerdrSocket(env: NodeJS.ProcessEnv = process.env): string {
	if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
	const root = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr");
	return env.HERDR_SESSION
		? join(root, "sessions", env.HERDR_SESSION, "herdr.sock")
		: join(root, "herdr.sock");
}

/** HERDR protocol 22 and Pi adapters use one LF-delimited JSON response per request. */
export function localRequest(
	socketPath: string,
	method: string,
	params: Record<string, unknown> = {},
	timeoutMs = 5000,
	authorize: () => boolean = () => true,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const id = randomUUID();
		const socket = createConnection(socketPath);
		let settled = false;
		let buffer: Buffer = Buffer.alloc(0);
		const finish = (error?: Error, result?: Record<string, unknown>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else if (result) resolve(result);
			else reject(new OrchestrationError("PROTOCOL", "La sesión no devolvió un resultado.", 502));
		};
		const timer = setTimeout(
			() => finish(new OrchestrationError("TIMEOUT", "La conexión local no respondió a tiempo.", 504)),
			timeoutMs,
		);
		socket.once("connect", () => {
			if (!authorize())
				return finish(
					new OrchestrationError("UNAUTHORIZED", "El acceso de este dispositivo fue revocado.", 401),
				);
			const payload = JSON.stringify({ id, method, params });
			if (method === "prompt" && params.files !== undefined) {
				// The native adapter cannot dispatch an unterminated JSON line. Recheck
				// device/HTTP lifetime after the bounded attachment bytes drain, before
				// sending the commit delimiter. Ordinary text operations stay unchanged.
				const complete = () => {
					if (settled) return;
					if (!authorize())
						return finish(new OrchestrationError("UNAUTHORIZED", "El acceso de este dispositivo fue revocado.", 401));
					socket.write("\n");
				};
				if (socket.write(payload)) complete();
				else socket.once("drain", complete);
			} else {
				socket.write(`${payload}\n`);
			}
		});
		socket.once("error", () =>
			finish(new OrchestrationError("UNAVAILABLE", "No se puede conectar con HERDR o la sesión de Pi.", 503)),
		);
		socket.once("end", () =>
			finish(new OrchestrationError("DISCONNECTED", "La sesión cerró la conexión antes de responder.", 503)),
		);
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
			if (buffer.length > 8 * 1024 * 1024)
				return finish(new OrchestrationError("TOO_LARGE", "La respuesta local supera el límite.", 502));
			while (true) {
				const newline = buffer.indexOf(10);
				if (newline === -1) break;
				const line = buffer.subarray(0, newline).toString("utf8");
				buffer = buffer.subarray(newline + 1);
				if (!line.trim()) continue;
				try {
					const response: unknown = JSON.parse(line);
					if (!record(response)) throw new Error("Invalid record");
					if (response.id !== id) continue;
					if (record(response.error)) {
						finish(new OrchestrationError(String(response.error.code), String(response.error.message)));
					} else if (record(response.result)) finish(undefined, response.result);
					else throw new Error("Invalid result");
				} catch {
					finish(new OrchestrationError("PROTOCOL", "La sesión devolvió una respuesta inválida.", 502));
				}
			}
		});
	});
}
