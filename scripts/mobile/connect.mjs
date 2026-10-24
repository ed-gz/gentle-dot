#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
	const i = args.indexOf(name);
	return i < 0 ? undefined : args[i + 1];
};
const dataDir = process.env.GENTLE_DOT_DATA_DIR || join(homedir(), ".gentle-dot");
const token = readFileSync(join(dataDir, "token"), "utf8").trim();
const port = process.env.GENTLE_DOT_PORT || "4317";
const api = async (path, body) => {
	const response = await fetch(`http://127.0.0.1:${port}/api/mobile/${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(10_000),
	});
	const result = await response.json();
	if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
	return result;
};
if (args.includes("--list")) {
	console.log(JSON.stringify(await api("devices"), null, 2));
} else if (args.includes("--revoke")) {
	const deviceId = option("--revoke");
	if (!deviceId) throw new Error("Specify the device ID shown by --list");
	await api("revoke", { deviceId });
	console.log("Device access revoked.");
} else {
	let base = option("--url");
	if (!base) {
		const status = JSON.parse(
			execFileSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 10_000 }),
		);
		if (status.BackendState !== "Running" || !status.Self?.DNSName)
			throw new Error("Connect Tailscale first.");
		base = `https://${status.Self.DNSName.replace(/\.$/, "")}`;
	}
	const url = new URL(base);
	if (
		url.protocol !== "https:" ||
		!url.hostname.endsWith(".ts.net") ||
		url.username ||
		url.password ||
		url.port ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("Use your private HTTPS Tailscale origin.");
	// Verify that Serve reaches this daemon before producing an unusable QR.
	const check = await fetch(`${url.origin}/api/mobile/devices`, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(10_000),
	});
	if (!check.ok)
		throw new Error("The Tailscale URL does not reach this Gentle Dot daemon. Check tailscale serve status.");
	const { code, expiresAt } = await api("code", {});
	const link = `gentledot://pair?${new URLSearchParams({ url: url.origin, code, name: "Gentle Dot" })}`;
	console.log(`Scan in Gentle Dot Android. Expires ${expiresAt}. Keep the QR private.`);
	const rendered = spawnSync("qrencode", ["-t", "ANSIUTF8"], { input: link, encoding: "utf8" });
	if (rendered.status === 0) process.stdout.write(rendered.stdout);
	else console.log("Install qrencode for a terminal QR.");
	const output = option("--output");
	if (output) {
		const dir = resolve(output);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const png = spawnSync("qrencode", ["-s", "8", "-m", "4", "-o", join(dir, "gentle-dot-pair.png")], {
			input: link,
		});
		if (png.status !== 0) throw new Error("qrencode could not create the image");
		chmodSync(join(dir, "gentle-dot-pair.png"), 0o600);
		writeFileSync(join(dir, "gentle-dot-pair.txt"), `${link}\nExpires: ${expiresAt}\n`, { mode: 0o600 });
		console.log(`QR saved in ${dir}`);
	}
	if (args.includes("--show-link")) console.log(link);
}
