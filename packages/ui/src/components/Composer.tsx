import type { AttachmentRef } from "@gentle-dot/protocol";
import { publishCompanionActivity } from "../companion-activity.ts";
import { type ClipboardEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { AttachmentControls } from "../useAttachments.ts";
import type { VoiceControls } from "../useVoice.ts";
import { CameraIcon, MicIcon, PaperclipIcon, SendIcon, StopIcon } from "./icons.tsx";
import { newRequestId, type Send } from "./types.ts";
import { AttachmentChip } from "./AttachmentChip.tsx";

interface ComposerProps {
	busy: boolean;
	disabled: boolean;
	send: Send;
	/** Changes to this value move focus to the text box. */
	focusKey?: number;
	/** Called when the text box goes from empty to having text. */
	onStartTyping?: () => void;
	/** Talking to the assistant (S30.4); without it there is no mic. */
	voice?: VoiceControls;
	/** Files for the message (S31.1); without it there is no attach button. */
	attachments?: AttachmentControls;
	/** Compact phone copy; desktop keeps its existing labels and behavior. */
	mobile?: boolean;
	/** Presentation only; never changes delivery or keyboard policy. */
	capriMobile?: boolean;
	temporaryAttachmentsNote?: string;
	/** Optional acknowledged, controlled input; the default Dot transport is unchanged. */
	text?: string;
	onText?(text: string): void;
	onSubmitText?(text: string, refs?: AttachmentRef[]): Promise<boolean>;
	/** Optional durable platform commit before a voice result enters the draft. */
	onVoiceDraft?(draft: NonNullable<VoiceControls['draft']>, current: string): Promise<string>;
	/** A platform can keep a failed local draft editable while Send is blocked. */
	editableWhenDisabled?: boolean;
	inputOnly?: boolean;
	labels?: { text: string; send: string; files: string; remove: string };
}

export function Composer({
	busy,
	disabled,
	send,
	focusKey,
	onStartTyping,
	voice,
	attachments,
	mobile = false,
	capriMobile = false,
	temporaryAttachmentsNote,
	text: controlledText,
	onText,
	onSubmitText,
	onVoiceDraft,
	editableWhenDisabled = false,
	inputOnly = false,
	labels,
}: ComposerProps) {
	const copy = (english: string, spanish: string) => (mobile ? spanish : english);
	// Agent input-only composers also use `mobile` for Spanish copy on desktop.
	// The shell/pointer, not that copy preference, determines their keyboard policy.
	const newlineOnEnter = (mobile && !inputOnly) || Boolean(window.__GENTLE_MOBILE__)
		|| window.matchMedia?.("(pointer: coarse)").matches === true;
	const [localText, setLocalText] = useState("");
	const text = controlledText ?? localText;
	const textNow = useRef(text);
	textNow.current = text;
	const setText = (value: string) => { setLocalText(value); onText?.(value); };
	const onTextNow = useRef(onText);
	onTextNow.current = onText;
	const submitting = useRef(false);
	const [pending, setPending] = useState(false);
	const [voiceCommitError, setVoiceCommitError] = useState(false);
	const [voiceCommitAttempt, setVoiceCommitAttempt] = useState(0);
	const mounted = useRef(true);
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	/** The last message could not go out; its text and files stay for another try (#21). */
	const [refused, setRefused] = useState(false);
	const box = useRef<HTMLTextAreaElement>(null);
	const recording = voice?.phase === "recording";
	// A dictation for this iOS session is still being prepared, transcribed or
	// joined to its draft. Don't dispatch the earlier partial instruction.
	const voiceInputPending = capriMobile && inputOnly && Boolean(voice?.inputBusy || recording || voice?.phase === "transcribing" || voice?.draft);
	const cancelPendingVoice = Boolean(capriMobile && inputOnly && voice?.cancelPending && (voice.inputBusy || voice.phase === "transcribing"));
	const voiceStatus =
		voice?.phase === "transcribing" ? copy("Transcribing…", "Transcribiendo…") : voice?.note;

	// A dictation to review joins what was already typed, and the cursor waits at its end.
	const draft = voice?.draft;
	const draftTaken = voice?.draftTaken;
	const commitVoiceNow = useRef(onVoiceDraft); commitVoiceNow.current = onVoiceDraft;
	const draftTakenNow = useRef(draftTaken); draftTakenNow.current = draftTaken;
	useEffect(() => {
		if (!draft || !draftTaken) return;
		const current = textNow.current;
		let cancelled = false;
		void (async () => {
			try {
				const commit = commitVoiceNow.current;
				const next = commit ? await commit(draft, current) : current.trim() ? `${current.trimEnd()} ${draft.text}` : draft.text;
				if (cancelled || !mounted.current) return;
				if (textNow.current !== current) { setVoiceCommitError(true); return; }
				setVoiceCommitError(false); setLocalText(next); onTextNow.current?.(next); draftTakenNow.current?.(draft.id);
				requestAnimationFrame(() => { const input = box.current; if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } });
			} catch { if (!cancelled && mounted.current) setVoiceCommitError(true); }
		})();
		return () => { cancelled = true; };
	}, [draft?.id, voiceCommitAttempt]);

	useEffect(() => {
		if (focusKey !== undefined) box.current?.focus();
	}, [focusKey]);

	const files = attachments?.files ?? [];
	const uploading = attachments?.uploading === true || attachments?.saving === true;
	const blocked = files.some((f) => f.refused);
	// One stable action slot: Stop while working, Send when there is a follow-up draft.
	const showStop = !recording && (busy || voice?.speaking) && !text.trim() && files.length === 0;
	const stopLabel = busy ? copy("Stop", "Detener respuesta") : copy("Stop", "Detener lectura");

	async function submit() {
		const value = text.trim();
		if ((!value && files.length === 0) || disabled || uploading || blocked || submitting.current || voiceInputPending) return;
		if (onSubmitText) {
			submitting.current = true;
			setPending(true);
			publishCompanionActivity("sending", box.current);
			try {
				const refs = files.length ? await attachments?.upload() : undefined;
				if (!mounted.current) return;
				if (files.length && !refs) { publishCompanionActivity("failed", box.current); return; }
				const accepted = await onSubmitText(value, refs);
				if (!mounted.current) return;
				setRefused(!accepted);
				publishCompanionActivity(accepted ? "submitted" : "failed", box.current);
				if (accepted) { attachments?.clear(); voice?.sent(); setText(""); }
			} catch { if (mounted.current) { setRefused(true); publishCompanionActivity("failed", box.current); } }
			finally { submitting.current = false; if (mounted.current) setPending(false); }
			return;
		}
		// Files upload on send; a failed one keeps the message so sending again retries it.
		const refs = files.length > 0 ? await attachments?.upload() : undefined;
		if (files.length > 0 && !refs) { publishCompanionActivity("failed", box.current); return; }
		const message = { type: "send", text: value, requestId: newRequestId() } as const;
		if (send(refs ? { ...message, attachments: refs } : message) === false) {
			setRefused(true);
			publishCompanionActivity("failed", box.current);
			return;
		}
		setRefused(false);
		publishCompanionActivity("submitted", box.current);
		attachments?.clear();
		voice?.sent();
		setText("");
	}

	/** A pasted image becomes an attachment; pasted text stays text. */
	function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
		if (!attachments) return;
		const images = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
		if (images.length === 0) return;
		event.preventDefault();
		attachments.add(images);
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === "Enter" && !newlineOnEnter && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			void submit();
		}
	}

	return (
		<>
			{voiceCommitError && draft ? <div className="voice-status" role="alert"><p>No se confirmó el dictado. Revisa el texto antes de continuar.</p><details><summary>Ver dictado</summary><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{draft.text}</p></details><button type="button" onClick={() => { setVoiceCommitError(false); setVoiceCommitAttempt(value => value + 1); }}>Reintentar</button>{voice?.deferDraft ? <button type="button" onClick={() => { voice.deferDraft?.(draft.id); setVoiceCommitError(false); }}>Revisar después</button> : null}</div> : null}
			{refused ? (
				<p className="voice-status" role="alert" aria-label={copy("Not sent", "No enviado")}>
					{inputOnly ? "No se confirmó el envío." : copy(
						"Not connected, so the message was not sent. It is kept here to send again.",
						"No hay conexión. Tu mensaje sigue aquí para enviarlo cuando vuelvas a conectar.",
					)}
				</p>
			) : null}
			{voiceStatus ? (
				<p className="voice-status" role="status" aria-label={copy("Voice", "Voz")}>
					{voiceStatus}
				</p>
			) : null}
			{attachments && files.length > 0 ? (
				<ul className="attachment-chips" aria-label="Files to send">
					{files.map((file) => (
						<AttachmentChip
							key={file.id}
							file={file}
							removeLabel={labels?.remove ?? copy("Remove", "Quitar")}
							locked={uploading}
							remove={() => attachments.remove(file.id)}
						/>
					))}
				</ul>
			) : null}
			{files.length > 0 && temporaryAttachmentsNote ? <p className="voice-status">{temporaryAttachmentsNote}</p> : null}
			<form
				className="composer"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				{attachments && !recording ? (
					<label className="composer-attach" title={capriMobile && inputOnly ? "Tomar foto" : copy("Attach files", "Adjuntar archivos")}>
						{capriMobile && inputOnly ? <CameraIcon /> : <PaperclipIcon />}
						<input
							type="file"
							multiple={!(capriMobile && inputOnly)}
							accept={capriMobile && inputOnly ? "image/*" : undefined}
							capture={capriMobile && inputOnly ? "environment" : undefined}
							aria-label={capriMobile && inputOnly ? "Tomar foto para esta sesión" : labels?.files ?? copy("Attach files", "Adjuntar archivos")}
							className="visually-hidden"
							disabled={disabled || uploading || pending}
							onChange={(event) => {
								attachments.add(Array.from(event.target.files ?? []));
								// The same file can be picked again after removing it.
								event.target.value = "";
							}}
						/>
					</label>
				) : null}
				{recording ? (
					<div className="voice-recording">
						<span
							className="voice-time"
							role="timer"
							aria-label={copy("Recording time", "Tiempo de grabación")}
						>
							{formatElapsed(voice.elapsed)}
						</span>
						<meter
							className="voice-meter"
							aria-label={copy("Microphone level", "Nivel del micrófono")}
							min={0}
							max={1}
							value={voice.level}
						/>
						<span className="voice-partial">{voice.partial || copy("Listening…", "Escuchando…")}</span>
						{!inputOnly ? <button
							type="button"
							role="switch"
							aria-checked={voice.sendOnStop}
							className={`voice-send-option${voice.sendOnStop ? " on" : ""}`}
							onClick={() => voice.setSendOnStop(!voice.sendOnStop)}
						>
							{copy("Send when I stop", "Enviar al terminar")}
						</button> : null}
						<button
							type="button"
							className="voice-cancel"
							aria-label={copy("Cancel recording", "Cancelar grabación")}
							title={copy("Cancel (Esc)", "Cancelar (Esc)")}
							onClick={voice.cancel}
						>
							✕
						</button>
					</div>
				) : (
					<textarea
						ref={box}
						readOnly={Boolean(onVoiceDraft && voice?.draft)}
						aria-label={labels?.text ?? copy("Message", "Mensaje")}
						placeholder={
							busy
								? copy("Add to what I'm doing…", "Añade una indicación…")
								: capriMobile ? "Escribe a Capri…" : copy("Ask me anything…", "Escribe un mensaje…")
						}
						enterKeyHint={newlineOnEnter ? "enter" : "send"}
						rows={1}
						value={text}
						disabled={(disabled && !editableWhenDisabled) || pending}
						onChange={(event) => {
							if (text === "" && event.target.value !== "") onStartTyping?.();
							setText(event.target.value);
						}}
						onKeyDown={onKeyDown}
						onPaste={onPaste}
					/>
				)}
				{voice?.mic ? (
					<button
						type="button"
						className={`composer-mic${recording ? " composer-mic-on" : ""}`}
						aria-label={
							cancelPendingVoice ? "Cancelar dictado" : recording
								? voice.sendOnStop
									? copy("Stop and send", "Terminar y enviar")
									: copy("Stop and review", "Terminar y revisar")
								: copy("Talk", "Dictar mensaje")
						}
						title={
							cancelPendingVoice ? "Cancelar dictado" : voice.mic.available
								? voice.sendOnStop
									? copy("Tap to talk, tap again to send", "Toca para hablar y otra vez para enviar")
									: copy(
											"Tap to talk, tap again to review before sending",
											"Toca para dictar y revisar antes de enviar",
										)
								: voice.mic.reason
						}
						disabled={disabled || pending || (!cancelPendingVoice && (!voice.mic.available || voice.phase === "transcribing" || (capriMobile && inputOnly && voice.inputBusy === true)))}
						onClick={cancelPendingVoice ? voice.cancelPending : recording ? voice.stop : voice.start}
					>
						{cancelPendingVoice ? <StopIcon /> : <MicIcon />}
					</button>
				) : null}
				{showStop ? (
					<button
						type="button"
						className="composer-send composer-stop"
						aria-label={stopLabel}
						title={stopLabel}
						onClick={() => {
							if (busy) send({ type: "abort" });
							voice?.stopSpeaking();
						}}
					>
						<StopIcon />
					</button>
				) : recording ? null : (
					<button
						type="submit"
						className={`composer-send${capriMobile ? " composer-send-capri" : ""}`}
						disabled={disabled || pending || uploading || blocked || voiceInputPending || (text.trim() === "" && files.length === 0)}
						aria-label={labels?.send ?? copy("Send", "Enviar mensaje")}
						title={copy("Send", "Enviar mensaje")}
					>
						<SendIcon />
					</button>
				)}
			</form>
		</>
	);
}

function formatElapsed(seconds: number): string {
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
