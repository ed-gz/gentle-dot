import { MAX_VOICE_AUDIO, MAX_VOICE_TEXT } from "@gentle-dot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { newRequestId, type Send } from "./components/types.ts";
import { inDesktop } from "./desktop.ts";
import { mobileBridge } from "./mobile.ts";
import { guessLanguage, pickVoice, speakableText } from "./speech.ts";
import { type DotState, isBusy } from "./store.ts";
import { capturePcm, type PcmCapture } from "./voice-capture.ts";
import { voiceLanguage } from "./voice-language.ts";
import {
	cancelNativeVoice,
	type NativeVoiceStatus,
	nativeVoiceStatus,
	onNativeVoice,
	onVoiceModel,
	startNativeVoice,
	startRefusal,
	stopNativeVoice,
} from "./voice-native.ts";

export type VoicePhase = "idle" | "recording" | "transcribing";

/** The mic button: usable, or disabled with the reason. */
export type MicState = { available: true } | { available: false; reason: string };

/** Talking to the assistant (S30.2–S30.4), as the composer and the header use it. */
export interface VoiceControls {
	/** Undefined when the mic is not offered at all (the web without an OpenAI key). */
	mic?: MicState;
	phase: VoicePhase;
	/** A platform is preparing this composer's microphone or awaiting permission. */
	inputBusy?: boolean;
	/** Seconds since recording started. */
	elapsed: number;
	/** Microphone level, 0 to 1. */
	level: number;
	/** Live text from the desktop recognizer. */
	partial: string;
	/** Why the last attempt did not work. */
	note?: string;
	speaking: boolean;
	muted: boolean;
	start(): void;
	stop(): void;
	cancel(): void;
	stopSpeaking(): void;
	setMuted(muted: boolean): void;
	/** The user sent a typed message: its reply is not read aloud. */
	typed(): void;
	/** Whether a dictation is sent when recording stops, or left in the input for review. */
	sendOnStop: boolean;
	setSendOnStop(send: boolean): void;
	/** A dictation waiting in the input for review; `id` changes with each one. */
	draft?: { id: number; text: string; receipt?: unknown };
	/** The input took the draft. */
	draftTaken(id: number): void;
	/** Leave a platform-retained dictation for later review without acknowledging it. */
	deferDraft?(id: number): void;
	/** The user sent the input: its reply is read aloud when it included a dictation. */
	sent(): void;
}

/** Recordings stop on their own so they fit the daemon's WebSocket limit (S30.2). */
const MAX_RECORDING_MS = 60_000;
const MUTED_KEY = "gentle-dot-voice-muted";
/** Set when a dictation is sent on stop; otherwise it stays in the input for review. */
const SEND_KEY = "gentle-dot-voice-send";
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
const REASONS = {
	checking: "Checking local voice availability.",
	insecure: "Voice needs a secure page (HTTPS or localhost).",
	noRecorder: "This browser cannot record audio.",
	denied: "Microphone access was denied. Allow it to talk to the assistant.",
	tooLong: "That recording is too long. Keep it under a minute.",
	empty: "I didn't catch anything. Try again.",
} as const;

const MOBILE_REASONS: Record<string, string> = {
	[REASONS.checking]: "Comprobando el dictado de la PC…",
	[REASONS.insecure]: "El dictado necesita una conexión segura.",
	[REASONS.noRecorder]: "Este navegador no puede grabar audio.",
	[REASONS.denied]: "Permití el micrófono para dictar con la PC",
	[REASONS.tooLong]: "La grabación es muy larga. Usá menos de un minuto.",
	[REASONS.empty]: "No escuché nada. Probá de nuevo.",
};

function captureRefusal(error: unknown): string {
	const name = typeof error === "object" && error !== null && "name" in error ? error.name : undefined;
	return name === "NotAllowedError" || name === "SecurityError"
		? "Permití el micrófono para dictar con la PC"
		: "No se pudo grabar el audio. Probá de nuevo.";
}

type Source = { kind: "daemon" | "native" | "mobile" | "pc" } | { kind: "none"; reason?: string };

/**
 * Android prefers PC WAV dictation, with its native recognizer as backup. Desktop prefers
 * its native recognizer. The web offers daemon transcription over HTTPS or localhost.
 */
