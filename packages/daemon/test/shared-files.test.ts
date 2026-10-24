import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fileDisposition,
	SHARED_FILE_LIMIT,
	SharedFileStore,
	sharedFileMime,
	sharedFileName,
} from "../src/shared-files.ts";
import { tempDir } from "./helpers.ts";

const mutation = vi.hoisted(() => ({ afterRead: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return {
		...fs,
		readSync(...args: Parameters<typeof fs.readSync>) {
			const count = fs.readSync(...args);
			const callback = mutation.afterRead;
			mutation.afterRead = undefined;
			callback?.();
			return count;
		},
	};
});
const dirs: string[] = [];
afterEach(() => {
	mutation.afterRead = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(limits?: { quota?: number; files?: number }) {
	const dir = tempDir();
	dirs.push(dir);
	const source = join(dir, "informe final.pdf");
	writeFileSync(source, "%PDF-1.7\nInforme de prueba.");
	return { dir, source, store: new SharedFileStore(dir, limits) };
}
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP479DwHwAGwAK/qTilaAAAAABJRU5ErkJggg==",
	"base64",
);

it("publishes an immutable private snapshot that survives restart without exposing its source path", () => {
	const { dir, source, store } = setup();
	const original = readFileSync(source);
	const file = store.publish({ path: source, title: "Informe [final]" });
	expect(file).toMatchObject({
		name: "informe final.pdf",
		size: original.length,
		mime: "application/pdf",
		image: false,
	});
	expect(file.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(file.markdown).toBe(`[Informe \\[final\\]](/api/files/${file.id}/content)`);
	expect(JSON.stringify(file)).not.toContain(dir);
	expect(statSync(store.root).mode & 0o777).toBe(0o700);
	expect(statSync(join(store.root, file.id)).mode & 0o777).toBe(0o700);
	for (const name of ["content", "meta.json"])
		expect(statSync(join(store.root, file.id, name)).mode & 0o777).toBe(0o600);
	writeFileSync(source, "replacement");
	rmSync(source);
	const reopened = new SharedFileStore(dir);
	expect(reopened.read(file.id).bytes).toEqual(original);
	expect(reopened.meta(file.id)).toEqual({
		id: file.id,
		name: file.name,
		size: file.size,
		mime: file.mime,
		image: false,
	});
});

it("rejects a source that changes during copying and leaves no published entry", () => {
	const { source, store } = setup();
	mutation.afterRead = () => writeFileSync(source, "changed while copying");
	expect(() => store.publish({ path: source })).toThrow(/cambió/);
	expect(readdirSync(store.root)).toEqual([]);
});

it("enforces file and total limits without purging earlier publications", () => {
	const { source, store } = setup({ quota: 30 });
	const first = store.publish({ path: source });
	expect(() => store.publish({ path: source })).toThrow(/lleno/);
	expect(store.read(first.id).bytes.length).toBe(first.size);
	truncateSync(source, SHARED_FILE_LIMIT + 1);
	expect(() => store.publish({ path: source })).toThrow(/50 MiB/);
	const other = setup({ files: 1 });
	writeFileSync(other.source, "");
	expect(other.store.publish({ path: other.source }).size).toBe(0);
	expect(() => other.store.publish({ path: other.source })).toThrow(/lleno/);
});

it("rejects symlink files, symlink ancestors, traversal, directories and special files", () => {
	const { source, store, dir } = setup();
	const link = join(dir, "shortcut.pdf");
	symlinkSync(source, link);
	expect(() => store.publish({ path: link })).toThrow(/enlaces simbólicos/);
	mkdirSync(join(dir, "original"));
	writeFileSync(join(dir, "original", "file"), "hello");
	symlinkSync(join(dir, "original"), join(dir, "alias"));
	expect(() => store.publish({ path: join(dir, "alias", "file") })).toThrow(/enlaces simbólicos/);
	for (const path of [
		dir,
		"/dev/null",
		"/proc/self/environ",
		`${dir}/other/../informe final.pdf`,
		"relative.pdf",
	]) {
		expect(() => store.publish({ path })).toThrow();
	}
	if (process.platform !== "win32") {
		const fifo = join(dir, "pipe");
		execFileSync("mkfifo", [fifo]);
		expect(() => store.publish({ path: fifo })).toThrow(/normales/);
	}
});

it.each([
	".env",
	".env.local",
	"auth.json",
	"credentials.toml",
	"id_ed25519",
	"backup.pem",
	"mobile-devices.json",
])("refuses sensitive source name %s", (name) => {
	const { store, dir } = setup();
	const path = join(dir, name);
	writeFileSync(path, "private");
	expect(() => store.publish({ path })).toThrow(/credenciales/);
});

it("refuses credential directories and recognizable secret contents including chunk boundaries", () => {
	const { store, dir, source } = setup();
	mkdirSync(join(dir, ".ssh"));
	const key = join(dir, ".ssh", "harmless.txt");
	writeFileSync(key, "private");
	expect(() => store.publish({ path: key })).toThrow(/credenciales/);
	for (const secret of [
		"-----BEGIN OPENSSH PRIVATE KEY-----",
		'refresh_token = "test-private-token-1234567890"',
		`ghp_${"a".repeat(36)}`,
	]) {
		writeFileSync(source, `${" ".repeat(65528)}${secret}`);
		expect(() => store.publish({ path: source })).toThrow(/credencial privada/);
	}
	expect(readdirSync(store.root)).toEqual([]);
});

it("fails closed when snapshots, metadata, or the private directory have been replaced", () => {
	const { store, source, dir } = setup();
	const file = store.publish({ path: source });
	writeFileSync(join(store.root, file.id, "content"), "tampered");
	expect(() => store.read(file.id)).toThrow(/no está disponible/);
	writeFileSync(join(store.root, file.id, "meta.json"), JSON.stringify({ ...file, name: "../escape" }));
	expect(() => store.meta(file.id)).toThrow(/no está disponible/);
	for (const id of ["../file", "x".repeat(44), "x".repeat(43)])
		expect(() => store.read(id)).toThrow(/no está disponible/);
	renameSync(store.root, join(dir, "old-store"));
	symlinkSync(join(dir, "old-store"), store.root);
	expect(() => store.publish({ path: source })).toThrow(/carpeta privada cambió/);
});

describe("safe metadata and image previews", () => {
	it("normalizes names for Android and encodes a safe attachment disposition", () => {
		const name = sharedFileName(`${"界".repeat(110)}:.pdf`);
		expect(Buffer.byteLength(name)).toBeLessThanOrEqual(240);
		expect(name.endsWith(".pdf")).toBe(true);
		expect(sharedFileName("\u2060")).toBe("file");
		expect(sharedFileName("\u2060  nombre.txt \u2060")).toBe("nombre.txt");
		expect(sharedFileName("\u061c\u00ad\u200barchivo.txt")).toBe("archivo.txt");
		expect(() => fileDisposition(`${"a".repeat(115)}😀😀.png`)).not.toThrow();
		expect(sharedFileName('a<>:"|?*\u202e\r\n.txt')).not.toMatch(/[<>:"|?*\u202e\r\n]/);
		const disposition = fileDisposition("résumé [final].pdf");
		expect(disposition).toContain("attachment;");
		expect(disposition).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20%5Bfinal%5D.pdf");
	});
	it("only creates image markdown for structurally verified, bounded raster bytes", () => {
		const { source, store } = setup();
		writeFileSync(source, PNG);
		const image = store.publish({ path: source });
		expect(image).toMatchObject({ mime: "image/png", image: true });
		expect(image.markdown).toBe(`![informe final.pdf](/api/files/${image.id}/content)`);
		expect(sharedFileMime(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"))).toEqual(
			{ mime: "image/gif", image: true },
		);
		for (const invalid of [
			Buffer.from("<svg onload='alert(1)'/>"),
			PNG.subarray(0, 33),
			Buffer.from("GIF89a"),
			Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
		])
			expect(sharedFileMime(invalid).image).toBe(false);
		const corrupt = Buffer.from(PNG);
		corrupt[45] = 42;
		expect(sharedFileMime(corrupt).image).toBe(false);
		const noPixels = Buffer.alloc(30);
		noPixels.write("RIFF");
		noPixels.writeUInt32LE(22, 4);
		noPixels.write("WEBPVP8X", 8);
		noPixels.writeUInt32LE(10, 16);
		expect(sharedFileMime(noPixels).image).toBe(false);
	});
});
