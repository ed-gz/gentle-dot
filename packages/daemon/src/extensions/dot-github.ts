import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerGitHubIssues(
	pi: ExtensionAPI,
	call: (input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
): void {
	pi.registerTool({
		name: "github_issue",
		label: "Issue en GitHub",
		description:
			"Comprueba gh con status (sin leer tokens) o crea un issue en github.com con create, repo OWNER/REPO, title, body y labels opcionales: bug, enhancement, documentation, question. Cada creación pide confirmación real en PC/teléfono; ni una delegación ni el pedido inicial sustituyen esa confirmación. Nunca uses shell, gh auth token o archivos de credenciales para eludirla. Comprueba duplicados y reglas del repositorio antes de proponerlo.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["status", "create"] },
				repo: { type: "string" },
				title: { type: "string", maxLength: 256 },
				body: { type: "string", maxLength: 16000 },
				labels: {
					type: "array", maxItems: 4,
					items: { type: "string", enum: ["bug", "enhancement", "documentation", "question"] },
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
		async execute(_id, params, signal) {
			return {
				content: [{ type: "text", text: JSON.stringify(await call(params as Record<string, unknown>, signal)) }],
				details: {},
			};
		},
	});
}

export default function dotGitHub(pi: ExtensionAPI): void {
	const url = process.env.GENTLE_DOT_GITHUB_URL;
	const key = process.env.GENTLE_DOT_GITHUB_KEY;
	if (!url || !key) return;
	registerGitHubIssues(pi, async (input, signal) => {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
			body: JSON.stringify(input),
			signal: AbortSignal.any([AbortSignal.timeout(180_000), ...(signal ? [signal] : [])]),
			redirect: "error",
		});
		const result = await response.json();
		if (!response.ok) throw new Error(
			typeof result?.error === "string" ? result.error : "GitHub rechazó la operación.",
		);
		return result;
	});
}
