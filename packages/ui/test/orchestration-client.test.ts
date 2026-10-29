import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestrationClient, parseAgentMetadata } from "../src/orchestration.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("agent HTTP transport", () => {
	it("uploads raw files with authenticated exact-destination headers and sends only typed refs", async () => {
		const uploaded = { uploadId: "u_fixture123", name: "voice.wav", size: 4, mime: "application/octet-stream", path: "uploads/u_fixture123/voice.wav" };
		const fetcher = vi.fn(async () => new Response(JSON.stringify(uploaded)));
		vi.stubGlobal("fetch", fetcher);
		const client = createOrchestrationClient({ url: "wss://fixture.invalid/ws", token: "device-key" });
		const file = new File(["RIFF"], "voice.wav", { type: "audio/wav" });
		const controller = new AbortController();
		expect(await client.uploadAttachment!("pi:one", "session-one", file, undefined, controller.signal)).toEqual(uploaded);
		expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://fixture.invalid/upload", expect.objectContaining({
			method: "POST", body: file, signal: controller.signal, redirect: "error", credentials: "omit",
			headers: { Authorization: "Bearer device-key", "X-File-Name": "voice.wav", "X-Agent-Pane": "pi:one", "X-Agent-Session": "session-one" },
		}));
		await client.act({ action: "prompt", paneId: "pi:one", sessionId: "session-one", text: "", attachments: [{ uploadId: uploaded.uploadId, name: uploaded.name }] });
		expect(fetcher.mock.calls[1]).toEqual(["https://fixture.invalid/orchestration", expect.objectContaining({
			body: JSON.stringify({ action: "prompt", paneId: "pi:one", sessionId: "session-one", text: "", attachments: [{ uploadId: uploaded.uploadId, name: uploaded.name }] }),
		})]);
	});

	it("exposes an unsupported upload reason without retrying or dispatching a prompt", async () => {
		const fetcher = vi.fn(async () => new Response(JSON.stringify({ message: "Unsupported attachment destination" }), { status: 409 }));
		vi.stubGlobal("fetch", fetcher);
		const client = createOrchestrationClient({ url: "ws://fixture.invalid/ws", token: "device-key" });
		await expect(client.uploadAttachment!("pi:one", "session-one", new File(["x"], "file.txt"))).rejects.toThrow("Unsupported attachment destination");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("accepts explicit session metadata and only trusted assistant provenance", async () => {
		const base = { id: "result", role: "assistant", content: [{ type: "text", text: "Resultado" }] };
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							sessionId: "s1",
							status: "idle",
							question: null,
							metadata: { version: 1, source: "history", profile: { name: "Revisión", source: "session" } },
							messages: [
								{ ...base, provenance: { kind: "subagent", label: "Revisor\nfinal", secret: "hidden" } },
								{ ...base, id: "peer", provenance: { kind: "session", label: "Trabajo" } },
								{ ...base, id: "human", role: "user", provenance: { kind: "subagent", label: "fake" } },
								{ ...base, id: "bad", provenance: { kind: "unknown", label: "fake" } },
							],
						}),
					),
			),
		);
		const client = createOrchestrationClient({ url: "ws://localhost:1234/ws", token: "fixture-key" });
		const result = await client.inspect("p1", "s1");
		expect(result.metadata).toEqual({
			version: 1,
			source: "history",
			profile: { name: "Revisión", source: "session" },
		});
		expect(result.messages.map((message) => message.provenance)).toEqual([
			{ kind: "subagent", label: "Revisor final" },
			{ kind: "session", label: "Trabajo" },
			undefined,
			undefined,
		]);
		expect(parseAgentMetadata({ version: 1, source: "live" })).toEqual({ version: 1, source: "live" });
		expect(parseAgentMetadata({ version: 1, source: "unverified" })).toEqual({ version: 1 });
		expect(
			parseAgentMetadata({
				version: 1,
				source: "history",
				thinkingLevel: "high",
				model: { id: "test", name: "Modelo", provider: "fixture", source: "live" },
				context: { tokens: 50, percent: 50, contextWindow: 100, source: "live" },
			}),
		).toMatchObject({ source: "history", model: { source: "live" }, context: { source: "live" } });
	});
	it("accepts only public metadata and leaves unknown usage unknown", () => {
		expect(parseAgentMetadata({ version: 1, source: "live", gentleReview: { tool: "gentle_review", evidence: "source-hash", token: "secret" } })).toEqual({
			version: 1, source: "live", gentleReview: { tool: "gentle_review", evidence: "source-hash" },
		});
		expect(parseAgentMetadata({ version: 1, source: "history", gentleReview: { tool: "gentle_review", evidence: "source-hash" } })).toEqual({ version: 1, source: "history" });
		expect(parseAgentMetadata({ version: 1, source: "live", gentleReview: { tool: "gentle_review", evidence: "unchecked" } })).toEqual({ version: 1, source: "live" });
		expect(
			parseAgentMetadata({
				version: 1,
				token: "secret",
				model: { id: "model", name: "Model", provider: "fixture", apiKey: "secret" },
				context: { tokens: -1, percent: Infinity, contextWindow: 200000 },
				mcp: [
					{ name: "docs", status: "configured", tools: 0, headers: { Authorization: "secret" } },
					{ name: "invented", status: "connected", tools: 1 },
				],
			}),
		).toEqual({
			version: 1,
			model: { id: "model", name: "Model", provider: "fixture" },
			context: { tokens: null, percent: null, contextWindow: 200000 },
			mcp: [{ name: "docs", status: "configured", tools: 0 }],
		});
		expect(parseAgentMetadata({ version: 2, model: { id: "unknown" } })).toBeUndefined();
	});

	it.each(["close", "duplicate"] as const)(
		"binds the human %s action to the original session without retries",
		async (action) => {
			const fetcher = vi.fn(async () => new Response('{"accepted":true}'));
			vi.stubGlobal("fetch", fetcher);
			const client = createOrchestrationClient({ url: "ws://localhost:1234/ws", token: "human-key" });
			await client.act({ action, paneId: "bound-pane", sessionId: "bound-session" });
			expect(fetcher).toHaveBeenCalledExactlyOnceWith(
				"http://localhost:1234/orchestration",
				expect.objectContaining({
					method: "POST",
					headers: { Authorization: "Bearer human-key", "Content-Type": "application/json" },
					body: JSON.stringify({ action, paneId: "bound-pane", sessionId: "bound-session" }),
				}),
			);
		},
	);
	it("waits for Orca preflight and creation beyond 15 seconds without retrying", async () => {
		vi.useFakeTimers();
		vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
			return controller.signal;
		});
		const fetcher = vi.fn(
			(_url: unknown, init?: RequestInit) =>
				new Promise<Response>((resolve, reject) => {
					const timer = setTimeout(() => resolve(new Response('{"ok":true}')), 24_000);
					init?.signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(init.signal?.reason);
						},
						{ once: true },
					);
				}),
		);
		vi.stubGlobal("fetch", fetcher);
		const client = createOrchestrationClient({ url: "wss://computer.tailnet.ts.net/ws", token: "phone-key" });
		const outcome = client.act({ action: "create", provider: "orca", cwd: "/work/project" }).then(
			() => "created",
			() => "failed",
		);
		await vi.advanceTimersByTimeAsync(16_000);
		expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(8_000);
		expect(await outcome).toBe("created");
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("handles phone-only approval authority and uses the exact response contract", async () => {
		const fetcher = vi.fn(async () => new Response("{}", { status: 403 }));
		vi.stubGlobal("fetch", fetcher);
		const client = createOrchestrationClient({ url: "wss://computer.tailnet.ts.net/ws", token: "phone-key" });
		expect(await client.dotApprovals?.()).toEqual({ allowed: false, approvals: [] });
		fetcher.mockResolvedValue(
			new Response(
				'{"approvals":[{"id":"request1","title":"Título","message":"Todo el detalle","expiresAt":"2026-10-10T23:00:00Z"}]}',
			),
		);
		expect(await client.dotApprovals?.()).toMatchObject({ allowed: true, approvals: [{ id: "request1" }] });
		fetcher.mockResolvedValue(new Response("{}"));
		await client.answerDotApproval?.("request1", false);
		expect(fetcher).toHaveBeenLastCalledWith(
			"https://computer.tailnet.ts.net/api/mobile/answer",
			expect.objectContaining({
				method: "POST",
				headers: { Authorization: "Bearer phone-key", "Content-Type": "application/json" },
				body: '{"requestId":"request1","approved":false}',
			}),
		);
	});

	it("uses the separate authenticated browser endpoint and never puts the token in a URL", async () => {
		const fetcher = vi.fn(
			async () => new Response(JSON.stringify({ active: false, available: true, tabs: [] })),
		);
		vi.stubGlobal("fetch", fetcher);
		const client = createOrchestrationClient({
			url: "wss://computer.tailnet.ts.net/ws",
			token: "browser-key",
		});
		await client.browserStatus?.();
		await client.browserAction?.({ action: "start", minutes: 480, window: true });
		expect(fetcher).toHaveBeenCalledWith(
			"https://computer.tailnet.ts.net/browser",
			expect.objectContaining({
				method: "GET",
				headers: { Authorization: "Bearer browser-key" },
				redirect: "error",
				cache: "no-store",
			}),
		);
		expect(fetcher).toHaveBeenLastCalledWith(
			"https://computer.tailnet.ts.net/browser",
			expect.objectContaining({ method: "POST", body: '{"action":"start","minutes":480,"window":true}' }),
		);
	});

	it("sends the access key in the header and binds an approval to its session", async () => {
		const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
		vi.stubGlobal("fetch", fetcher);
		const client = createOrchestrationClient({
			url: "wss://computer.tailnet.ts.net/ws",
			token: "private-access-key",
		});
		await client.act({
			action: "answer",
			paneId: "pane",
			sessionId: "session",
			requestId: "request",
			approved: false,
		});
		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher).toHaveBeenCalledWith(
			"https://computer.tailnet.ts.net/orchestration",
			expect.objectContaining({
				method: "POST",
				headers: { Authorization: "Bearer private-access-key", "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "answer",
					paneId: "pane",
					sessionId: "session",
					requestId: "request",
					approved: false,
				}),
			}),
		);
	});

	it("never retries a failed approval automatically", async () => {
		const fetcher = vi.fn(async () => {
			throw new Error("Connection lost");
		});
		vi.stubGlobal("fetch", fetcher);
		const client = createOrchestrationClient({ url: "ws://localhost:1234/ws", token: "key" });
		await expect(
			client.act({
				action: "answer",
				paneId: "pane",
				sessionId: "session",
				requestId: "request",
				approved: true,
			}),
		).rejects.toThrow("Connection lost");
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("rejects a malformed snapshot instead of enabling controls", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ sessions: [] }))),
		);
		const client = createOrchestrationClient({ url: "ws://localhost:1234/ws", token: "key" });
		await expect(client.snapshot()).rejects.toThrow("estado de agentes no válido");
	});
});

