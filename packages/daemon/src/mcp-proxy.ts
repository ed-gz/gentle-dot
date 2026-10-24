/**
 * The daemon's MCP proxy (S25.4, docs/design.md "Connectors"). The engine's `mcp.json` lists every
 * connector as `http://127.0.0.1:<port>/mcp/<id>` with a key made for that engine launch; the daemon
 * answers there and talks to the real server itself: a remote one over streamable HTTP with the
 * headers and tokens it injects, or a stdio one it runs. The engine never sees an upstream address,
 * a token, or a server's environment.
 *
 * Every request reads the connector's state from the daemon's memory, so a mode change applies to
 * the next request without restarting the engine. `tools/list` shows only what the mode allows,
 * `tools/call` refuses hidden and unknown tools however they are called, and a sending action is
 * forwarded only after the user approves its full preview. Resources and prompts are reads: they are
 * shown in "read and send", and in read only only for a connector with a curated read-only list (the
 * catalog's); a server of the user's own in read only exposes nothing, like its tools.
 *
 * Answers are plain `application/json` over POST, like the desktop app's computer helper: no event
 * streams (GET is 405) and notifications get 202.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	type AuthProvider,
	JSON_RPC_ERROR_CODES,
	LATEST_PROTOCOL_VERSION,
	McpAbortError,
	McpAuthRequiredError,
	McpClient,
	McpError,
	McpTimeoutError,
	type McpTransport,
	StdioTransport,
	StreamableHttpTransport,
	SUPPORTED_PROTOCOL_VERSIONS,
	type Tool,
} from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { type ConnectorMode, isReadOnlyTool } from "./extensions/approval-guard.ts";
import { NO_APP, SecretsUnavailableError } from "./secret-source.ts";
import { type OsUser, stdioCommand } from "./vps.ts";

/** Where the engine reaches a connector: `/mcp/<id>`. */
export const MCP_PREFIX = "/mcp/";

/** A connector as the proxy sees it: the daemon's live state, without any secret. */
export interface ProxiedConnector {
	id: string;
	name: string;
	enabled: boolean;
	mode: ConnectorMode;
	/** The curated read-only tools (empty for a server of the user's own). */
	readOnlyTools: readonly string[];
	/** The real server: its address, or the command the daemon runs. Secrets come from the credentials. */
	server: { url: string } | { command: string; args?: string[]; cwd?: string };
	/** Changes whenever the server or its values change, so the connection to it is made again. */
	revision: string;
	/** Why it cannot run now (a secret it needs is not available); safe to show. */
	unavailable?: string;
}

/** What the daemon adds to the real server's requests: headers and tokens, or a stdio server's environment. */
export interface UpstreamCredentials {
	headers?: Record<string, string>;
	env?: Record<string, string>;
	authProvider?: AuthProvider;
}

/** What the user approves before a sending action is forwarded: everything that will be sent. */
export interface ApprovalPreview {
	connectorId: string;
	/** The connector's name, as the user knows it. */
	connector: string;
	tool: string;
	arguments: Record<string, unknown>;
}

export interface McpProxyOptions {
	/** The connector's current state, read on every request. */
	connector(id: string): ProxiedConnector | undefined;
	/** Runs before the state is read (the daemon reads the connector's secrets from the app). */
	prepare?(id: string): Promise<void>;
	credentials(id: string): Promise<UpstreamCredentials>;
	/** Asks the user; false or a failure refuses the action. The signal aborts when the engine gave up. */
	approve(preview: ApprovalPreview, signal: AbortSignal): Promise<boolean>;
	/** The transport to the real server; by default streamable HTTP or stdio, from the server. */
	transport?: (connector: ProxiedConnector, credentials: UpstreamCredentials) => McpTransport;
	/** The environment stdio servers start from (the engine's own), and their working folder. */
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	/**
	 * Server mode (S25.8): stdio servers run as this user, with this folder as their home and working
	 * folder, out of reach of both the engine and the daemon's files.
	 */
	stdio?: { user: OsUser; home: string };
	log?: (line: string) => void;
}

/** JSON-RPC errors the proxy answers with itself; `message` is safe to show and tells the model what to do. */
class ProxyError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

