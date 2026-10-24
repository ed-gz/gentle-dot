import { randomUUID } from "node:crypto";
import { MAX_VOICE_AUDIO } from "@gentle-dot/protocol";
import type { VoiceResult } from "./voice.ts";

interface DesktopVoiceChannel {
	readonly connected: boolean;
	request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
}

const TIMEOUT_REASON = "PC voice did not answer in time. Try phone dictation.";

/** Audio crosses the private channel in small frames; no files or listening sockets. */
export class LocalVoice {
	private readonly app: DesktopVoiceChannel;
	private readonly timeoutMs: number;

	constructor(app: DesktopVoiceChannel, timeoutMs = 75_000) {
		this.app = app;
		this.timeoutMs = timeoutMs;
	}

	async available(): Promise<boolean> {
		if (!this.app.connected) return false;
		try {
			const result = (await this.app.request("voice_status", {}, 2_000)) as { installed?: unknown };
			return this.app.connected && result?.installed === true;
		} catch {
			return false;
		}
	}

	async transcribe(mime: string, data: string): Promise<VoiceResult<{ text: string }>> {
		if (mime !== "audio/wav" || data.length > MAX_VOICE_AUDIO || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
			return { ok: false, reason: "PC voice needs a WAV recording under one minute." };
		}
		if (!this.app.connected) return { ok: false, reason: "PC voice is disconnected." };
		const id = randomUUID();
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const work = async (): Promise<VoiceResult<{ text: string }>> => {
				const request = (method: string, params: unknown) =>
					this.app.request(method, params, this.timeoutMs, controller.signal);
				await request("voice_begin", { id });
				// A multiple of four keeps each chunk independently decodable as base64.
				for (let offset = 0; offset < data.length; offset += 256_000) {
					await request("voice_chunk", { id, data: data.slice(offset, offset + 256_000) });
				}
				const reply = (await request("voice_finish", { id })) as { text?: unknown };
				const text = typeof reply?.text === "string" ? reply.text.trim() : "";
				return text ? { ok: true, text } : { ok: false, reason: "PC voice heard no speech." };
			};
			return await Promise.race([
				work(),
				new Promise<VoiceResult<{ text: string }>>((resolve) => {
					timer = setTimeout(() => {
						controller.abort();
						resolve({ ok: false, reason: TIMEOUT_REASON });
					}, this.timeoutMs);
				}),
			]);
		} catch {
			return {
				ok: false,
				reason: controller.signal.aborted ? TIMEOUT_REASON : "PC voice is unavailable. Try phone dictation.",
			};
		} finally {
			clearTimeout(timer);
			controller.abort();
			if (this.app.connected) void this.app.request("voice_cancel", { id }, 2_000).catch(() => {});
		}
	}
}
