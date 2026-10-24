import { SharedFileError, sharedFileMime } from "./shared-files.ts";
import type { SupervisorEvent } from "./supervisor.ts";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const COMPUTER_PREFIX = "mcp__computer__";
const CAPTURE_TOOLS = new Set([
	"screenshot",
	"click",
	"move",
	"drag",
	"scroll",
	"type",
	"key",
	"open_app",
	"wait",
	"batch",
]);
const NO_CAPTURE_TOOLS = new Set(["capabilities", "list_apps"]);

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function screenshot(result: unknown): Buffer | undefined {
	const value = record(result);
	if (!value || (value.isError !== undefined && value.isError !== false) || !Array.isArray(value.content))
		return;
	const images = value.content.map(record).filter((block) => block?.type === "image");
	if (images.length !== 1) return;
	const image = images[0];
	if (
		image?.mimeType !== "image/jpeg" ||
		typeof image.data !== "string" ||
		image.data.length > Math.ceil(MAX_CAPTURE_BYTES / 3) * 4 ||
		!image.data.length ||
		image.data.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
	)
		return;
	const bytes = Buffer.from(image.data, "base64");
	if (
		bytes.length > MAX_CAPTURE_BYTES ||
		bytes.toString("base64") !== image.data ||
		sharedFileMime(bytes).mime !== "image/jpeg"
	)
		return;
	return bytes;
}

/** Keeps only the last native screenshot observed during the current run, without publishing it. */
export class ComputerCaptureStore {
	private active = false;
	private capture?: Buffer;
	private pending?: { id: string; tool: string };

	/** Disconnect, Stop, and conversation changes invalidate both pixels and in-flight results. */
	clear(): void {
		this.active = false;
		this.capture = undefined;
		this.pending = undefined;
	}

	observe(event: SupervisorEvent): void {
		if (event.type === "agent_start") {
			this.clear();
			this.active = true;
			return;
		}
		if (
			["agent_end", "agent_settled", "interrupted"].includes(event.type) ||
			(event.type === "supervisor_state" && event.state !== "ready")
		) {
			this.clear();
			return;
		}
		if (event.type === "message_start" && record(event.message)?.role === "user") {
			this.capture = undefined;
			this.pending = undefined;
			return;
		}
		if (!this.active) return;
		if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return;
		const tool = typeof event.toolName === "string" ? event.toolName : "";
		if (!tool.startsWith(COMPUTER_PREFIX)) return;
		const name = tool.slice(COMPUTER_PREFIX.length);
		if (NO_CAPTURE_TOOLS.has(name)) return;
		if (event.type === "tool_execution_start") {
			// A newer action can change the display, even if it subsequently fails or is refused.
			this.capture = undefined;
			this.pending = undefined;
			if (
				CAPTURE_TOOLS.has(name) &&
				typeof event.toolCallId === "string" &&
				event.toolCallId.length > 0 &&
				event.toolCallId.length <= 512
			)
				this.pending = { id: event.toolCallId, tool };
			return;
		}
		if (
			event.type !== "tool_execution_end" ||
			!this.pending ||
			event.toolCallId !== this.pending.id ||
			tool !== this.pending.tool
		)
			return;
		this.pending = undefined;
		if (event.isError === false) this.capture = screenshot(event.result);
	}

	/** Called by an explicit sharing tool. A copied Buffer cannot mutate the observed capture. */
	latest(): Buffer {
		if (!this.active || !this.capture)
			throw new SharedFileError(
				"COMPUTER_CAPTURE_REQUIRED",
				"Toma una nueva captura con mcp__computer__screenshot en este turno antes de compartirla.",
				409,
			);
		return Buffer.from(this.capture);
	}
}