const UNAUTHORIZED = -32001;
/** Refusals and upstream failures (the JSON-RPC server-error range). */
const REFUSED = -32000;
const MAX_BODY = 8 * 1024 * 1024;
/** A tool call may wait for the user's approval and then the server: just under the engine's 300 s. */
const CALL_TIMEOUT_MS = 290_000;
const REQUEST_TIMEOUT_MS = 60_000;

interface Upstream {
	client: McpClient;
	revision: string;
	connecting: Promise<void>;
	waiters: Set<{ signal: AbortSignal }>;
	/** The tools from the last list, for their annotations. */
	tools?: Tool[];
}

/** Safe errors for daemon-owned readers; upstream errors may contain credentials or mail content. */
export class McpReadError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

export class McpProxy {
	private key = "";
	private readonly upstreams = new Map<string, Upstream>();
	/** Requests being answered, by connector and request id, so a `notifications/cancelled` stops them. */
	private readonly running = new Map<string, AbortController>();
	private readonly options: McpProxyOptions;
	private readonly readers = new Map<string, { controller: AbortController; revision?: string }>();
	private closed = false;

	constructor(options: McpProxyOptions) {
		this.options = options;
	}

	/** A fresh key for the next engine launch; the previous one stops working at once. */
	rotateKey(): string {
		this.key = randomBytes(32).toString("base64url");
		return this.key;
	}

	/** Answers one HTTP request to `/mcp/<id>`. */
	handle(req: IncomingMessage, res: ServerResponse): void {
		void this.serve(req, res).catch((error: Error) => {
			this.log(`connector proxy request failed: ${error.message}`);
			if (!res.headersSent) res.writeHead(500).end();
		});
	}

	/** Closes the connection of every connector that is gone, turned off, or whose server changed. */
	sync(): void {
		for (const [id, reader] of this.readers) {
			const current = this.options.connector(id);
			if (!current?.enabled || (reader.revision !== undefined && current.revision !== reader.revision))
				reader.controller.abort();
		}
		for (const [id, upstream] of this.upstreams) {
			const connector = this.options.connector(id);
			if (!connector?.enabled || connector.revision !== upstream.revision) this.drop(id, upstream);
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const reader of this.readers.values()) reader.controller.abort();
		for (const controller of this.running.values()) controller.abort();
		const closing = [...this.upstreams.values()].map((upstream) => upstream.client.close().catch(() => {}));
		this.upstreams.clear();
		await Promise.all(closing);
	}

	/** Load existing protected values only when an authorized watcher runs, never from status. */
	async prepareRead(id: string, signal: AbortSignal): Promise<void> {
		await this.readOperation(id, signal, async () => {});
	}

	/** Curated, server-declared read tools, including their real schemas. Does not expose credentials. */
	async readOnlyTools(id: string, signal: AbortSignal): Promise<Tool[]> {
		return this.readOperation(id, signal, async (connector, combined, check) => {
			const upstream = await abortable(this.upstream(connector, combined), combined);
			check();
			const tools = await upstream.client.listTools({ signal: combined, timeoutMs: 20_000 });
			check();
			upstream.tools = tools;
			return tools.filter(
				(tool) =>
					isReadOnlyTool(tool.name, tool.annotations?.readOnlyHint, connector.readOnlyTools) &&
					tool.annotations?.destructiveHint !== true,
			);
		});
	}

	/** Internal polling path: never asks approval and never falls back to a writing tool. */
	async readOnly(
		id: string,
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		const initial = this.options.connector(id);
		if (!initial?.readOnlyTools.includes(name))
			throw new McpReadError(
				"READ_FORBIDDEN",
				"Esta herramienta no está autorizada para consultar en segundo plano.",
			);
		return this.readOperation(id, signal, async (connector, combined, check) => {
			const upstream = await abortable(this.upstream(connector, combined), combined);
			check();
			// Re-list before execution: a cached annotation alone cannot authorize a background operation.
			const tools = await upstream.client.listTools({ signal: combined, timeoutMs: 20_000 });
			check();
			upstream.tools = tools;
			const tool = tools.find((entry) => entry.name === name);
			if (
				!tool ||
				!isReadOnlyTool(name, tool.annotations?.readOnlyHint, connector.readOnlyTools) ||
				tool.annotations?.destructiveHint === true
			)
				throw new McpReadError(
					"READ_FORBIDDEN",
					"El conector no confirma que esta herramienta sea de sólo lectura.",
				);
			const current = this.options.connector(id);
			if (!current?.readOnlyTools.includes(name))
				throw new McpReadError("READ_CHANGED", "El acceso al conector cambió durante la consulta.");
			const result = await upstream.client.callTool(name, args, { signal: combined, timeoutMs: 20_000 });
			check();
			return result;
		});
	}

