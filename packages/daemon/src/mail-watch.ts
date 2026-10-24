import type { Tool } from "@earendil-works/pi-mcp";
import { type McpProxy, McpReadError, type ProxiedConnector } from "./mcp-proxy.ts";
import type { WatchCursor, WatchEvent } from "./watchers.ts";

// Google primary reference, reviewed 2026-10-11:
// https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/search_threads
// MINIMAL contains headers/snippets; neither full bodies nor arbitrary MCP actions are needed.
const GMAIL_URL = "https://gmailmcp.googleapis.com/mcp/v1";
const TOOL = "search_threads";
const DAY = 86_400_000;
const MAX_SEEN = 512;
const MAX_PENDING = 40;
const MAX_CURSOR_BYTES = 128 * 1024;
const QUERY = "newer_than:2d";
const ID = /^[a-zA-Z0-9_-]{1,128}$/;

type MailEvent = WatchEvent & { kind: "email"; messageId: string };
type Cursor = {
	v: 1;
	revision: string;
	baselineAt: number;
	checkedAt: number;
	seen: Array<{ id: string; day: string }>;
	pending: MailEvent[];
};
export interface MailWatchOptions {
	proxy: Pick<McpProxy, "prepareRead" | "readOnlyTools" | "readOnly">;
	connector(id: string): ProxiedConnector | undefined;
	now?: () => number;
}
export class MailWatchError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}
const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (code: string, message: string): never => {
	throw new MailWatchError(code, message);
};
const day = (time: number) => new Date(time).toISOString().slice(0, 10);
const plain = (value: unknown, max: number): string =>
	typeof value === "string"
		? value
				.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ")
				.trim()
				.slice(0, max)
		: "";
function schemaHas(schema: unknown, type: string, enumValue?: string): boolean {
	if (!record(schema)) return false;
	if (Array.isArray(schema.anyOf) && schema.anyOf.some((item) => schemaHas(item, type, enumValue)))
		return true;
	if (Array.isArray(schema.oneOf) && schema.oneOf.some((item) => schemaHas(item, type, enumValue)))
		return true;
	return (
		(schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type))) &&
		(enumValue === undefined || (Array.isArray(schema.enum) && schema.enum.includes(enumValue)))
	);
}
function compatible(tool: Tool | undefined): boolean {
	if (tool?.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true) return false;
	const schema = tool.inputSchema;
	const props = schema.properties;
	if (!record(props)) return false;
	const names = ["pageSize", "pageToken", "query", "includeTrash", "view"];
	if (Array.isArray(schema.required) && schema.required.some((key) => !names.includes(key))) return false;
	return (
		schemaHas(props.pageSize, "integer") &&
		schemaHas(props.pageToken, "string") &&
		schemaHas(props.query, "string") &&
		schemaHas(props.includeTrash, "boolean") &&
		schemaHas(props.view, "string", "THREAD_VIEW_MINIMAL")
	);
}
function payload(value: unknown): Record<string, unknown> {
	if (!record(value) || value.isError === true)
		return fail("MAIL_SOURCE", "Gmail no pudo consultar los mensajes. Revisa el conector.");
	if (record(value.structuredContent)) return value.structuredContent;
	const blocks = value.content;
	if (
		!Array.isArray(blocks) ||
		blocks.length !== 1 ||
		!record(blocks[0]) ||
		blocks[0].type !== "text" ||
		typeof blocks[0].text !== "string" ||
		Buffer.byteLength(blocks[0].text, "utf8") > 1024 * 1024
	)
		return fail("MAIL_FORMAT", "La respuesta de Gmail no tiene el formato compatible.");
	try {
		const parsed: unknown = JSON.parse(blocks[0].text);
		if (record(parsed)) return parsed;
	} catch {
		/* Never echo source content. */
	}
	return fail("MAIL_FORMAT", "La respuesta de Gmail no tiene el formato compatible.");
}
function parseCursor(value: WatchCursor | undefined): Cursor | undefined {
	if (value === undefined) return;
	if (
		!record(value) ||
		value.v !== 1 ||
		typeof value.revision !== "string" ||
		value.revision.length > 256 ||
		!Number.isSafeInteger(value.baselineAt) ||
		!Number.isSafeInteger(value.checkedAt) ||
		(value.baselineAt as number) < 0 ||
		(value.checkedAt as number) < (value.baselineAt as number) ||
		!Array.isArray(value.seen) ||
		value.seen.length > MAX_SEEN ||
		!Array.isArray(value.pending) ||
		value.pending.length > MAX_PENDING ||
		Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_CURSOR_BYTES
	)
		return fail(
			"MAIL_CURSOR",
			"El registro de correo no es válido. Reinicia este pendiente para crear una referencia nueva.",
		);
	const seen: Cursor["seen"] = [];
	for (const entry of value.seen) {
		if (
			!record(entry) ||
			typeof entry.id !== "string" ||
			!ID.test(entry.id) ||
			typeof entry.day !== "string" ||
			!/^\d{4}-\d{2}-\d{2}$/.test(entry.day)
		)
			return fail(
				"MAIL_CURSOR",
				"El registro de correo no es válido. Reinicia este pendiente para crear una referencia nueva.",
			);
		seen.push({ id: entry.id, day: entry.day });
	}
	const pending: MailEvent[] = [];
	for (const entry of value.pending) {
		if (
			!record(entry) ||
			entry.kind !== "email" ||
			typeof entry.messageId !== "string" ||
			!ID.test(entry.messageId) ||
			entry.id !== `gmail:${entry.messageId}` ||
			typeof entry.at !== "string" ||
			!Number.isFinite(Date.parse(entry.at)) ||
			typeof entry.title !== "string" ||
			entry.title.length > 256 ||
			typeof entry.summary !== "string" ||
			entry.summary.length > 800
		)
			return fail(
				"MAIL_CURSOR",
				"El registro de correo no es válido. Reinicia este pendiente para crear una referencia nueva.",
			);
		pending.push({
			id: entry.id,
			at: entry.at,
			kind: "email",
			messageId: entry.messageId,
			title: entry.title,
			summary: entry.summary,
		});
	}
	return {
		v: 1,
		revision: value.revision,
		baselineAt: value.baselineAt as number,
		checkedAt: value.checkedAt as number,
		seen,
		pending,
	};
}

