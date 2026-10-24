import { textOf } from "./presentation.ts";
import { SHARED_FILE_ID } from "./shared-files.ts";

const SHARE_SCREENSHOT_TOOL = "dot_share_screenshot";
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

/** Only metadata from a successful explicit publication can become a visible chat image. */
function publicationId(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	if ((result as { isError?: unknown }).isError) return undefined;
	const text = textOf(result);
	if (!text || text.length > 16_384) return undefined;
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (
		!value ||
		typeof value !== "object" ||
		typeof value.id !== "string" ||
		!SHARED_FILE_ID.test(value.id) ||
		value.mime !== "image/jpeg" ||
		value.image !== true ||
		typeof value.name !== "string" ||
		!value.name ||
		Buffer.byteLength(value.name) > 240 ||
		!Number.isSafeInteger(value.size) ||
		(value.size as number) <= 0 ||
		(value.size as number) > MAX_CAPTURE_BYTES ||
		typeof value.markdown !== "string"
	)
		return undefined;
	// Never forward a tool-supplied label, URL, HTML, or trailing markdown into the chat.
	const image = new RegExp(`^!\\[(?:[^\\\\\\]\\r\\n]|\\\\.)+\\]\\(/api/files/${value.id}/content\\)$`);
	return image.test(value.markdown) ? value.id : undefined;
}

function containsImage(text: string, id: string): boolean {
	return new RegExp(`!\\[(?:[^\\\\\\]]|\\\\.)*\\]\\(<?/api/files/${id}/content>?\\)`).test(text);
}

export function hasToolCalls(message: unknown): boolean {
	const content = (message as { content?: unknown } | null)?.content;
	return Array.isArray(content) && content.some((block) => block?.type === "toolCall");
}

/** One user turn's explicit screenshot publications, shared by streaming and persisted history. */
export class ScreenshotDelivery {
	private readonly calls = new Set<string>();
	private readonly publications = new Set<string>();
	private displayedText = "";

	reset(): void {
		this.calls.clear();
		this.publications.clear();
		this.displayedText = "";
	}

	start(toolCallId: unknown, toolName: unknown): void {
		if (toolName === SHARE_SCREENSHOT_TOOL && typeof toolCallId === "string" && toolCallId)
			this.calls.add(toolCallId);
	}

	result(toolCallId: unknown, result: unknown, isError: unknown): void {
		if (typeof toolCallId !== "string" || !this.calls.delete(toolCallId) || isError) return;
		const id = publicationId(result);
		if (id) this.publications.add(id);
	}

	/** Adds missing images only to the final successful answer, never a preceding tool-call message. */
	finish(text: string, stopReason: unknown, intermediate: boolean): string {
		if (stopReason === "aborted" || stopReason === "error") {
			this.reset();
			return text;
		}
		this.displayedText += `\n\n${text}`;
		if (intermediate) return text;
		const images = [...this.publications]
			.filter((id) => !containsImage(this.displayedText, id))
			.map((id) => `![Captura del equipo](/api/files/${id}/content)`);
		this.reset();
		return [text, ...images].filter(Boolean).join("\n\n");
	}
}