function chooseSource(desktop: boolean, transcribe: boolean, native: NativeVoiceStatus | undefined, local = false): Source {
	if (mobileBridge()) return { kind: local ? "pc" : "mobile" };
	// Wait for local capability discovery before offering a remote recording path.
	if (desktop && !native) return { kind: "none", reason: REASONS.checking };
	if (desktop && native?.available) return { kind: "native" };
	const secure = desktop || window.isSecureContext === true;
	const recorder = typeof MediaRecorder !== "undefined" && navigator.mediaDevices?.getUserMedia !== undefined;
	if (transcribe && secure && recorder) return { kind: "daemon" };
	if (desktop) {
		if (!native) return { kind: "none" };
		return native.available
			? { kind: "native" }
			: { kind: "none", reason: native.reason ?? REASONS.noRecorder };
	}
	if (!transcribe) return { kind: "none" };
	return { kind: "none", reason: secure ? REASONS.noRecorder : REASONS.insecure };
}

interface Recording {
	kind: "daemon" | "native" | "pc";
	pcm?: PcmCapture;
	cancelled: boolean;
	recorder?: MediaRecorder;
	ticker?: ReturnType<typeof setInterval>;
	limit?: ReturnType<typeof setTimeout>;
	stopMeter?: () => void;
}

/** Stops the elapsed-time ticker, the length limit, and the level meter. */
function stopTimers(entry: Recording): void {
	clearInterval(entry.ticker);
	clearTimeout(entry.limit);
	entry.stopMeter?.();
}