/** Polls an existing Gmail connector only when the durable watcher explicitly calls email(). */
export class MailWatch {
	private readonly options: MailWatchOptions;
	constructor(options: MailWatchOptions) {
		this.options = options;
	}

	available(): Array<{ id: string; label: string; configured: boolean; available: boolean; error?: string }> {
		const connector = this.options.connector("gmail");
		const configured = !!connector?.enabled && this.supported(connector);
		const available = configured && !connector?.unavailable;
		return [
			{
				id: "gmail",
				label: "Gmail",
				configured,
				available,
				...(!available
					? {
							error: configured
								? "La conexión está configurada; sus credenciales deben estar disponibles para consultar el correo."
								: "Conecta y activa Gmail en Conectores para observar mensajes nuevos.",
						}
					: {}),
			},
		];
	}
	private supported(connector: ProxiedConnector): boolean {
		return (
			connector.id === "gmail" &&
			"url" in connector.server &&
			connector.server.url === GMAIL_URL &&
			connector.readOnlyTools.includes(TOOL)
		);
	}
	private current(id: string, signal: AbortSignal, allowLocked = false): ProxiedConnector {
		if (signal.aborted) return fail("MAIL_CANCELLED", "Consulta cancelada.");
		const connector = this.options.connector(id);
		if (!connector || !this.supported(connector))
			return fail(
				"MAIL_UNSUPPORTED",
				"Este conector no tiene un adaptador de correo compatible. Usa el conector Gmail del catálogo.",
			);
		if (!connector.enabled || (!allowLocked && connector.unavailable))
			return fail("MAIL_UNAVAILABLE", "Gmail no está disponible. Revisa su conexión en Conectores.");
		return connector;
	}

