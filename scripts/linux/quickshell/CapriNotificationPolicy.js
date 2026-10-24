/* biome-ignore-all lint/correctness/noUnusedVariables: QML imports these top-level functions directly. */

// Explicit GVariant string literals; argv never passes through a shell.
function variantString(value, limit) {
	return (
		"'" +
		String(value || "")
			.slice(0, limit)
			.replace(/\0/g, "")
			.replace(/\\/g, "\\\\")
			.replace(/'/g, "\\'")
			.replace(/\n/g, "\\n")
			.replace(/\r/g, "\\r")
			.replace(/\t/g, "\\t") +
		"'"
	);
}

function command(method, args) {
	return [
		"gdbus",
		"call",
		"--session",
		"--dest",
		"io.gentledot.Companion",
		"--object-path",
		"/io/gentledot/Companion",
		"--method",
		`io.gentledot.Companion1.${method}`,
		"--timeout",
		"1",
	].concat(args);
}

function boundedString(value, limit) {
	if (typeof value !== "string") return "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: source labels must not carry transport control bytes.
	const clean = value.replace(/[\u0000-\u001f\u007f]/g, "");
	return clean.trim().slice(0, limit);
}

function notificationSource(data) {
	const notice = data.notif || {};
	const hints = notice.hints || {};
	const source = {};
	const values = {
		appName: boundedString(data.appName || notice.appName, 160),
		desktopEntry: boundedString(notice.desktopEntry || hints["desktop-entry"], 160),
		category: boundedString(hints.category, 128),
		// Only explicit structured producer metadata can attribute an author/conversation.
		sender: boundedString(hints["x-gentle-sender"], 160),
		conversation: boundedString(hints["x-gentle-conversation"], 240),
	};
	Object.keys(values).forEach((key) => {
		if (values[key]) source[key] = values[key];
	});
	if (typeof notice.urgency === "number" && notice.urgency >= 0 && notice.urgency <= 2)
		source.urgency = notice.urgency;
	return source;
}

function notificationKind(source, summary, body) {
	const app = String(source.appName || "")
		.trim()
		.toLowerCase();
	const desktop = String(source.desktopEntry || "")
		.trim()
		.replace(/\.desktop$/, "")
		.toLowerCase();
	const category = String(source.category || "")
		.trim()
		.toLowerCase();
	const title = String(summary || "")
		.trim()
		.toLowerCase();
	const alertWords = [
		"error",
		"errors",
		"failed",
		"failure",
		"denied",
		"warning",
		"authentication",
		"password",
		"login",
		"contraseña",
		"autenticación",
		"advertencia",
		"falló",
		"fallida",
		"cancelled",
		"canceled",
		"cancelado",
	];
	const alert = String(summary || "")
		.concat(" ", String(body || ""))
		.toLowerCase()
		.split(/[^a-z0-9áéíóúüñ]+/)
		.some((word) => alertWords.indexOf(word) !== -1);
	const messaging =
		[
			"slack",
			"herdr",
			"chatgpt",
			"codex",
			"discord",
			"telegram",
			"signal",
			"teams",
			"microsoft teams",
			"whatsapp",
		].indexOf(app) !== -1 ||
		[
			"com.slack.slack",
			"slack",
			"herdr",
			"chatgpt",
			"com.openai.chatgpt",
			"codex",
			"discord",
			"org.telegram.desktop",
			"org.signal.signal",
		].indexOf(desktop) !== -1;
	if (
		source.urgency === 2 ||
		alert ||
		messaging ||
		category.indexOf("im.") === 0 ||
		category.indexOf("email.") === 0 ||
		category.indexOf("error") !== -1 ||
		category.indexOf("auth") !== -1 ||
		category.indexOf("security") === 0
	)
		return "notification";
	if (app === "screenshot" && title === "screenshot saved") return "capture";
	if (category === "transfer.complete") return "download";
	const downloader =
		["aria2", "motrix", "transmission", "qbittorrent", "jdownloader"].indexOf(app) !== -1 ||
		[
			"aria2",
			"motrix",
			"transmission-gtk",
			"org.qbittorrent.qbittorrent",
			"org.jdownloader.jdownloader",
		].indexOf(desktop) !== -1;
	if (
		downloader &&
		[
			"download complete",
			"download completed",
			"download finished",
			"descarga completa",
			"descarga completada",
		].indexOf(title) !== -1
	)
		return "download";
	return "notification";
}

function offerCommand(id, summary, body, source) {
	const args = [variantString(id, 160), variantString(summary, 512), variantString(body, 4096)];
	// Keep an old bridge usable while its helper files are atomically upgraded.
	if (source === undefined) return command("OfferNotification", args);
	args.push(variantString(JSON.stringify(source), 8192));
	return command("OfferNotificationV2", args);
}

function cancelCommand(id) {
	return command("CancelNotification", [variantString(id, 160)]);
}

function acceptedReply(output, exitCode, exitStatus) {
	return exitCode === 0 && exitStatus === 0 && /^\(true,\)\s*$/.test(String(output));
}