	private async readOperation<T>(
		id: string,
		signal: AbortSignal,
		operation: (connector: ProxiedConnector, signal: AbortSignal, check: () => void) => Promise<T>,
	): Promise<T> {
		if (this.closed || signal.aborted) throw new McpReadError("READ_CANCELLED", "Consulta cancelada.");
		if (this.readers.has(id))
			throw new McpReadError("READ_BUSY", "El conector ya está atendiendo otra consulta.");
		const initial = this.options.connector(id);
		if (!initial?.enabled || initial.readOnlyTools.length === 0)
			throw new McpReadError(
				"READ_UNAVAILABLE",
				"Activa un conector compatible en Conectores para consultar el correo.",
			);
		const reader: { controller: AbortController; revision?: string } = { controller: new AbortController() };
		this.readers.set(id, reader);
		const deadline = AbortSignal.timeout(25_000);
		const combined = AbortSignal.any([signal, reader.controller.signal, deadline]);
		const check = () => {
			if (this.closed || combined.aborted) throw new McpReadError("READ_CANCELLED", "Consulta cancelada.");
			const current = this.options.connector(id);
			if (
				!current?.enabled ||
				current.unavailable ||
				current.readOnlyTools.length === 0 ||
				(reader.revision !== undefined && current.revision !== reader.revision)
			)
				throw new McpReadError(
					"READ_CHANGED",
					"El conector cambió o ya no está disponible. Revisa Conectores.",
				);
		};
		try {
			if (this.options.prepare) await abortable(this.options.prepare(id), combined);
			check();
			const connector = this.options.connector(id);
			if (!connector) throw new McpReadError("READ_UNAVAILABLE", "El conector ya no está disponible.");
			reader.revision = connector.revision;
			return await abortable(operation(connector, combined, check), combined);
		} catch (error) {
			if (signal.aborted || reader.controller.signal.aborted || this.closed)
				throw new McpReadError("READ_CANCELLED", "Consulta cancelada.");
			if (deadline.aborted)
				throw new McpReadError("READ_TIMEOUT", "El conector tardó demasiado en responder.");
			check();
			if (error instanceof McpReadError) throw error;
			if (error instanceof McpOAuthAuthorizationRequiredError || error instanceof McpAuthRequiredError)
				throw new McpReadError("READ_AUTH_REQUIRED", "Vuelve a iniciar sesión en el conector de correo.");
			throw new McpReadError(
				"READ_FAILED",
				"No se pudo consultar el conector de correo. Revisa su conexión.",
			);
		} finally {
			if (this.readers.get(id) === reader) this.readers.delete(id);
		}
	}