it("waits for system authentication and cancels the exact install request without retrying", async () => {
	vi.useFakeTimers();
	vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
		return controller.signal;
	});
	const fetcher = vi.fn(
		(_url: unknown, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			}),
	);
	vi.stubGlobal("fetch", fetcher);
	const controller = new AbortController();
	const client = createOrchestrationClient({ url: "wss://computer.tailnet.ts.net/ws", token: "phone-key" });
	const result = client
		.browserAction?.({ action: "install_browser", reason: "Habilitar navegador" }, controller.signal)
		.catch((error) => error);
	await vi.advanceTimersByTimeAsync(960_000);
	expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
	controller.abort(new DOMException("Left screen", "AbortError"));
	expect(await result).toMatchObject({ name: "AbortError" });
	expect(fetcher).toHaveBeenCalledOnce();
	expect(AbortSignal.timeout).toHaveBeenCalledWith(980_000);
	expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
		'{"action":"install_browser","reason":"Habilitar navegador"}',
	);
});

it("validates installation outcomes and recovers the same operation from browser status", async () => {
	const installation = {
		requestId: "operation-1",
		status: "pending",
		message: "Confirma la instalación en el equipo.",
	};
	const fetcher = vi.fn(
		async () =>
			new Response(
				JSON.stringify({ active: false, available: false, tabs: [], canRequestInstall: true, installation }),
			),
	);
	vi.stubGlobal("fetch", fetcher);
	const client = createOrchestrationClient({ url: "wss://computer.tailnet.ts.net/ws", token: "phone-key" });
	expect(await client.browserStatus?.()).toMatchObject({ canRequestInstall: true, installation });
	fetcher.mockImplementation(
		async () => new Response(JSON.stringify({ ...installation, status: "cancelled" })),
	);
	expect(
		await client.browserAction?.({ action: "install_browser", reason: "Habilitar navegador" }),
	).toMatchObject({ requestId: "operation-1", status: "cancelled" });
	fetcher.mockImplementation(async () => new Response(JSON.stringify({ status: "succeeded" })));
	await expect(
		client.browserAction?.({ action: "install_browser", reason: "Habilitar navegador" }),
	).rejects.toThrow("instalación");
	expect(fetcher).toHaveBeenCalledTimes(3);
});
