import { afterEach, describe, expect, it, vi } from "vitest";
import {
	disconnectDevice,
	parseInvitation,
	privateOrigin,
	redeemPairing,
	validConnection,
} from "../src/pairing.ts";

const origin = "https://desktop.example-tailnet.ts.net";
const code = "a".repeat(32);
const invitation = `gentledot://pair?${new URLSearchParams({ url: origin, code, name: "Mi equipo" })}`;
afterEach(() => vi.unstubAllGlobals());
describe("mobile pairing boundary", () => {
	it("accepts only a Tailscale HTTPS origin and a one-time invitation", () => {
		expect(parseInvitation(invitation)).toEqual({ url: origin, code, name: "Mi equipo" });
		expect(privateOrigin(`${origin}/`)).toBe(origin);
	});
	it.each([
		"http://desktop.example-tailnet.ts.net",
		"https://desktop.example-tailnet.ts.net.evil.test",
		"https://user:password@desktop.example-tailnet.ts.net",
		`${origin}/anything`,
		`${origin}?token=secret`,
		`${origin}#fragment`,
		`${origin}:8443`,
		"https://example.com",
		"https://100.64.1.2",
	])("rejects unsafe/private-service ambiguous origins: %s", (value) => {
		expect(() => privateOrigin(value)).toThrow();
	});
	it.each([
		`${invitation}&code=${code}`,
		`${invitation}&token=secret`,
		`${invitation}#fragment`,
		invitation.replace("gentledot:", "https:"),
		invitation.replace(code, "123456"),
		"gentledot://pair@attacker.test",
	])("rejects malformed invitations", (value) => {
		expect(() => parseInvitation(value)).toThrow();
	});
	it("redeems with no redirects or cookies and keeps the response scoped to the scanned origin", async () => {
		const fetcher = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ token: "b".repeat(64), deviceId: "device-1", deviceName: "Android" }),
		});
		vi.stubGlobal("fetch", fetcher);
		const result = await redeemPairing(parseInvitation(invitation), "Mi Android");
		expect(result).toEqual({ url: origin, token: "b".repeat(64), deviceId: "device-1", name: "Mi equipo" });
		expect(fetcher).toHaveBeenCalledWith(
			`${origin}/api/mobile/pair`,
			expect.objectContaining({
				redirect: "error",
				credentials: "omit",
				body: JSON.stringify({ code, deviceName: "Mi Android" }),
			}),
		);
	});
	it("does not save an invalid credential returned by a remote service", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ token: "short", deviceId: "device" }),
			}),
		);
		await expect(redeemPairing(parseInvitation(invitation), "Android")).rejects.toThrow("credencial");
		expect(validConnection({ url: origin, token: "short", deviceId: "id", name: "test" })).toBe(false);
	});
	it.each([400, 410])(
		"explains an expired invitation (HTTP %i) without persisting any response",
		async (status) => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status }));
			await expect(redeemPairing(parseInvitation(invitation), "Android")).rejects.toThrow("caducó");
		},
	);
	it("distinguishes a pending native confirmation from exhausted device capacity", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue({ ok: false, status: 409, json: async () => ({ code: "PAIRING_IN_PROGRESS" }) }),
		);
		await expect(redeemPairing(parseInvitation(invitation), "Android")).rejects.toThrow(
			"esperando confirmación",
		);
	});
	it("explains a declined computer confirmation without blaming the QR", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
		await expect(redeemPairing(parseInvitation(invitation), "Android")).rejects.toThrow("No se autorizó");
	});
	it.each([
		[409, "límite"],
		[503, "almacenamiento"],
	])("explains recoverable server errors (%i)", async (status, message) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status }));
		await expect(redeemPairing(parseInvitation(invitation), "Android")).rejects.toThrow(String(message));
	});
	it.each([200, 401])("accepts self-disconnection only after server confirmation (%i)", async (status) => {
		const fetcher = vi.fn().mockResolvedValue({ status });
		vi.stubGlobal("fetch", fetcher);
		const connection = { url: origin, token: "b".repeat(64), deviceId: "device-1", name: "Desktop" };
		await disconnectDevice(connection);
		expect(fetcher).toHaveBeenCalledWith(
			`${origin}/api/mobile/disconnect`,
			expect.objectContaining({
				method: "POST",
				body: "{}",
				credentials: "omit",
				redirect: "error",
				headers: expect.objectContaining({ Authorization: `Bearer ${connection.token}` }),
			}),
		);
	});
	it.each([403, 404, 500, 503])(
		"retains the credential when the server did not revoke it (%i)",
		async (status) => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status }));
			await expect(
				disconnectDevice({ url: origin, token: "b".repeat(64), deviceId: "device-1", name: "Desktop" }),
			).rejects.toThrow("conexión se conserva");
		},
	);
	it("retains the credential when Tailscale is disconnected", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network unavailable")));
		await expect(
			disconnectDevice({ url: origin, token: "b".repeat(64), deviceId: "device-1", name: "Desktop" }),
		).rejects.toThrow("conexión se conserva");
	});
});
