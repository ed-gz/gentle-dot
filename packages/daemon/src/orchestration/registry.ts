import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { OrchestrationError, record } from "./herdr.ts";
import { processIdentity } from "./process-identity.ts";

export type DisplayProvider = "herdr" | "orca" | "terminal";

export interface Manifest {
	version: 1 | 2;
	socketPath: string;
	pid: number;
	sessionId: string;
	sessionFile?: string;
	managed?: boolean;
	instanceId?: string;
	processIdentity?: string;
	cwd?: string;
	label?: string;
	binding: {
		provider?: DisplayProvider;
		herdrSocketPath?: string;
		terminalId: string;
		paneId?: string;
		orcaPaneKey?: string;
	};
}

const privateOwner = (stat: { uid: number; mode: number }) =>
	(!process.getuid || stat.uid === process.getuid()) && (stat.mode & 0o077) === 0;

/** Only a private, live manifest tied to HERDR's actual foreground process may receive input. */
export async function readManifests(directories: string[], herdrSocket: string): Promise<Manifest[]> {
	const manifests: Manifest[] = [];
	let canonicalSocket: string | undefined;
	try {
		canonicalSocket = realpathSync(herdrSocket);
	} catch {
		// Portable Pi sessions remain reachable while HERDR is stopped.
	}
	for (const directory of new Set(directories)) {
		try {
			const stat = lstatSync(directory);
			if (!stat.isDirectory() || stat.isSymbolicLink() || !privateOwner(stat)) continue;
			const canonical = realpathSync(directory);
			let count = 0;
			for (const entry of readdirSync(canonical, { withFileTypes: true })) {
				if (++count > 256) throw new OrchestrationError("REGISTRY_LIMIT", "Demasiados registros de Pi.");
				if (!entry.name.endsWith(".json") || !entry.isFile()) continue;
				let file: number | undefined;
				try {
					file = openSync(
						join(canonical, entry.name),
						constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
					);
					const info = fstatSync(file);
					if (!info.isFile() || !privateOwner(info) || info.size > 64 * 1024) continue;
					const value: unknown = JSON.parse(readFileSync(file, "utf8"));
					if (
						!record(value) ||
						(value.version !== 1 && value.version !== 2) ||
						typeof value.socketPath !== "string" ||
						!Number.isInteger(value.pid) ||
						(value.pid as number) <= 0 ||
						typeof value.sessionId !== "string" ||
						!value.sessionId ||
						!record(value.binding) ||
						!["string", "number"].includes(typeof value.binding.terminalId)
					)
						continue;
					if (!isAbsolute(value.socketPath) || dirname(resolve(value.socketPath)) !== canonical) continue;
					const provider = value.binding.provider ?? "herdr";
					if (!["herdr", "orca", "terminal"].includes(String(provider))) continue;
					if (value.version === 1 && provider !== "herdr") continue;
					if (
						provider === "herdr" &&
						(!canonicalSocket ||
							typeof value.binding.herdrSocketPath !== "string" ||
							realpathSync(value.binding.herdrSocketPath) !== canonicalSocket)
					)
						continue;
					if (
						value.version === 2 &&
						(typeof value.instanceId !== "string" ||
							!/^[a-f0-9-]{36}$/.test(value.instanceId) ||
							typeof value.processIdentity !== "string" ||
							(await processIdentity(value.pid as number)) !== value.processIdentity)
					)
						continue;
					const socket = lstatSync(value.socketPath);
					if (!socket.isSocket() || socket.isSymbolicLink() || !privateOwner(socket)) continue;
					process.kill(value.pid as number, 0);
					manifests.push(value as unknown as Manifest);
				} catch {
					/* Stale or unsafe registrations are never input targets. */
				} finally {
					if (file !== undefined) closeSync(file);
				}
			}
		} catch (error) {
			if (error instanceof OrchestrationError) throw error;
		}
	}
	return manifests;
}