	private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		// Only the engine calls here; a page in a browser never may, even with the key.
		if (req.headers.origin !== undefined) return this.empty(req, res, 403);
		if (!this.authorized(req.headers.authorization))
			return this.reply(req, res, 401, null, { error: { code: UNAUTHORIZED, message: "Unauthorized" } });
		const url = new URL(req.url ?? "/", "http://localhost");
		const id = url.pathname.slice(MCP_PREFIX.length);
		if (req.method !== "POST") return this.empty(req, res, 405);
		const body = await readBody(req);
		if (body === undefined) return this.empty(req, res, 413);
		let message: Message;
		try {
			message = JSON.parse(body) as Message;
		} catch {
			return this.reply(req, res, 400, null, {
				error: { code: JSON_RPC_ERROR_CODES.parseError, message: "Parse error" },
			});
		}
		if (typeof message !== "object" || message === null || Array.isArray(message))
			return this.reply(req, res, 400, null, {
				error: { code: JSON_RPC_ERROR_CODES.invalidRequest, message: "Invalid request" },
			});
		const rpcId = message.id;
		// Notifications and responses get no reply; a cancellation stops the request it names.
		if (typeof message.method !== "string" || (typeof rpcId !== "string" && typeof rpcId !== "number")) {
			if (message.method === "notifications/cancelled") {
				const cancelled = (message.params as { requestId?: unknown } | undefined)?.requestId;
				if (typeof cancelled === "string" || typeof cancelled === "number")
					this.running.get(requestKey(id, cancelled))?.abort();
			}
			return this.empty(req, res, 202);
		}
		let connector = this.options.connector(id);
		if (!connector)
			return this.reply(req, res, 404, rpcId, {
				error: { code: REFUSED, message: "That connector does not exist." },
			});
		const controller = new AbortController();
		const key = requestKey(id, rpcId);
		if (this.running.has(key))
			return this.reply(req, res, 200, rpcId, {
				error: {
					code: JSON_RPC_ERROR_CODES.invalidRequest,
					message: "That request id is already active. Nothing was sent.",
				},
			});
		this.running.set(key, controller);
		// The engine gave up (its timeout, or the user stopped the answer): nothing is forwarded after that.
		const disconnected = () => {
			if (!res.writableFinished) controller.abort();
		};
		res.on("close", disconnected);
		if (res.destroyed) controller.abort();
		try {
			if (this.closed) throw new ProxyError(REFUSED, "The connector proxy is closing. Nothing was sent.");
			// Register cancellation before credential preparation can wait for the desktop app.
			await abortable(this.options.prepare?.(id).catch(() => {}) ?? Promise.resolve(), controller.signal);
			if (controller.signal.aborted) throw new McpAbortError();
			const current = this.options.connector(id);
			if (!current) throw new ProxyError(REFUSED, "That connector no longer exists. Nothing was sent.");
			connector = current;
			const result = await abortable(
				this.dispatch(connector, message.method, asRecord(message.params), controller.signal),
				controller.signal,
			);
			this.reply(req, res, 200, rpcId, { result });
		} catch (error) {
			this.reply(req, res, 200, rpcId, {
				error: this.rpcError(connector, controller.signal.aborted ? new McpAbortError() : error),
			});
		} finally {
			res.removeListener("close", disconnected);
			if (this.running.get(key) === controller) this.running.delete(key);
		}
	}

	private async dispatch(
		connector: ProxiedConnector,
		method: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		if (method === "ping") return {};
		if (!connector.enabled)
			throw new ProxyError(
				REFUSED,
				`${connector.name} is turned off. If the user wants it, ask them to turn it on in Connectors.`,
			);
		// Without its secrets it fails closed, with the reason.
		if (connector.unavailable) throw new ProxyError(REFUSED, connector.unavailable);
		const reads = readsAllowed(connector);
		switch (method) {
			case "initialize": {
				const asked = params.protocolVersion;
				const versions: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS;
				return {
					protocolVersion:
						typeof asked === "string" && versions.includes(asked) ? asked : LATEST_PROTOCOL_VERSION,
					capabilities: {
						tools: { listChanged: false },
						...(reads ? { resources: { listChanged: false }, prompts: { listChanged: false } } : {}),
					},
					serverInfo: { name: `gentle-dot-${connector.id}`, version: "1.0.0" },
				};
			}
			case "tools/list": {
				const tools = await this.listTools(connector, signal);
				return { tools: tools.filter((tool) => visible(connector, tool)) };
			}
			case "tools/call":
				return this.callTool(connector, params, signal);
			case "resources/list":
				if (!reads) return { resources: [] };
				return { resources: await this.all(connector, signal, (c) => c.listResources({ signal })) };
			case "resources/templates/list":
				if (!reads) return { resourceTemplates: [] };
				return {
					resourceTemplates: await this.all(connector, signal, (c) => c.listResourceTemplates({ signal })),
				};
			case "prompts/list":
				if (!reads) return { prompts: [] };
				return { prompts: await this.all(connector, signal, (c) => listPrompts(c, signal)) };
			case "resources/read":
			case "prompts/get": {
				if (!reads) throw new ProxyError(JSON_RPC_ERROR_CODES.invalidParams, notAvailable(connector));
				const upstream = await this.upstream(connector, signal);
				return await upstream.client.request(method, params, { signal, timeoutMs: REQUEST_TIMEOUT_MS });
			}
			default:
				throw new ProxyError(JSON_RPC_ERROR_CODES.methodNotFound, `Method not found: ${method}`);
		}
	}

	private async callTool(
		connector: ProxiedConnector,
		params: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		const name = params.name;
		if (typeof name !== "string")
			throw new ProxyError(JSON_RPC_ERROR_CODES.invalidParams, "Invalid params: `name` is required");
		const args = asRecord(params.arguments);
		const upstream = await this.upstream(connector, signal);
		// The annotations come from the server's own list, never from the caller.
		let tool = upstream.tools?.find((t) => t.name === name);
		if (!tool) tool = (await this.listTools(connector, signal)).find((t) => t.name === name);
		if (!tool) throw new ProxyError(JSON_RPC_ERROR_CODES.invalidParams, `Unknown tool: ${name}`);
		refuseHidden(connector, tool);
		if (!isReadOnlyTool(tool.name, tool.annotations?.readOnlyHint, connector.readOnlyTools)) {
			const preview: ApprovalPreview = {
				connectorId: connector.id,
				connector: connector.name,
				tool: tool.name,
				arguments: args,
			};
			let allowed = false;
			try {
				allowed = await this.options.approve(preview, signal);
			} catch (error) {
				this.log(`the approval for ${connector.id} could not be asked: ${(error as Error).message}`);
				throw new ProxyError(
					REFUSED,
					"This action needs the user's approval, and it could not be asked right now. Nothing was sent.",
				);
			}
			if (signal.aborted) throw new ProxyError(REFUSED, "The request was cancelled. Nothing was sent.");
			if (!allowed)
				throw new ProxyError(
					REFUSED,
					"The user did not allow this action, so nothing was sent. Do not try it again unless the user asks.",
				);
			// The user may have changed the connector while the card was open.
			const now = this.options.connector(connector.id);
			if (!now?.enabled || now.revision !== connector.revision)
				throw new ProxyError(
					REFUSED,
					`${connector.name} changed while the user was asked. Nothing was sent.`,
				);
			refuseHidden(now, tool);
		}
		const current = await this.upstream(connector, signal);
		refuseHidden(this.currentConnector(connector), tool);
		return await current.client.callTool(name, args, { signal, timeoutMs: CALL_TIMEOUT_MS });
	}

	private async listTools(connector: ProxiedConnector, signal: AbortSignal): Promise<Tool[]> {
		const upstream = await this.upstream(connector, signal);
		const tools = await upstream.client.listTools({ signal, timeoutMs: REQUEST_TIMEOUT_MS });
		upstream.tools = tools;
		return tools;
	}

	/** A list method; a server that does not have it has an empty list. */
	private async all<T>(
		connector: ProxiedConnector,
		signal: AbortSignal,
		list: (client: McpClient) => Promise<T[]>,
	): Promise<T[]> {
		const upstream = await this.upstream(connector, signal);
		try {
			return await list(upstream.client);
		} catch (error) {
			if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) return [];
			throw error;
		}
	}

	/** The connection to the connector's server, made when it is first needed and again after it failed. */
	private currentConnector(connector: ProxiedConnector): ProxiedConnector {
		const current = this.options.connector(connector.id);
		if (this.closed || !current?.enabled || current.unavailable || current.revision !== connector.revision)
			throw new ProxyError(REFUSED, "The connector changed or is no longer available. Nothing was sent.");
		return current;
	}

	private async upstream(connector: ProxiedConnector, signal: AbortSignal): Promise<Upstream> {
		this.currentConnector(connector);
		if (signal.aborted) throw new McpAbortError();
		let upstream = this.upstreams.get(connector.id);
		if (
			upstream &&
			(upstream.revision !== connector.revision || upstream.client.connectionState === "closed")
		) {
			this.drop(connector.id, upstream);
			upstream = undefined;
		}
		if (!upstream) {
			const client = new McpClient({
				name: "gentle-dot",
				version: "1.0.0",
				requestTimeoutMs: REQUEST_TIMEOUT_MS,
			});
			const created: Upstream = {
				client,
				revision: connector.revision,
				waiters: new Set(),
				connecting: Promise.resolve(),
			};
			created.connecting = (async () => {
				const credentials = await this.options.credentials(connector.id);
				// Connecting is shared across callers. One reader cancelling must not cancel
				// another caller, but a revoked/replaced connector must never connect late.
				this.currentConnector(connector);
				if (this.upstreams.get(connector.id) !== created)
					throw new ProxyError(REFUSED, "The connector connection was replaced. Nothing was sent.");
				if (![...created.waiters].some((waiter) => !waiter.signal.aborted)) throw new McpAbortError();
				await client.connect(this.transport(connector, credentials));
			})();
			client.onClose(() => {
				if (this.upstreams.get(connector.id) === created) this.upstreams.delete(connector.id);
			});
			this.upstreams.set(connector.id, created);
			upstream = created;
		}
		const waiter = { signal };
		upstream.waiters.add(waiter);
		try {
			await upstream.connecting;
			this.currentConnector(connector);
			if (this.upstreams.get(connector.id) !== upstream)
				throw new ProxyError(REFUSED, "The connector connection was replaced. Nothing was sent.");
		} catch (error) {
			this.drop(connector.id, upstream);
			throw error;
		} finally {
			upstream.waiters.delete(waiter);
		}
		if (signal.aborted) throw new McpAbortError();
		return upstream;
	}

	private transport(connector: ProxiedConnector, credentials: UpstreamCredentials): McpTransport {
		if (this.options.transport) return this.options.transport(connector, credentials);
		const { server } = connector;
		if ("url" in server)
			return new StreamableHttpTransport({
				url: server.url,
				...(credentials.headers ? { headers: credentials.headers } : {}),
				...(credentials.authProvider ? { authProvider: credentials.authProvider } : {}),
				// Nothing listens for the server's own messages.
				openGetStream: false,
			});
		const stdio = this.options.stdio;
		const cwd = stdio?.home ?? this.options.cwd ?? process.cwd();
		const launch = stdioCommand(stdio?.user, expandHome(server.command), (server.args ?? []).map(expandHome));
		const home: Record<string, string> = stdio
			? {
					HOME: stdio.home,
					XDG_CONFIG_HOME: join(stdio.home, ".config"),
					XDG_DATA_HOME: join(stdio.home, ".local", "share"),
					XDG_CACHE_HOME: join(stdio.home, ".cache"),
					XDG_STATE_HOME: join(stdio.home, ".local", "state"),
					TMPDIR: join(stdio.home, ".cache", "tmp"),
				}
			: {};
		return new StdioTransport({
			command: launch.command,
			...(launch.args.length > 0 ? { args: launch.args } : {}),
			cwd: resolve(cwd, expandHome(server.cwd ?? ".")),
			env: { ...stringEnv(this.options.env ?? process.env), ...home, ...credentials.env },
			inheritEnv: false,
			stderr: "pipe",
		});
	}

	private drop(id: string, upstream: Upstream): void {
		if (this.upstreams.get(id) === upstream) this.upstreams.delete(id);
		void upstream.client.close().catch(() => {});
	}

	private rpcError(connector: ProxiedConnector, error: unknown): { code: number; message: string } {
		if (error instanceof ProxyError) return { code: error.code, message: error.message };
		// A request ending locally must not disconnect other simultaneous calls to this server.
		if (error instanceof McpAbortError)
			return {
				code: REFUSED,
				message: "The request was cancelled. Check the action's status before retrying.",
			};
		if (error instanceof McpTimeoutError)
			return {
				code: REFUSED,
				message: "The connector timed out on this request. Check the action's status before retrying.",
			};
		if (error instanceof SecretsUnavailableError) {
			if (error.message !== NO_APP)
				this.log(`connector ${connector.id} cannot get its secrets: ${error.message}`);
			return { code: REFUSED, message: error.message };
		}
		// The server's own answer, passed on as it came.
		if (error instanceof McpError) return { code: error.code, message: error.message };
		const upstream = this.upstreams.get(connector.id);
		if (upstream) this.drop(connector.id, upstream);
		if (error instanceof McpOAuthAuthorizationRequiredError || error instanceof McpAuthRequiredError) {
			this.log(`connector ${connector.id} needs a new sign-in`);
			return {
				code: REFUSED,
				message: `${connector.name} needs the user to sign in again. Ask them to sign in to ${connector.name} in Connectors.`,
			};
		}
		const detail = ((error as Error)?.message ?? String(error)).replace(/https?:\/\/\S+/g, "[address]");
		this.log(`could not reach connector ${connector.id}: ${detail.slice(0, 200)}`);
		return { code: REFUSED, message: `Could not reach ${connector.name} right now. Try again in a moment.` };
	}

	private authorized(header: string | undefined): boolean {
		const given = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "")?.[1];
		if (!given || !this.key) return false;
		const a = Buffer.from(given);
		const b = Buffer.from(this.key);
		return a.length === b.length && timingSafeEqual(a, b);
	}

	private reply(
		req: IncomingMessage,
		res: ServerResponse,
		status: number,
		id: unknown,
		body: { result?: unknown; error?: { code: number; message: string } },
	): void {
		req.resume();
		if (res.headersSent || res.destroyed) return;
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, ...body }));
	}

	private empty(req: IncomingMessage, res: ServerResponse, status: number): void {
		req.resume();
		if (res.headersSent || res.destroyed) return;
		res.writeHead(status).end();
	}

	private log(line: string): void {
		this.options.log?.(line);
	}
}

