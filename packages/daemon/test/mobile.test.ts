import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MobileAccess, MobileAccessError } from "../src/mobile.ts";
import { tempDir } from "./helpers.ts";

describe("mobile pairing", () => {
	it("requires explicit native trust for approvals and keeps legacy devices untrusted", () => {
		const dir = tempDir();
		const access = new MobileAccess(dir);
		const regular = access.redeem(access.issue().code, "Chat phone");
		const trusted = access.redeem(access.issue().code, "Confirmed on computer", true);
		expect(access.canApprove(regular.token)).toBe(false);
		expect(access.canApprove(trusted.token)).toBe(true);
		expect(access.canApprove("wrong")).toBe(false);
		expect(new MobileAccess(dir).canApprove(trusted.token)).toBe(true);
		access.revokeToken(trusted.token);
		expect(access.canApprove(trusted.token)).toBe(false);
		const file = join(dir, "mobile-devices.json");
		const legacy = JSON.parse(readFileSync(file, "utf8"));
		delete legacy[0].approvalAccess;
		writeFileSync(file, JSON.stringify(legacy));
		expect(new MobileAccess(dir).accepts(regular.token)).toBe(true);
		expect(new MobileAccess(dir).canApprove(regular.token)).toBe(false);
	});
	it("preflights a code without consuming it and rechecks expiry after confirmation", () => {
		let now = 1000;
		const access = new MobileAccess(tempDir(), () => now);
		const { code } = access.issue();
		expect(() => access.assertCanRedeem("garbage")).toThrow();
		access.assertCanRedeem(code);
		access.assertCanRedeem(code);
		now += 300_000;
		expect(() => access.redeem(code, "Phone", true)).toThrow();
		expect(access.list()).toEqual([]);
	});
	it("issues single-use codes and persists only revocable key hashes", () => {
		const dir = tempDir();
		const access = new MobileAccess(dir);
		const pair = access.issue();
		const device = access.redeem(pair.code, "My phone");
		expect(access.accepts(device.token)).toBe(true);
		expect(() => access.redeem(pair.code, "Other")).toThrow();
		expect(access.accepts("wrong")).toBe(false);
		expect(readFileSync(join(dir, "mobile-devices.json"), "utf8")).not.toContain(device.token);
		expect(statSync(join(dir, "mobile-devices.json")).mode & 0o777).toBe(0o600);
		const restored = new MobileAccess(dir);
		expect(restored.accepts(device.token)).toBe(true);
		expect(restored.list()[0]?.name).toBe("My phone");
		restored.revoke(device.deviceId);
		expect(restored.accepts(device.token)).toBe(false);
		expect(new MobileAccess(dir).list()).toEqual([]);
	});
	it("expires codes after five minutes and invalidates pending codes on restart", () => {
		let now = 100_000;
		const dir = tempDir();
		const access = new MobileAccess(dir, () => now);
		const { code } = access.issue();
		now += 300_000;
		expect(() => access.redeem(code, "Phone")).toThrow(/expired/);
		const next = access.issue();
		expect(() => new MobileAccess(dir).redeem(next.code, "Phone")).toThrow();
	});
	it("self-revocation removes only that token and frees capacity for repeated pairing", () => {
		const dir = tempDir();
		const access = new MobileAccess(dir);
		const other = access.redeem(access.issue().code, "Other phone");
		for (let i = 0; i < 25; i++) {
			const phone = access.redeem(access.issue().code, "Phone");
			expect(access.revokeToken("wrong")).toBe(false);
			expect(access.revokeToken(phone.token)).toBe(true);
			expect(access.revokeToken(phone.token)).toBe(false);
			expect(access.accepts(phone.token)).toBe(false);
		}
		expect(new MobileAccess(dir).accepts(other.token)).toBe(true);
		expect(access.list()).toHaveLength(1);
	});
	it("distinguishes capacity from expiry without consuming a valid code", () => {
		const access = new MobileAccess(tempDir());
		for (let i = 0; i < 20; i++) access.redeem(access.issue().code, "Phone");
		const code = access.issue().code;
		expect(() => access.redeem(code, "New phone")).toThrowError(
			expect.objectContaining({ code: "DEVICE_LIMIT", status: 409 }),
		);
		access.revoke(access.list()[0]?.id ?? "");
		expect(access.redeem(code, "New phone").token).toBeTruthy();
		expect(() => access.redeem(code, "Again")).toThrowError(
			expect.objectContaining({ code: "PAIRING_CODE_INVALID", status: 410 }),
		);
	});
	it("rolls back failed pairing and revocation, preserving the code for retry", () => {
		const dir = tempDir();
		const access = new MobileAccess(dir);
		const phone = access.redeem(access.issue().code, "Phone");
		const code = access.issue().code;
		const file = join(dir, "mobile-devices.json");
		const saved = readFileSync(file);
		renameSync(file, `${file}.original`);
		mkdirSync(file);
		writeFileSync(join(file, "block"), "prevent atomic replacement");
		expect(() => access.revokeToken(phone.token)).toThrowError(
			expect.objectContaining({ code: "DEVICE_STORE_UNAVAILABLE", status: 503 }),
		);
		expect(access.accepts(phone.token)).toBe(true);
		expect(() => access.redeem(code, "New phone")).toThrow(MobileAccessError);
		expect(access.list()).toHaveLength(1);
		expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
		rmSync(file, { recursive: true });
		writeFileSync(file, saved);
		expect(access.redeem(code, "New phone").token).toBeTruthy();
	});
});
