import type { DesktopCompanionContext, DesktopCompanionCue } from "./desktop-companion.ts";

/** File events are acted out. They must never be acknowledged by an invisible speech surface. */
export function isVisualNotification(cue: DesktopCompanionCue | undefined) {
	return cue?.kind === "capture" || cue?.kind === "download";
}
export function spokenCompanionCue(context: DesktopCompanionContext | undefined, now = Date.now()) {
	return [context?.notification, context?.cue].find(
		(cue) =>
			cue &&
			cue.expiresAt > now &&
			!isVisualNotification(cue) &&
			cue.kind !== "input-ready" &&
			(!!cue.summary || !!cue.body || cue.kind === "question"),
	);
}

/** Slack web notifications can arrive under the browser identity. Never infer a website from that. */
function messageEnvelope(cue: DesktopCompanionCue, supported: boolean) {
	if (!supported || !/^Nuevo mensaje en(?:\s+\S.*|…|\.{3})$/i.test(cue.summary ?? "")) return undefined;
	const match = /^([^:\n]{1,80}):[ \t]+([\s\S]+)$/.exec(cue.body ?? "");
	if (!match) return undefined;
	const sender = match[1]!.trim();
	// Ambiguous short labels stay untouched. Explicit sender metadata also supports mononyms.
	if (!/^[\p{L}\p{M}][\p{L}\p{M} .’'-]*$/u.test(sender) || sender.split(/\s+/).length < 2) return undefined;
	return { sender, body: match[2]! };
}

/** Only successful screenshot notices lose their details; errors remain actionable notices. */
function screenshotPresentation(cue: DesktopCompanionCue) {
	if (cue.kind !== "notification" && cue.kind !== "capture") return;
	const identity = `${cue.source?.appName ?? ""} ${cue.source?.desktopEntry ?? ""}`;
	const screenshot = cue.kind === "capture" ||
		/(?:^|[\s./-])(?:screenshot|hyprshot|grimblast|flameshot|spectacle|gnome-screenshot)(?:$|[\s./-])/i.test(identity) ||
		/^(?:screenshot|captura)\b/i.test(cue.summary ?? "");
	if (!screenshot) return;
	// Filenames and folders are not evidence of clipboard or save status.
	const status = `${cue.summary ?? ""} ${cue.body ?? ""}`.replace(/(?:File|Folder|Archivo|Carpeta):[^\n]*/gi, "");
	if (/\b(?:error|failed|failure|denied|warning|authentication|password|login|contraseña|autenticación|advertencia|cancelled|canceled|fallida|falló|cancelada|cancelado|missing dependencies)\b/i.test(status)) return;
	// The local screenshot tool copies by default; only an explicit "not copied" notice says otherwise.
	const notCopied = /\b(?:not copied|no copiad[ao]|sin copiar|only saved|solo guardad[ao])\b/i.test(status);
	return {
		summary: notCopied ? "Captura guardada" : "Captura tomada y copiada",
		body: undefined, quoted: false, showMore: false,
	};
}

/** Attribution comes from transport metadata or a recognized app-specific envelope. */
export function notificationPresentation(cue: DesktopCompanionCue): { summary: string; body?: string; quoted: boolean; showMore?: boolean } {
	const screenshot = screenshotPresentation(cue);
	if (screenshot) return screenshot;
	const source = cue.source;
	if (cue.kind !== "notification" || !source)
		return { summary: cue.summary ?? "Hay un aviso para ti.", body: cue.body, quoted: false };
	const identity = `${source.desktopEntry ?? ""} ${source.appName ?? ""}`.toLowerCase();
	const browser = /(?:^|[\s./-])(?:chrome|chromium|brave|edge|firefox|vivaldi|opera)(?:$|[\s./-])/.test(
		identity,
	);
	const app = /(?:^|[\s./-])slack(?:$|[\s./-])/.test(identity)
		? "Slack"
		: /(?:chatgpt|codex)/.test(identity)
			? source.appName?.toLowerCase().includes("codex")
				? "Codex"
				: "ChatGPT"
			: /(?:herdr|gentle.?shell)/.test(identity)
				? "Herdr"
				: browser
					? undefined
					: source.appName;
	const envelope = source.sender ? undefined : messageEnvelope(cue, app === "Slack" || browser);
	const sender = source.sender ?? envelope?.sender;
	let body = envelope?.body ?? cue.body;
	if (app === "Slack" && source.sender && body?.startsWith(`${source.sender}: `))
		body = body.slice(source.sender.length + 2);
	const wrapper =
		(app === "Slack" || browser) && /^Nuevo mensaje en(?:\s+\S.*|…|\.{3})$/i.test(cue.summary ?? "");
	const messaging = sender || wrapper || source.category === "im.received";
	const summary = sender
		? `${sender} te escribió${app ? ` en ${app}` : ""}.`
		: messaging
			? `Te llegó un mensaje${app ? ` en ${app}` : ""}.`
			: app
				? `${app} te avisa.`
				: "Te llegó una notificación.";
	// Preserve substantive titles (errors, authentication requests, conversation names).
	const title = cue.summary?.trim();
	const detail =
		body && title && !wrapper && title !== sender && title !== app && title !== body
			? `${title}\n${body}`
			: body || title;
	// The source wording stays a quotation; Capri never claims to have said or performed it.
	return { summary, body: detail, quoted: true };
}