function requestKey(connector: string, id: string | number): string {
	return `${connector}\u0000${typeof id}\u0000${String(id)}`;
}

/** Reads like resources and prompts: in "read and send", or in read only for a connector with a curated list. */
function readsAllowed(connector: ProxiedConnector): boolean {
	return connector.enabled && (connector.mode === "read_write" || connector.readOnlyTools.length > 0);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(new McpReadError("READ_CANCELLED", "Consulta cancelada."));
		if (signal.aborted) {
			void promise.catch(() => {});
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/** Read only shows only read-only tools; "read and send" shows all of them. */
function visible(connector: ProxiedConnector, tool: Tool): boolean {
	return (
		connector.mode === "read_write" ||
		isReadOnlyTool(tool.name, tool.annotations?.readOnlyHint, connector.readOnlyTools)
	);
}

function refuseHidden(connector: ProxiedConnector, tool: Tool): void {
	if (visible(connector, tool)) return;
	throw new ProxyError(
		JSON_RPC_ERROR_CODES.invalidParams,
		`${connector.name} is set to read only, so ${tool.name} is not available and nothing was sent. If the user wants it, ask them to switch ${connector.name} to "Read and send" in Connectors.`,
	);
}

function notAvailable(connector: ProxiedConnector): string {
	return `${connector.name} is set to read only, so this is not available. If the user wants it, ask them to switch ${connector.name} to "Read and send" in Connectors.`;
}

/** Every prompt, following `nextCursor` (pi-mcp's client has no helper for prompts). */
async function listPrompts(client: McpClient, signal: AbortSignal): Promise<unknown[]> {
	const prompts: unknown[] = [];
	let cursor: string | undefined;
	do {
		const page = await client.request<{ prompts?: unknown[]; nextCursor?: string }>(
			"prompts/list",
			cursor ? { cursor } : {},
			{ signal, timeoutMs: REQUEST_TIMEOUT_MS },
		);
		prompts.push(...(page.prompts ?? []));
		cursor = page.nextCursor;
	} while (cursor);
	return prompts;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** The body, or undefined when it is larger than the limit. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY) return undefined;
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	return Object.fromEntries(
		Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
}

/** `~` and `~/…` name the home folder, as the engine reads a server's command. */
function expandHome(value: string): string {
	if (value === "~") return homedir();
	return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}
