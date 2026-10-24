import type { ClientMessage } from "@gentle-dot/protocol";

/** Sends to the daemon; `false` when the message could not be handed to an open connection. */
// biome-ignore lint/suspicious/noConfusingVoidType: a sender that reports nothing (tests, wrappers) counts as sent.
export type Send = (message: ClientMessage) => boolean | void;

/** Human approval through the desktop's private channel; never the chat WebSocket. */
export type AnswerAppApproval = (requestId: string, approved: boolean) => Promise<void>;

export function newRequestId(): string {
	return crypto.randomUUID();
}
