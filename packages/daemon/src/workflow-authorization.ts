import { createHash } from "node:crypto";

/** Hash exactly what the daemon sent as the user's text; never normalize or rewrite it. */
export function workflowSourceHash(engineText: string): string {
	return createHash("sha256").update(engineText, "utf8").digest("hex");
}

export interface SessionApprovalPolicy {
	version: 1;
	kind: "session-confirmations";
	/** Binds the rule to the entire authenticated instruction, never a model summary. */
	sourceHash: string;
}

/**
 * A deliberately closed command grammar, not an intent classifier. Unrecognized prose,
 * conditions, quoted examples and restrictions require ordinary scoped review. In
 * particular, an instruction containing "approve all" is not itself a blanket grant.
 */
export function sessionApprovalPolicy(instruction: string | undefined): SessionApprovalPolicy | undefined {
	if (!instruction || instruction.length > 512) return;
	const command = instruction
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/\s*([,.])\s*/g, "$1 ")
		.trim()
		.replace(/[.!]$/, "")
		.trim();
	const suffix = "(?: (?:directamente|automaticamente|sin esperarme|en segundo plano))?";
	const patterns = [
		new RegExp(
			`^(?:aprueba|autoriza) (?:todos los permisos|todas las solicitudes|todas las aprobaciones) de (?:esta|esa) sesion${suffix}$`,
		),
		new RegExp(
			`^(?:aprueba|autoriza) (?:cualquier|cada) (?:permiso|solicitud) que pida (?:esta|esa) sesion${suffix}$`,
		),
		new RegExp(
			`^si (?:esta|esa) sesion pide (?:mas permisos|cualquier permiso|una aprobacion),? (?:apruebalo|apruebalos|autorizalo|autorizalos)${suffix}$`,
		),
		new RegExp(`^salio un permiso de una sesion\\. apruevalo y si esa sesion pide mas,? apruevalo${suffix}$`),
		/^(?:approve|allow) (?:all|every) (?:permissions?|approval requests?) (?:for|from) this session(?: automatically| in the background| without waiting for me)?$/,
	];
	if (!patterns.some((pattern) => pattern.test(command))) return;
	return { version: 1, kind: "session-confirmations", sourceHash: workflowSourceHash(instruction) };
}

interface AuthorizationOptions {
	maxEntries?: number;
	maxBytes?: number;
}

/**
 * Evidence captured only from authenticated client input, not from engine messages or files.
 * A matching hash recovers the words the person typed, excluding attachment metadata/content.
 * Missing/evicted evidence conveys no authority. Active workflows persist their own resolved scope.
 */
export class WorkflowAuthorization {
	private readonly entries = new Map<string, { text: string; bytes: number }>();
	private readonly maxEntries: number;
	private readonly maxBytes: number;
	private bytes = 0;

	constructor(options: AuthorizationOptions = {}) {
		this.maxEntries = options.maxEntries ?? 128;
		this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
		if (
			!Number.isSafeInteger(this.maxEntries) ||
			this.maxEntries < 1 ||
			this.maxEntries > 1024 ||
			!Number.isSafeInteger(this.maxBytes) ||
			this.maxBytes < 1 ||
			this.maxBytes > 16 * 1024 * 1024
		)
			throw new Error("Invalid human authorization ledger bounds");
	}

	record(originalText: string, engineText: string): void {
		if (typeof originalText !== "string" || typeof engineText !== "string" || !engineText) return;
		if (Buffer.byteLength(engineText, "utf8") > 1024 * 1024) return;
		const hash = workflowSourceHash(engineText);
		const previous = this.entries.get(hash);
		if (previous) {
			this.entries.delete(hash);
			this.bytes -= previous.bytes;
		}
		const bytes = Buffer.byteLength(originalText, "utf8") + hash.length;
		// An attachment-only send carries no human instruction, even if its contents ask for authority.
		if (!originalText.trim() || bytes > Math.min(this.maxBytes, 512 * 1024)) return;
		this.entries.set(hash, { text: originalText, bytes });
		this.bytes += bytes;
		while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			const entry = this.entries.get(oldest);
			this.entries.delete(oldest);
			this.bytes -= entry?.bytes ?? 0;
		}
	}

	resolve(sourceHash: unknown): string | undefined {
		if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceHash)) return;
		return this.entries.get(sourceHash)?.text;
	}
}