	async email(
		id: string,
		value: WatchCursor | undefined,
		signal: AbortSignal,
	): Promise<{ cursor: WatchCursor; events: WatchEvent[] }> {
		this.current(id, signal, true);
		const old = parseCursor(value);
		// Unlock existing values only for an authorized probe. Capture identity afterwards so a
		// cold secret cache after restart cannot look like an account change or disable polling.
		try {
			await this.options.proxy.prepareRead(id, signal);
		} catch (error) {
			if (error instanceof McpReadError) throw error;
			return fail("MAIL_SOURCE", "No se pudo preparar Gmail. Revisa la conexión del conector.");
		}
		const connector = this.current(id, signal);
		if (old && old.revision !== connector.revision)
			return fail(
				"MAIL_ACCOUNT_CHANGED",
				"La conexión de Gmail cambió. Reinicia este pendiente para evitar mezclar cuentas.",
			);
		const now = Math.floor((this.options.now ?? Date.now)());
		if (old && now < old.checkedAt)
			return fail("MAIL_CLOCK", "La hora del equipo cambió. Espera a que se sincronice.");
		if (old?.pending.length)
			return this.result({ ...old, pending: old.pending.slice(20) }, old.pending.slice(0, 20));
		// The MCP server has no historyId. Report a gap rather than silently skipping a long outage.
		if (old && now - old.checkedAt >= 2 * DAY)
			return fail(
				"MAIL_GAP",
				"La consulta de correo lleva más de dos días sin completarse. Revisa Gmail y reinicia este pendiente.",
			);
		const assertCurrent = () => {
			if (this.current(id, signal).revision !== connector.revision)
				fail(
					"MAIL_ACCOUNT_CHANGED",
					"La conexión de Gmail cambió durante la consulta. Reinicia este pendiente.",
				);
		};
		try {
			const tools = await this.options.proxy.readOnlyTools(id, signal);
			assertCurrent();
			if (!compatible(tools.find((tool) => tool.name === TOOL)))
				return fail(
					"MAIL_SCHEMA",
					"La herramienta de Gmail cambió. Se necesita revisar su adaptador antes de consultar.",
				);
			const cutoff = day(now - 3 * DAY);
			const seen = new Map(
				(old?.seen ?? []).filter((entry) => entry.day >= cutoff).map((entry) => [entry.id, entry.day]),
			);
			const found: MailEvent[] = [];
			const tokens = new Set<string>();
			let pageToken: string | undefined;
			for (let page = 0; page < 4; page++) {
				assertCurrent();
				const raw = await this.options.proxy.readOnly(
					id,
					TOOL,
					{
						query: QUERY,
						pageSize: 50,
						includeTrash: false,
						view: "THREAD_VIEW_MINIMAL",
						...(pageToken ? { pageToken } : {}),
					},
					signal,
				);
				assertCurrent();
				const data = payload(raw);
				if (
					Object.keys(data).some((key) => !["threads", "nextPageToken", "resultCountEstimate"].includes(key))
				)
					return fail("MAIL_FORMAT", "Gmail devolvió una respuesta distinta de la lista de conversaciones.");
				const threads = data.threads === undefined ? [] : data.threads;
				if (!Array.isArray(threads) || threads.length > 50)
					return fail("MAIL_FORMAT", "Gmail devolvió una lista de conversaciones no compatible.");
				for (const thread of threads) {
					const messages =
						record(thread) && thread.messages === undefined
							? []
							: record(thread)
								? thread.messages
								: undefined;
					if (!Array.isArray(messages) || messages.length > MAX_SEEN)
						return fail("MAIL_FORMAT", "Gmail devolvió una conversación no compatible.");
					for (const message of messages) {
						const labels =
							record(message) && message.labelIds === undefined
								? []
								: record(message)
									? message.labelIds
									: undefined;
						if (
							!record(message) ||
							typeof message.id !== "string" ||
							!ID.test(message.id) ||
							typeof message.date !== "string" ||
							!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(message.date) ||
							!Number.isFinite(Date.parse(message.date)) ||
							!Array.isArray(labels) ||
							labels.some((label) => typeof label !== "string")
						)
							return fail(
								"MAIL_FORMAT",
								"Gmail devolvió metadatos incompletos; no se avanzó el registro de correo.",
							);
						const messageDay = message.date.slice(0, 10);
						if (messageDay < cutoff) continue; // An old message may accompany a new reply in the same thread.
						const known = seen.has(message.id);
						seen.set(message.id, messageDay);
						if (seen.size > MAX_SEEN)
							return fail(
								"MAIL_LIMIT",
								"Hay demasiados mensajes recientes para observarlos sin perder resultados.",
							);
						if (
							!old ||
							known ||
							messageDay < day(old.baselineAt) ||
							(message.date.length > 10 && Date.parse(message.date) < old.baselineAt) ||
							labels.some((label) => ["SENT", "DRAFT", "SPAM", "TRASH", "CHAT"].includes(String(label)))
						)
							continue;
						found.push({
							id: `gmail:${message.id}`,
							messageId: message.id,
							kind: "email",
							at: new Date(now).toISOString(),
							title: plain(message.subject, 256) || "Correo sin asunto",
							summary: [plain(message.sender, 256), plain(message.snippet, 512)].filter(Boolean).join(" — "),
						});
						if (found.length > MAX_PENDING + 20)
							return fail(
								"MAIL_LIMIT",
								"Llegaron demasiados mensajes para procesarlos sin perder resultados. Revisa Gmail.",
							);
					}
				}
				if (data.nextPageToken === undefined || data.nextPageToken === "") break;
				if (
					typeof data.nextPageToken !== "string" ||
					data.nextPageToken.length > 4096 ||
					tokens.has(data.nextPageToken)
				)
					return fail("MAIL_FORMAT", "Gmail no pudo avanzar su lista de mensajes.");
				if (page === 3)
					return fail(
						"MAIL_LIMIT",
						"Hay más de 200 conversaciones recientes. No se avanzó el registro para evitar perder mensajes.",
					);
				pageToken = data.nextPageToken;
				tokens.add(pageToken);
			}
			assertCurrent();
			return this.result(
				{
					v: 1,
					revision: connector.revision,
					baselineAt: old?.baselineAt ?? now,
					checkedAt: now,
					seen: [...seen].map(([messageId, messageDay]) => ({ id: messageId, day: messageDay })),
					pending: found.slice(20),
				},
				found.slice(0, 20),
			);
		} catch (error) {
			if (error instanceof MailWatchError || error instanceof McpReadError) throw error;
			return fail("MAIL_SOURCE", "No se pudo consultar Gmail. Revisa la conexión del conector.");
		}
	}
	private result(cursor: Cursor, events: MailEvent[]): { cursor: WatchCursor; events: WatchEvent[] } {
		if (Buffer.byteLength(JSON.stringify(cursor), "utf8") > MAX_CURSOR_BYTES)
			return fail(
				"MAIL_LIMIT",
				"El registro de correo alcanzó su límite. No se avanzó para evitar perder mensajes.",
			);
		return {
			cursor: {
				...cursor,
				pending: cursor.pending.map((event) => ({
					id: event.id,
					at: event.at,
					kind: event.kind,
					messageId: event.messageId,
					title: event.title,
					summary: event.summary ?? "",
				})),
			},
			events,
		};
	}
}
