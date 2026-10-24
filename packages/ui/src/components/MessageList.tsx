import { Fragment, memo } from "react";
import type { ChatMessage } from "../store.ts";
import { formatSize } from "../uploads.ts";
import { SharedMarkdown } from "./SharedMarkdown.tsx";
import "../chat-progress.css";

interface MessageListProps {
	messages: ChatMessage[];
	/** Messages already received by the engine, to apply at its next safe checkpoint. */
	queued?: string[];
	/** Offers "Show earlier" at the top, which calls `onShowEarlier`. */
	hasEarlier?: boolean;
	onShowEarlier?: () => void;
	loadingEarlier?: boolean;
	hasNewer?: boolean;
	onShowNewer?: () => void;
	mobile?: boolean;
	/** One transient status for the whole turn; tool-only records never become chat bubbles. */
	working?: boolean;
}

export function MessageList({
	messages,
	queued = [],
	hasEarlier = false,
	onShowEarlier,
	loadingEarlier = false,
	hasNewer = false,
	onShowNewer,
	mobile = false,
	working = messages.at(-1)?.streaming ?? false,
}: MessageListProps) {
	const visibleMessages = messages.filter(
		(message) => message.text.trim() || message.attachments?.length || message.note,
	);
	const lastEarlier = visibleMessages.findLastIndex((m) => m.earlier);

	if (messages.length === 0 && queued.length === 0 && !working) {
		return (
			<div className="empty">
				<p>{mobile ? "¿En qué te ayudo?" : "Hi! What can I do for you?"}</p>
			</div>
		);
	}
	return (
		<div className="messages" aria-live="polite">
			{hasEarlier ? (
				<button type="button" className="show-earlier" onClick={onShowEarlier} disabled={loadingEarlier}>
					{loadingEarlier
						? mobile
							? "Cargando…"
							: "Loading…"
						: mobile
							? "Ver mensajes anteriores"
							: "Show earlier"}
				</button>
			) : null}
			{visibleMessages.map((message, index) => (
				<Fragment key={message.id}>
					<Message message={message} />
					{index === lastEarlier ? (
						<div className="earlier-divider">
							<hr aria-label={mobile ? "Mensajes anteriores" : "Earlier messages"} />
							<span aria-hidden="true">{mobile ? "Mensajes anteriores" : "Earlier messages"}</span>
							<span className="earlier-line" />
						</div>
					) : null}
				</Fragment>
			))}
			{hasNewer ? (
				<button type="button" className="show-earlier show-newer" onClick={onShowNewer}>
					{mobile ? "Ver mensajes siguientes" : "Show newer"}
				</button>
			) : null}
			{queued.map((text, i) => (
				<article
					// biome-ignore lint/suspicious/noArrayIndexKey: the same text can be queued twice
					key={`${i}-${text}`}
					className="message message-user message-received"
					aria-label={mobile ? "Mensaje recibido" : "Received message"}
				>
					<div className="message-body message-plain">{text}</div>
					<span
						className="received-label"
						title={mobile ? "Se incorpora al próximo paso seguro." : "Applied at the next safe checkpoint."}
					>
						{mobile ? "Recibido" : "Received"}
					</span>
				</article>
			))}
			{working ? (
				<div className="chat-working" role="status" aria-atomic="true">
					<span className="chat-working-dot" aria-hidden="true" />
					{mobile ? "Trabajando…" : "Working…"}
				</div>
			) : null}
		</div>
	);
}

/** Completed Markdown/images keep their DOM when only another message streams. */
const Message = memo(
	function Message({ message }: { message: ChatMessage }) {
		return (
			<article className={`message message-${message.role}`} data-message-id={message.id}>
				{message.text && message.role === "user" ? (
					<div className="message-body message-plain">{message.text}</div>
				) : null}
				{message.attachments && message.attachments.length > 0 ? (
					<ul className="message-attachments" aria-label="Attached files">
						{message.attachments.map((file, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: two files may share a name across folders
							<li key={i} className="attachment-chip">
								<span className="chip-name" title={file.name}>
									{file.name}
								</span>
								<span className="chip-size">{formatSize(file.size)}</span>
							</li>
						))}
					</ul>
				) : null}
				{message.text && message.role === "assistant" ? (
					<div className="message-body">
						<SharedMarkdown>{message.text}</SharedMarkdown>
					</div>
				) : null}
				{message.note ? (
					<p
						className={`message-note message-note-${message.note.kind}`}
						role={message.note.kind === "error" ? "alert" : undefined}
					>
						{message.note.text}
					</p>
				) : null}
			</article>
		);
	},
	(previous, next) =>
		previous.message.text === next.message.text &&
		previous.message.id === next.message.id &&
		previous.message.role === next.message.role &&
		previous.message.attachments === next.message.attachments &&
		previous.message.note === next.message.note,
);