export function useVoice(
	state: DotState,
	send: Send,
	options?: { inputOnly: true; enabled: boolean },
): VoiceControls {
	const inputOnly = options?.inputOnly === true;
	const enabled = options?.enabled ?? true;
	const allowed = useRef(enabled);
	allowed.current = enabled;
	const generation = useRef(0);
	const desktop = inDesktop();
	const [native, setNative] = useState<NativeVoiceStatus | undefined>(undefined);
	const [phase, setPhaseState] = useState<VoicePhase>("idle");
	const [elapsed, setElapsed] = useState(0);
	const [level, setLevel] = useState(0);
	const [partial, setPartial] = useState("");
	const [note, setNote] = useState<string | undefined>(undefined);
	const [speaking, setSpeaking] = useState(false);
	const [muted, setMutedState] = useState(() => readFlag(MUTED_KEY));

	const phaseNow = useRef<VoicePhase>("idle");
	const recording = useRef<Recording | undefined>(undefined);
	const starting = useRef(false);
	const pendingTranscript = useRef<string | undefined>(undefined);
	const pendingSpeech = useRef<{ requestId: string; text: string } | undefined>(undefined);
	const audio = useRef<HTMLAudioElement | undefined>(undefined);
	/** A reply to a spoken message is awaited: the ids of the messages shown before it. */
	const voiceTurn = useRef<Set<string> | undefined>(undefined);
	const latest = useRef(state);
	latest.current = state;
	const mutedNow = useRef(muted);
	mutedNow.current = muted;

	const source = chooseSource(desktop, state.voice.transcribe, native, "local" in state.voice && state.voice.local === true);
	const transcriptTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const mobileFallback = useRef<() => Promise<void>>(async () => {});

	const setPhase = useCallback((next: VoicePhase) => {
		phaseNow.current = next;
		setPhaseState(next);
	}, []);

	const finish = useCallback(
		(reason?: string) => {
			if (recording.current) stopTimers(recording.current);
			recording.current = undefined;
			pendingTranscript.current = undefined;
			clearTimeout(transcriptTimer.current);
			setPhase("idle");
			setElapsed(0);
			setLevel(0);
			setPartial("");
			setNote(reason && mobileBridge() ? (MOBILE_REASONS[reason] ?? reason) : reason);
		},
		[setPhase],
	);

	const stopSpeaking = useCallback(() => {
		pendingSpeech.current = undefined;
		audio.current?.pause();
		audio.current = undefined;
		globalThis.speechSynthesis?.cancel();
		setSpeaking(false);
	}, []);

	const speakWithSystem = useCallback((text: string) => {
		const synth = globalThis.speechSynthesis;
		if (!synth || typeof SpeechSynthesisUtterance === "undefined") return;
		const utterance = new SpeechSynthesisUtterance(text);
		const language = guessLanguage(text) ?? navigator.language.slice(0, 2).toLowerCase();
		utterance.lang = language;
		const voice = pickVoice(synth.getVoices(), language, navigator.language);
		if (voice) utterance.voice = voice;
		utterance.onend = () => setSpeaking(false);
		synth.speak(utterance);
		setSpeaking(true);
	}, []);

	const speak = useCallback(
		(reply: string) => {
			const text = speakableText(reply).slice(0, MAX_VOICE_TEXT);
			if (!text || mutedNow.current) return;
			if (!latest.current.voice.speak) {
				speakWithSystem(text);
				return;
			}
			const requestId = newRequestId();
			pendingSpeech.current = { requestId, text };
			send({ type: "voice_speak", requestId, text });
		},
		[send, speakWithSystem],
	);

	const [sendOnStop, setSendOnStopState] = useState(readFlag(SEND_KEY));
	const sendOnStopNow = useRef(sendOnStop);
	sendOnStopNow.current = sendOnStop;
	const [draft, setDraft] = useState<{ id: number; text: string }>();
	/** The input holds dictated text that has not been sent yet. */
	const dictated = useRef(false);

	const sendTranscript = useCallback(
		(transcript: string) => {
			const text = transcript.trim();
			if (!text) {
				finish(REASONS.empty);
				return;
			}
			// The Android dialog returns a draft. Remote computer instructions always get a review.
			if (!inputOnly && sendOnStopNow.current && !mobileBridge()) {
				voiceTurn.current = new Set(latest.current.messages.map((m) => m.id));
				send({ type: "send", text, requestId: newRequestId() });
			} else {
				dictated.current = true;
				setDraft((previous) => ({ id: (previous?.id ?? 0) + 1, text }));
			}
			finish();
		},
		[send, finish, inputOnly],
	);

	const setSendOnStop = useCallback((next: boolean) => {
		setSendOnStopState(next);
		try {
			if (next) localStorage.setItem(SEND_KEY, "1");
			else localStorage.removeItem(SEND_KEY);
		} catch {
			// Private browsing: the choice lasts for this window only.
		}
	}, []);

	const draftTaken = useCallback((id: number) => {
		setDraft((current) => (current?.id === id ? undefined : current));
	}, []);

	const sent = useCallback(() => {
		if (inputOnly) return;
		voiceTurn.current = dictated.current ? new Set(latest.current.messages.map((m) => m.id)) : undefined;
		dictated.current = false;
	}, [inputOnly]);

	const begin = useCallback(
		(entry: Recording) => {
			const started = Date.now();
			entry.ticker = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
			recording.current = entry;
			setNote(undefined);
			setPartial("");
			setElapsed(0);
			setPhase("recording");
		},
		[setPhase],
	);

	const upload = useCallback(
		async (blob: Blob, mime: string) => {
			const attempt = generation.current;
			setPhase("transcribing");
			const data = await toBase64(blob);
			if (attempt !== generation.current || !allowed.current) return;
			if (data.length > MAX_VOICE_AUDIO) {
				finish(REASONS.tooLong);
				return;
			}
			const requestId = newRequestId();
			pendingTranscript.current = requestId;
			if (send({ type: "voice_transcribe", requestId, mime: mime.replace(/\s+/g, ""), data }) === false) {
				pendingTranscript.current = undefined;
				if (mobileBridge()) await mobileFallback.current();
				else finish("Voice is disconnected.");
				return;
			}
			transcriptTimer.current = setTimeout(() => {
				if (pendingTranscript.current !== requestId || attempt !== generation.current) return;
				pendingTranscript.current = undefined;
				if (mobileBridge()) void mobileFallback.current();
				else finish("Voice did not answer in time.");
			}, 85_000);
		},
		[send, finish, setPhase],
	);

	const stop = useCallback(() => {
		const current = recording.current;
		if (!current || phaseNow.current !== "recording") return;
		stopTimers(current);
		if (current.kind === "pc") {
			setPhase("transcribing");
			const attempt = generation.current;
			const failed = (error: unknown) => {
				if (attempt === generation.current && allowed.current) finish(captureRefusal(error));
			};
			try {
				void upload(current.pcm!.stop(), "audio/wav").catch(failed);
			} catch (error) {
				failed(error);
			}
			return;
		}
		if (current.kind === "daemon") {
			current.recorder?.stop();
			return;
		}
		setPhase("transcribing");
		const attempt = generation.current;
		stopNativeVoice().then(
			(text) => {
				if (attempt === generation.current && allowed.current) sendTranscript(text);
			},
			(error: unknown) => {
				if (attempt === generation.current) finish(startRefusal(error));
			},
		);
	}, [finish, sendTranscript, setPhase, upload]);

	const startDaemon = useCallback(async () => {
		const attempt = generation.current;
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			if (attempt === generation.current) finish(REASONS.denied);
			return;
		}
		if (attempt !== generation.current || !allowed.current) {
			for (const track of stream.getTracks()) track.stop();
			return;
		}
		const type = RECORDING_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
		const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
		const entry: Recording = { kind: "daemon", cancelled: false, recorder };
		const chunks: Blob[] = [];
		recorder.ondataavailable = (event) => {
			if (event.data.size > 0) chunks.push(event.data);
		};
		recorder.onstop = () => {
			for (const track of stream.getTracks()) track.stop();
			if (entry.cancelled) return;
			const mime = recorder.mimeType || type || "audio/webm";
			void upload(new Blob(chunks, { type: mime }), mime);
		};
		recorder.start();
		entry.stopMeter = startMeter(stream, setLevel);
		begin(entry);
		entry.limit = setTimeout(stop, MAX_RECORDING_MS);
	}, [begin, finish, stop, upload]);

	const startNative = useCallback(async () => {
		const attempt = generation.current;
		try {
			// Apple's recognizer listens in one language: the one chosen in Settings, else the system's.
			await startNativeVoice(voiceLanguage() ?? navigator.language);
		} catch (error) {
			if (attempt === generation.current) finish(startRefusal(error));
			return;
		}
		if (attempt !== generation.current || !allowed.current) {
			void cancelNativeVoice().catch(() => {});
			return;
		}
		begin({ kind: "native", cancelled: false });
	}, [begin, finish]);

	const mobileAttempt = useRef(0);
	const startMobile = useCallback(async () => {
		const bridge = mobileBridge();
		if (!bridge) return;
		const attempt = ++mobileAttempt.current;
		setNote(undefined);
		setPhase("transcribing");
		try {
			const result = await bridge.transcribe({ language: voiceLanguage() ?? navigator.language });
			if (attempt === mobileAttempt.current && allowed.current) sendTranscript(result.text);
		} catch (error) {
			// Android already explains why dictation could not start, in Spanish.
			if (attempt === mobileAttempt.current) finish(startRefusal(error));
		}
	}, [finish, sendTranscript, setPhase]);

	mobileFallback.current = startMobile;

	const startPc = useCallback(async () => {
		const attempt = generation.current;
		try {
			const pcm = await capturePcm(setLevel);
			if (attempt !== generation.current || !allowed.current) {
				pcm.cancel();
				return;
			}
			const entry: Recording = { kind: "pc", cancelled: false, pcm };
			begin(entry);
			setPartial("PC");
			entry.limit = setTimeout(stop, MAX_RECORDING_MS);
		} catch (error) {
			// A rejected microphone permission is not a PC outage. Opening Google's
			// dialog here hides the capture failure and sends the user down another path.
			if (attempt === generation.current && allowed.current) finish(captureRefusal(error));
		}
	}, [begin, stop, finish]);

	const start = useCallback(() => {
		if (!allowed.current || phaseNow.current !== "idle" || starting.current) return;
		if (!inputOnly) stopSpeaking();
		if (source.kind === "none") return;
		starting.current = true;
		const run =
			source.kind === "pc" ? startPc() : source.kind === "mobile" ? startMobile() : source.kind === "daemon" ? startDaemon() : startNative();
		void run.finally(() => {
			starting.current = false;
		});
	}, [source.kind, startPc, startDaemon, startNative, startMobile, stopSpeaking, inputOnly]);

	const cancel = useCallback(() => {
		mobileAttempt.current += 1;
		generation.current += 1;
		setDraft(undefined);
		const current = recording.current;
		if (!current) {
			finish();
			return;
		}
		current.cancelled = true;
		if (current.kind === "pc") current.pcm?.cancel();
		else if (current.kind === "daemon") current.recorder?.stop();
		else void cancelNativeVoice().catch(() => {});
		finish();
	}, [finish]);

	const setMuted = useCallback(
		(next: boolean) => {
			setMutedState(next);
			try {
				if (next) localStorage.setItem(MUTED_KEY, "1");
				else localStorage.removeItem(MUTED_KEY);
			} catch {
				// Private browsing: the choice lasts for this window only.
			}
			if (next) stopSpeaking();
		},
		[stopSpeaking],
	);

	const typed = useCallback(() => {
		voiceTurn.current = undefined;
	}, []);

	// The desktop recognizer's status and live events.
	useEffect(() => {
		if (!desktop) return;
		let live = true;
		void nativeVoiceStatus().then((status) => {
			if (live) setNative(status);
		});
		const off = onNativeVoice({
			partial: (text) => {
				if (phaseNow.current === "recording") setPartial(text);
			},
			level: (value) => {
				if (phaseNow.current === "recording") setLevel(value);
			},
			error: (message) => {
				if (recording.current?.kind === "native") finish(message);
			},
		}).catch(() => () => {});
		return () => {
			live = false;
			void off.then((stopListening) => stopListening());
		};
	}, [desktop, finish]);

	// Installing or removing the local model changes what the recognizer can do (#25).
	useEffect(() => {
		if (!desktop) return;
		let live = true;
		const off = onVoiceModel((event) => {
			if (event.state !== "installed" && event.state !== "removed") return;
			void nativeVoiceStatus().then((status) => {
				if (live) setNative(status);
			});
		}).catch(() => () => {});
		return () => {
			live = false;
			void off.then((stopListening) => stopListening());
		};
	}, [desktop]);

	// Answers to voice requests.
	useEffect(() => {
		for (const reply of state.voiceReplies) {
			if (reply.requestId === pendingTranscript.current) {
				pendingTranscript.current = undefined;
				clearTimeout(transcriptTimer.current);
				if (reply.type === "voice_transcript") sendTranscript(reply.text);
				else if (reply.type === "voice_unavailable") {
					if (mobileBridge()) void mobileFallback.current();
					else finish(reply.reason);
				}
			}
			const speech = pendingSpeech.current;
			if (speech && reply.requestId === speech.requestId) {
				pendingSpeech.current = undefined;
				if (reply.type === "voice_speech") {
					const player = new Audio(`data:${reply.mime};base64,${reply.data}`);
					audio.current = player;
					player.onended = () => setSpeaking(false);
					setSpeaking(true);
					void player.play().catch(() => setSpeaking(false));
				} else if (reply.type === "voice_unavailable") {
					speakWithSystem(speech.text);
				}
			}
		}
	}, [state.voiceReplies, sendTranscript, finish, speakWithSystem]);

	// Read the reply to a spoken message aloud once the assistant finished it.
	useEffect(() => {
		const before = voiceTurn.current;
		if (!before || isBusy(state.agentState)) return;
		const reply = state.messages.findLast((m) => m.role === "assistant" && !before.has(m.id));
		if (!reply || reply.streaming) return;
		voiceTurn.current = undefined;
		if (!reply.note) speak(reply.text);
	}, [state.messages, state.agentState, speak]);

	// Esc cancels a recording before the panel sees it (it would hide the panel).
	useEffect(() => {
		if (phase !== "recording") return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			cancel();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [phase, cancel]);

	useEffect(() => {
		if (!enabled) cancel();
	}, [enabled, cancel]);

	// Leaving the chat drops a recording and silences the voice.
	const cancelNow = useRef(cancel);
	cancelNow.current = cancel;
	const stopSpeakingNow = useRef(stopSpeaking);
	stopSpeakingNow.current = stopSpeaking;
	useEffect(
		() => () => {
			cancelNow.current();
			if (!inputOnly) stopSpeakingNow.current();
		},
		[inputOnly],
	);

	const mic: MicState | undefined =
		source.kind === "none"
			? source.reason
				? { available: false, reason: source.reason }
				: undefined
			: { available: true };

	return {
		...(mic ? { mic } : {}),
		phase,
		elapsed,
		level,
		partial,
		...(note ? { note } : {}),
		speaking,
		muted,
		start,
		stop,
		cancel,
		stopSpeaking,
		setMuted,
		typed,
		sendOnStop: inputOnly || mobileBridge() ? false : sendOnStop,
		setSendOnStop: inputOnly ? () => {} : setSendOnStop,
		...(draft ? { draft } : {}),
		draftTaken,
		sent,
	};
}

function readFlag(key: string): boolean {
	try {
		return localStorage.getItem(key) === "1";
	} catch {
		return false;
	}
}

async function toBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** The microphone level from the recording's stream, where the browser can measure it. */
function startMeter(stream: MediaStream, onLevel: (level: number) => void): () => void {
	const Context = globalThis.AudioContext;
	if (!Context) return () => {};
	try {
		const context = new Context();
		const analyser = context.createAnalyser();
		analyser.fftSize = 512;
		context.createMediaStreamSource(stream).connect(analyser);
		const samples = new Uint8Array(analyser.fftSize);
		const timer = setInterval(() => {
			analyser.getByteTimeDomainData(samples);
			let sum = 0;
			for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
			onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 3));
		}, 100);
		return () => {
			clearInterval(timer);
			void context.close();
		};
	} catch {
		return () => {};
	}
}
