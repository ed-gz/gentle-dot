import { createHash } from "node:crypto";
import { OrchestrationError, record } from "./herdr.ts";

export interface SessionDelivery {
	id: string;
	status: "accepted" | "queued" | "delivered" | "unconfirmed";
	preview: string;
	deliverAs: "steer" | "followUp";
	acceptedAt: string;
	deliveredAt?: string;
	/** The originating user message carried this exact clientMessageId. Older
	 * receipts without this marker cannot prove who submitted matching text. */
	evidence?: "correlated-v1";
}

/**
 * A socket acknowledgement means accepted, not consumed or durably saved.
 * correlated-v1 means a user message emitted by the session carried the exact
 * clientMessageId supplied with this prompt. Older delivered receipts have no
 * such guarantee. Pi 1.0.4 does not propagate that ID through sendUserMessage,
 * so its sends remain unconfirmed even if their text appears in the transcript.
 * This in-memory ledger does not provide durable acknowledgement across restarts.
 */
export class SessionDeliveries {
	private readonly entries = new Map<string, { receipt: SessionDelivery; digest: string }>();
	clear() {
		this.entries.clear();
	}
	prepare(
		id: string,
		payload: unknown,
		text: string,
		deliverAs: "steer" | "followUp",
		idle: boolean,
		preview = text,
	) {
		if (!/^[A-Za-z0-9_-]{8,96}$/.test(id))
			throw new OrchestrationError("INVALID_DELIVERY", "El mensaje no contiene una identidad válida.");
		const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
		const prior = this.entries.get(id);
		if (prior) {
			if (prior.digest !== digest)
				throw new OrchestrationError(
					"DELIVERY_CHANGED",
					"El contenido de este envío cambió. Crea un mensaje nuevo.",
				);
			return { receipt: { ...prior.receipt }, duplicate: true };
		}
		// Never discard an unconfirmed delivery merely to make room for another one.
		if (this.entries.size >= 500)
			throw new OrchestrationError(
				"DELIVERY_LIMIT",
				"Esta sesión alcanzó el límite de envíos remotos. Continúa en una sesión nueva.",
			);
		const receipt: SessionDelivery = {
			id,
			preview: preview.slice(0, 2000),
			status: idle ? "accepted" : "queued",
			deliverAs,
			acceptedAt: new Date().toISOString(),
		};
		this.entries.set(id, { receipt, digest });
		return { receipt: { ...receipt }, duplicate: false };
	}
	remove(id: string) {
		this.entries.delete(id);
	}
	consume(message: unknown) {
		if (!record(message) || message.role !== "user") return;
		const client = typeof message.clientMessageId === "string" ? message.clientMessageId : undefined;
		// Text, timestamps and queue order do not identify the sender: another
		// window can submit the same instruction while this delivery is pending.
		// deliveryId is also used for attachment identity, not message identity.
		const entry = client ? this.entries.get(client) : undefined;
		if (entry) {
			entry.receipt.status = "delivered";
			entry.receipt.deliveredAt = new Date().toISOString();
			entry.receipt.evidence = "correlated-v1";
		}
	}
	snapshot(idle = false, hasPending = true, now = Date.now()): SessionDelivery[] {
		const entries = [...this.entries.values()];
		for (const { receipt } of entries) {
			// The extension API returns void, including when another input handler rejects a turn.
			// An idle runtime with no queue is not evidence that an instruction was delivered.
			if (
				idle &&
				!hasPending &&
				receipt.status !== "delivered" &&
				now - Date.parse(receipt.acceptedAt) > 30_000
			)
				receipt.status = "unconfirmed";
		}
		// Retain small completed identities so a phone returning later can reconcile its outbox.
		return entries.map(({ receipt }) => ({ ...receipt, ...(receipt.status === "delivered" ? { preview: "" } : {}) }));
	}
}
