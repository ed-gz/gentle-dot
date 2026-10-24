import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

export interface MobileDevice {
	id: string;
	name: string;
	createdAt: string;
	hash: string;
	/** Granted only after the computer's native pairing confirmation. Legacy keys cannot approve. */
	approvalAccess?: boolean;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export class MobileAccessError extends Error {
	readonly code: "PAIRING_CODE_INVALID" | "DEVICE_LIMIT" | "DEVICE_STORE_UNAVAILABLE" | "PAIRING_LIMIT";
	readonly status: number;
	constructor(code: MobileAccessError["code"], message: string, status: number) {
		super(message);
		this.name = "MobileAccessError";
		this.code = code;
		this.status = status;
	}
}

/** Device keys are independent from the desktop key; only hashes are stored. */
export class MobileAccess {
	private devices: MobileDevice[];
	private codes = new Map<string, number>();
	private file: string;
	private readonly now: () => number;
	constructor(dataDir: string, now: () => number = Date.now) {
		this.now = now;
		this.file = join(dataDir, "mobile-devices.json");
		this.devices = [];
		if (existsSync(this.file)) {
			const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			if (
				!Array.isArray(value) ||
				value.some(
					(d) =>
						!d ||
						typeof d.id !== "string" ||
						typeof d.name !== "string" ||
						typeof d.createdAt !== "string" ||
						(d.approvalAccess !== undefined && typeof d.approvalAccess !== "boolean") ||
						!/^[a-f0-9]{64}$/.test(d.hash),
				)
			)
				throw new Error("Invalid mobile device store");
			this.devices = value;
			chmodSync(this.file, 0o600);
		}
	}
	accepts(token: string): boolean {
		const digest = hash(token);
		return this.devices.some((d) => d.hash === digest);
	}
	canApprove(token: string): boolean {
		const digest = hash(token);
		return this.devices.some((d) => d.hash === digest && d.approvalAccess === true);
	}
	list(): Omit<MobileDevice, "hash">[] {
		return this.devices.map(({ hash: _, ...device }) => device);
	}
	issue(): { code: string; expiresAt: string } {
		for (const [key, expires] of this.codes) if (expires <= this.now()) this.codes.delete(key);
		if (this.codes.size >= 10)
			throw new MobileAccessError("PAIRING_LIMIT", "Too many pending pairing codes", 429);
		const code = randomBytes(24).toString("base64url");
		const expires = this.now() + 5 * 60_000;
		this.codes.set(hash(code), expires);
		return { code, expiresAt: new Date(expires).toISOString() };
	}
	assertCanRedeem(code: string): void {
		const key = hash(code);
		const expires = this.codes.get(key);
		if (!expires || expires <= this.now()) {
			this.codes.delete(key);
			throw new MobileAccessError("PAIRING_CODE_INVALID", "Pairing code expired or invalid", 410);
		}
		if (this.devices.length >= 20)
			throw new MobileAccessError("DEVICE_LIMIT", "Remove an old device before pairing another", 409);
	}
	redeem(
		code: string,
		name: string,
		approvalAccess = false,
	): { token: string; deviceId: string; deviceName: string } {
		this.assertCanRedeem(code);
		const token = randomBytes(32).toString("base64url");
		const device = {
			id: randomUUID(),
			name: name.trim().slice(0, 80) || "Android",
			createdAt: new Date(this.now()).toISOString(),
			hash: hash(token),
			approvalAccess: approvalAccess === true,
		};
		this.devices.push(device);
		try {
			this.save();
		} catch (error) {
			this.devices.pop();
			throw error;
		}
		this.codes.delete(hash(code));
		return { token, deviceId: device.id, deviceName: device.name };
	}
	revoke(id: string): void {
		const previous = this.devices;
		this.devices = this.devices.filter((d) => d.id !== id);
		try {
			this.save();
		} catch (error) {
			this.devices = previous;
			throw error;
		}
	}
	/** Self-disconnection never lets a device select another device's identity. */
	revokeToken(token: string): boolean {
		const digest = hash(token);
		const device = this.devices.find((d) => d.hash === digest);
		if (!device) return false;
		this.revoke(device.id);
		return true;
	}
	private save(): void {
		const temp = `${this.file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temp, `${JSON.stringify(this.devices)}\n`, { mode: 0o600 });
			renameSync(temp, this.file);
		} catch {
			try {
				rmSync(temp, { force: true });
			} catch {
				// Preserve the original persistence error without exposing filesystem paths.
			}
			throw new MobileAccessError("DEVICE_STORE_UNAVAILABLE", "Could not save mobile device access", 503);
		}
	}
}

export function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
	if (res.destroyed || res.headersSent) return;
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	res.end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	if (!(req.headers["content-type"] ?? "").startsWith("application/json"))
		throw new Error("Expected application/json");
	const buffer = await new Promise<Buffer>((resolve, reject) => {
		let size = 0;
		let failed = false;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			if (failed) return;
			size += chunk.length;
			if (size > 64 * 1024) {
				failed = true;
				chunks.length = 0;
				reject(new Error("Request too large"));
			} else chunks.push(Buffer.from(chunk));
		});
		req.on("end", () => {
			if (!failed) resolve(Buffer.concat(chunks));
		});
		req.on("error", reject);
		req.on("aborted", () => reject(new Error("Request aborted")));
	});
	const value: unknown = JSON.parse(buffer.toString());
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
	return value as Record<string, unknown>;
}

/** Same origin checks as the chat; native clients have their packaged local origin. */
export function allowApi(req: IncomingMessage, res: ServerResponse, origins: Set<string>): boolean {
	const origin = req.headers.origin;
	if (origin && !origins.has(origin)) {
		req.resume();
		jsonResponse(res, 403, { error: "Origin not allowed" });
		return false;
	}
	if (origin) {
		res.setHeader("Access-Control-Allow-Origin", origin);
		res.setHeader("Vary", "Origin");
	}
	if (req.method === "OPTIONS") {
		res
			.writeHead(204, {
				"Access-Control-Allow-Methods": "GET, POST",
				"Access-Control-Allow-Headers": "Authorization, Content-Type",
				"Access-Control-Max-Age": "600",
			})
			.end();
		return false;
	}
	return true;
}
export function bearer(req: IncomingMessage): string {
	return /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
}
