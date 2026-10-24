import type { localRequest } from "./herdr.ts";
import { processIdentity } from "./process-identity.ts";
import type { Manifest } from "./registry.ts";
import { publicSessionMetadata, type SessionMetadata } from "./session-info.ts";

/** Older Dot adapters coexist with HERDR Connect inside the very same Pi process.
 * Its read-only snapshot can report model/context without reloading or cancelling background jobs.
 * The peer never supplies permissions, control capabilities, prompts, profile or MCP claims.
 */
export async function peerSessionMetadata(
	bound: Manifest,
	manifests: Manifest[],
	request: typeof localRequest,
	authorized: () => boolean,
	identify: typeof processIdentity = processIdentity,
): Promise<SessionMetadata | undefined> {
	if (
		bound.version !== 2 ||
		!bound.managed ||
		!bound.processIdentity ||
		(bound.binding.provider ?? "herdr") !== "herdr"
	)
		return;
	const peers = manifests.filter(
		(candidate) =>
			candidate.managed !== true &&
			candidate.socketPath !== bound.socketPath &&
			candidate.pid === bound.pid &&
			candidate.sessionId === bound.sessionId &&
			(candidate.binding.provider ?? "herdr") === "herdr" &&
			String(candidate.binding.terminalId) === String(bound.binding.terminalId) &&
			candidate.binding.herdrSocketPath === bound.binding.herdrSocketPath &&
			candidate.sessionFile === bound.sessionFile &&
			(!candidate.processIdentity || candidate.processIdentity === bound.processIdentity),
	);
	const peer = peers[0];
	if (peers.length !== 1 || !peer || !authorized()) return;
	try {
		if ((await identify(bound.pid)) !== bound.processIdentity || !authorized()) return;
		const page = await request(
			peer.socketPath,
			"snapshot",
			{
				expectedSessionId: bound.sessionId,
				limit: 1,
				...(peer.instanceId ? { expectedInstanceId: peer.instanceId } : {}),
			},
			750,
			authorized,
		);
		if (
			!authorized() ||
			page.sessionId !== bound.sessionId ||
			(peer.instanceId && page.instanceId !== peer.instanceId) ||
			(await identify(bound.pid)) !== bound.processIdentity
		)
			return;
		const clean = publicSessionMetadata({
			version: 1,
			source: "live",
			model: page.model,
			context: page.context,
		});
		if (!clean?.model && !clean?.context) return;
		if (clean.model) clean.model.source = "live";
		if (clean.context) clean.context.source = "live";
		return clean;
	} catch {
		return;
	}
}
