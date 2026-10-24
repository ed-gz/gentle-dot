export interface Invitation {
	url: string;
	code: string;
	name: string;
}
export interface Connection {
	url: string;
	token: string;
	deviceId: string;
	name: string;
}

export function privateOrigin(input: string): string {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error("El equipo debe tener una dirección HTTPS de Tailscale.");
	}
	if (
		url.protocol !== "https:" ||
		!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/i.test(url.hostname) ||
		url.username ||
		url.password ||
		url.port ||
		!["", "/"].includes(url.pathname) ||
		url.search ||
		url.hash
	) {
		throw new Error("Usa la dirección HTTPS de tu equipo en Tailscale, sin rutas ni contraseñas.");
	}
	return url.origin;
}

export function parseInvitation(input: string): Invitation {
	if (input.length > 4096) throw new Error("El enlace es demasiado largo.");
	let link: URL;
	try {
		link = new URL(input.trim());
	} catch {
		throw new Error("Pega el enlace completo del QR de Gentle Dot.");
	}
	if (
		link.protocol !== "gentledot:" ||
		link.hostname !== "pair" ||
		link.username ||
		link.password ||
		link.port ||
		!["", "/"].includes(link.pathname) ||
		link.hash
	) {
		throw new Error("Este QR no es una invitación de Gentle Dot.");
	}
	for (const key of link.searchParams.keys()) {
		if (!["url", "code", "name"].includes(key) || link.searchParams.getAll(key).length !== 1)
			throw new Error("La invitación contiene parámetros no válidos.");
	}
	const code = link.searchParams.get("code") ?? "";
	if (!/^[A-Za-z0-9_-]{20,128}$/.test(code)) throw new Error("El código de vinculación no es válido.");
	return {
		url: privateOrigin(link.searchParams.get("url") ?? ""),
		code,
		// biome-ignore lint/suspicious/noControlCharactersInRegex: discard untrusted label control characters
		name: (link.searchParams.get("name") || "Mi equipo").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80),
	};
}

export function validConnection(value: unknown): value is Connection {
	if (!value || typeof value !== "object") return false;
	const c = value as Partial<Connection>;
	if (
		typeof c.url !== "string" ||
		typeof c.token !== "string" ||
		!/^[A-Za-z0-9_-]{32,1024}$/.test(c.token) ||
		typeof c.deviceId !== "string" ||
		!c.deviceId ||
		typeof c.name !== "string"
	)
		return false;
	try {
		return privateOrigin(c.url) === c.url;
	} catch {
		return false;
	}
}

export async function redeemPairing(invitation: Invitation, deviceName: string): Promise<Connection> {
	const valid = parseInvitation(`gentledot://pair?${new URLSearchParams({ ...invitation })}`);
	let response: Response;
	try {
		response = await fetch(`${valid.url}/api/mobile/pair`, {
			method: "POST",
			credentials: "omit",
			redirect: "error",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code: valid.code, deviceName: deviceName.trim().slice(0, 80) || "Mi Android" }),
			signal: AbortSignal.timeout(150000),
		});
	} catch {
		throw new Error(
			"No se pudo contactar con tu equipo. Activa Tailscale en ambos dispositivos y comprueba que Gentle Dot sigue abierto.",
		);
	}
	if (response.status === 403)
		throw new Error(
			"No se autorizó la vinculación en tu equipo. Abre la app de escritorio y acepta la solicitud para este teléfono antes de volver a intentar.",
		);
	if ([400, 401, 410].includes(response.status))
		throw new Error("El código caducó, ya fue utilizado o no es válido. Genera otro QR desde tu equipo.");
	if (response.status === 409) {
		let pending = false;
		try {
			pending = (await response.json())?.code === "PAIRING_IN_PROGRESS";
		} catch {
			// Older daemons do not include a machine-readable error code.
		}
		throw new Error(
			pending
				? "Esta invitación ya está esperando confirmación en el equipo. Revisa la solicitud abierta antes de volver a intentar."
				: "El equipo alcanzó su límite de teléfonos. Revoca un dispositivo anterior desde el equipo e intenta de nuevo con este QR.",
		);
	}
	if (response.status === 503)
		throw new Error(
			"El equipo no pudo guardar el acceso. Revisa el espacio y los permisos de almacenamiento en el equipo antes de intentar de nuevo.",
		);
	if (response.status === 429) throw new Error("Demasiados intentos. Espera un minuto y genera otro QR.");
	if (!response.ok)
		throw new Error("No se pudo vincular. Comprueba que el equipo tiene la versión actual de Gentle Dot.");
	const result: unknown = await response.json();
	const data = result as { token?: unknown; deviceId?: unknown };
	const connection = { url: valid.url, token: data?.token, deviceId: data?.deviceId, name: valid.name };
	if (!validConnection(connection))
		throw new Error("El equipo devolvió una credencial no válida. Genera otro QR.");
	return connection;
}

/** Keep the local credential until the server confirms it can no longer be used. */
export async function disconnectDevice(connection: Connection): Promise<void> {
	if (!validConnection(connection)) throw new Error("La conexión guardada no es válida.");
	let response: Response;
	try {
		response = await fetch(`${connection.url}/api/mobile/disconnect`, {
			method: "POST",
			credentials: "omit",
			redirect: "error",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.token}` },
			body: "{}",
			signal: AbortSignal.timeout(15000),
		});
	} catch {
		throw new Error(
			"No se pudo retirar el acceso en el equipo. Activa Tailscale y vuelve a intentar Desvincular; tu conexión se conserva.",
		);
	}
	if (response.status === 200 || response.status === 401) return;
	throw new Error(
		"El equipo no pudo retirar el acceso. Actualiza Gentle Dot en el equipo y vuelve a intentar Desvincular; tu conexión se conserva.",
	);
}
