import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { runtimeDir } from "./runtime.ts";
import { sanitizeName } from "./uploads.ts";

const runtime = runtimeDir();
export const SHARE_FILE_EXTENSION_PATH = runtime
	? join(runtime, "daemon", "extensions", "dot-share-file.ts")
	: fileURLToPath(new URL("./extensions/dot-share-file.ts", import.meta.url));
export const SHARED_FILE_LIMIT = 50 * 1024 * 1024;
export const SHARED_FILES_QUOTA = 512 * 1024 * 1024;
const MAX_FILES = 1024;
export const SHARED_FILE_ID = /^[A-Za-z0-9_-]{43}$/;

export interface SharedFileMeta {
	id: string;
	name: string;
	size: number;
	mime: string;
	image: boolean;
}
interface RecordFile extends SharedFileMeta {
	version: 1;
	sha256: string;
	createdAt: string;
}
export interface SharedFilePublication extends SharedFileMeta {
	markdown: string;
}
export class SharedFileError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
}
const refused = (message: string) => new SharedFileError("FILE_REFUSED", message, 403);
const absent = () =>
	new SharedFileError("FILE_NOT_FOUND", "Este archivo compartido no está disponible.", 404);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a: Stats, b: Stats) =>
	sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** Android accepts at most 240 UTF-8 bytes. Keep the extension when shortening non-ASCII names. */
export function sharedFileName(raw: string): string {
	// sanitizeName can shorten a UTF-16 pair; a UTF-8 roundtrip replaces any resulting lone surrogate.
	const name = Buffer.from(sanitizeName(raw.replace(/[\p{Cf}\u2028\u2029]/gu, ""))).toString("utf8");
	if (Buffer.byteLength(name) <= 240) return name;
	const extension = extname(name);
	const budget = 240 - Buffer.byteLength(extension);
	let stem = "";
	for (const character of name.slice(0, name.length - extension.length)) {
		if (Buffer.byteLength(stem + character) > budget) break;
		stem += character;
	}
	return `${stem.trimEnd()}${extension}`;
}

function assertSourcePath(path: string): void {
	const parts = path.split(/[\\/]+/).map((part) => part.toLowerCase());
	const name = parts.at(-1) ?? "";
	if (
		/^\/(?:proc|sys|dev)(?:\/|$)/.test(path) ||
		parts.some(
			(part) =>
				/^\.env(?:\.|$)/.test(part) ||
				[
					".ssh",
					".gnupg",
					".aws",
					".azure",
					".kube",
					".password-store",
					".git",
					"keychains",
					"keyrings",
				].includes(part),
		) ||
		/^\.env(?:\.|$)/.test(name) ||
		[
			".npmrc",
			".pypirc",
			".netrc",
			".git-credentials",
			"credentials",
			"token",
			"mobile-devices.json",
			"mobile-access.json",
			"connectors.json",
			"cookies",
			"login data",
		].includes(name) ||
		/^(?:auth|credentials?|secrets?|tokens?)(?:[._-].*)?\.(?:json|ya?ml|toml|ini|conf|txt|db|sqlite)$/i.test(
			name,
		) ||
		/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/.test(name) ||
		/\.(?:pem|key|p12|pfx|jks|kdbx)$/i.test(name)
	)
		throw refused(
			"No se comparten archivos de credenciales, claves ni configuración privada. Prepara una copia sin secretos.",
		);
}

function assertNoSecrets(bytes: Buffer): void {
	// Bounded overlapping scans catch recognizable plaintext credentials, not compressed archive contents.
	const patterns = [
		/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
		/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-|ant-)[A-Za-z0-9_-]{20,})\b/,
		/(?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret[_-]?key)["']?\s*[:=]\s*["']?)(?!\$\{|process\.|os\.|undefined|null|true|false)[A-Za-z0-9_+/.=-]{12,}/i,
	];
	for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
		const text = bytes.subarray(Math.max(0, offset - 2048), offset + 64 * 1024).toString("utf8");
		if (patterns.some((pattern) => pattern.test(text)))
			throw refused(
				"El archivo contiene un patrón de credencial privada. Comparte una copia revisada y sin secretos.",
			);
	}
}

/** Every candidate component must be a real directory/file; final open also refuses symlinks and FIFOs. */
function pathState(path: string): Stats[] {
	const root = parse(path).root;
	const parts = path.slice(root.length).split(sep).filter(Boolean);
	if (parts.length > 100) throw refused("La ruta del archivo es demasiado profunda.");
	const states: Stats[] = [];
	let current = root;
	for (let i = 0; i < parts.length; i++) {
		current = join(current, parts[i] ?? "");
		const stat = lstatSync(current);
		if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()))
			throw refused("Selecciona el archivo original mediante una ruta sin enlaces simbólicos.");
		states.push(stat);
	}
	return states;
}

function openRegular(path: string, maxBytes: number): { fd: number; stat: Stats } {
	const before = pathState(path);
	const leaf = before.at(-1);
	if (!leaf?.isFile())
		throw refused("Sólo se pueden compartir archivos normales; no carpetas, dispositivos ni tuberías.");
	if (leaf.size > maxBytes)
		throw new SharedFileError("FILE_TOO_LARGE", "El límite es de 50 MiB por archivo.", 413);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		const after = pathState(path);
		if (
			!stat.isFile() ||
			!unchanged(leaf, stat) ||
			before.length !== after.length ||
			before.some((entry, i) => !sameFile(entry, after[i] as Stats))
		)
			throw refused("El archivo o su ruta cambió al abrirlo. Vuelve a seleccionarlo.");
		if (realpathSync(path) !== path) throw refused("Selecciona una ruta sin enlaces simbólicos.");
		return { fd, stat };
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

function snapshot(path: string, maxBytes: number): Buffer {
	const { fd, stat } = openRegular(path, maxBytes);
	try {
		const bytes = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
			if (count === 0)
				throw refused("El archivo cambió mientras se copiaba. Intenta otra vez cuando termine de guardarse.");
			offset += count;
		}
		if (!unchanged(stat, fstatSync(fd)) || !unchanged(stat, lstatSync(path)))
			throw refused("El archivo cambió mientras se copiaba. Intenta otra vez cuando termine de guardarse.");
		return bytes;
	} finally {
		closeSync(fd);
	}
}

function dimensions(width: number, height: number): boolean {
	return width > 0 && height > 0 && width <= 16_384 && height <= 16_384 && width * height <= 40_000_000;
}

function gifImage(bytes: Buffer): boolean {
	if (
		bytes.length < 20 ||
		!/^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6)) ||
		!dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
	)
		return false;
	const packed = bytes[10] ?? 0;
	let offset = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
	let image = false;
	const blocks = () => {
		let total = 0;
		while (offset < bytes.length) {
			const size = bytes[offset++] ?? 0;
			if (!size) return total;
			if (offset + size > bytes.length) return -1;
			offset += size;
			total += size;
		}
		return -1;
	};
	while (offset < bytes.length) {
		const block = bytes[offset++];
		if (block === 0x3b) return image && offset === bytes.length;
		if (block === 0x21) {
			offset++;
			if (blocks() < 0) return false;
		} else if (block === 0x2c) {
			if (
				offset + 9 >= bytes.length ||
				!dimensions(bytes.readUInt16LE(offset + 4), bytes.readUInt16LE(offset + 6))
			)
				return false;
			const flags = bytes[offset + 8] ?? 0;
			offset += 9 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
			const codeSize = bytes[offset++];
			if (codeSize === undefined || codeSize < 2 || codeSize > 8 || blocks() <= 0) return false;
			image = true;
		} else return false;
	}
	return false;
}

/** Only bounded raster formats get an inline preview; SVG/HTML and unrecognized bytes never do. */
export function sharedFileMime(bytes: Buffer): { mime: string; image: boolean } {
	if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
		let offset = 8;
		let pixels = false;
		let valid = true;
		while (offset + 12 <= bytes.length) {
			const length = bytes.readUInt32BE(offset);
			if (offset + length + 12 > bytes.length) {
				valid = false;
				break;
			}
			const type = bytes.toString("ascii", offset + 4, offset + 8);
			if (type === "IHDR" && offset !== 8) break;
			if (
				offset === 8 &&
				(type !== "IHDR" ||
					length !== 13 ||
					!dimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12)))
			) {
				valid = false;
				break;
			}
			if (
				crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)
			) {
				valid = false;
				break;
			}
			if (type === "IDAT" && length > 0) pixels = true;
			offset += length + 12;
			if (type === "IEND") {
				if (valid && pixels && length === 0 && offset === bytes.length)
					return { mime: "image/png", image: true };
				break;
			}
		}
	}
	if (
		bytes.length > 20 &&
		bytes.readUInt16BE(0) === 0xffd8 &&
		bytes.readUInt16BE(bytes.length - 2) === 0xffd9
	) {
		let offset = 2;
		let frame = false;
		while (offset + 4 < bytes.length && bytes[offset] === 0xff) {
			const marker = bytes[offset + 1] ?? 0;
			const length = bytes.readUInt16BE(offset + 2);
			if (length < 2 || offset + length + 2 > bytes.length) break;
			if (marker === 0xda) {
				if (frame && length >= 6 && offset + length + 4 < bytes.length)
					return { mime: "image/jpeg", image: true };
				break;
			}
			if ([0xc0, 0xc1, 0xc2].includes(marker)) {
				if (
					frame ||
					length < 8 ||
					!dimensions(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5))
				)
					break;
				frame = true;
			}
			offset += length + 2;
		}
	}
	if (gifImage(bytes)) return { mime: "image/gif", image: true };
	if (
		bytes.length >= 30 &&
		bytes.toString("ascii", 0, 4) === "RIFF" &&
		bytes.toString("ascii", 8, 12) === "WEBP" &&
		bytes.readUInt32LE(4) + 8 === bytes.length
	) {
		const kind = bytes.toString("ascii", 12, 16);
		const size = bytes.readUInt32LE(16);
		if (size >= 10 && size + 20 <= bytes.length) {
			if (
				kind === "VP8X" &&
				size === 10 &&
				dimensions(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1)
			) {
				// Extended headers contain no pixels. Require a complete, valid raster payload as well.
				let offset = 30;
				while (offset + 8 <= bytes.length) {
					const length = bytes.readUInt32LE(offset + 4);
					const end = offset + 8 + length + (length & 1);
					if (end > bytes.length) break;
					const type = bytes.toString("ascii", offset, offset + 4);
					if (type === "VP8 " || type === "VP8L") {
						const nested = Buffer.alloc(12 + end - offset);
						nested.write("RIFF");
						nested.writeUInt32LE(nested.length - 8, 4);
						nested.write("WEBP", 8);
						bytes.copy(nested, 12, offset, end);
						if (sharedFileMime(nested).image) return { mime: "image/webp", image: true };
					}
					offset = end;
				}
			}
			if (
				kind === "VP8 " &&
				bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a])) &&
				dimensions(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff)
			)
				return { mime: "image/webp", image: true };
		}
		if (kind === "VP8L" && size >= 5 && size + 20 <= bytes.length && bytes[20] === 0x2f) {
			const packed = bytes.readUInt32LE(21);
			if (dimensions((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1))
				return { mime: "image/webp", image: true };
		}
	}
	return {
		mime: bytes.subarray(0, 5).toString("ascii") === "%PDF-" ? "application/pdf" : "application/octet-stream",
		image: false,
	};
}

function privateDir(path: string): void {
	if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
	const state = lstatSync(path);
	if (!state.isDirectory() || state.isSymbolicLink())
		throw refused("La carpeta privada de archivos no es válida.");
	chmodSync(path, 0o700);
}

function privateWrite(path: string, bytes: Buffer | string): void {
	const fd = openSync(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export class SharedFileStore {
	readonly root: string;
	private readonly rootIdentity: Stats;
	private readonly quota: number;
	private readonly maxFiles: number;
	constructor(dataDir: string, limits: { quota?: number; files?: number } = {}) {
		this.root = join(realpathSync(dataDir), "shared-files");
		privateDir(this.root);
		this.rootIdentity = lstatSync(this.root);
		this.quota = limits.quota ?? SHARED_FILES_QUOTA;
		this.maxFiles = limits.files ?? MAX_FILES;
	}

	publish(input: Record<string, unknown>): SharedFilePublication {
		this.assertRoot();
		if (
			typeof input.path !== "string" ||
			!isAbsolute(input.path) ||
			input.path.length > 4096 ||
			input.path.includes("\0") ||
			input.path.split(/[\\/]/).includes("..")
		)
			throw new SharedFileError(
				"INVALID_PATH",
				"Indica la ruta absoluta del archivo original, sin segmentos '..'.",
			);
		if (input.title !== undefined && (typeof input.title !== "string" || input.title.length > 200))
			throw new SharedFileError("INVALID_TITLE", "El título debe tener como máximo 200 caracteres.");
		const path = resolve(input.path);
		assertSourcePath(path);
		if (path === this.root || path.startsWith(`${this.root}${sep}`))
			throw refused("Este archivo ya pertenece al almacén privado de archivos compartidos.");
		let bytes: Buffer;
		try {
			bytes = snapshot(path, SHARED_FILE_LIMIT);
		} catch (error) {
			if (error instanceof SharedFileError) throw error;
			throw new SharedFileError(
				"FILE_UNREADABLE",
				"No se pudo leer el archivo original. Comprueba la ruta y sus permisos.",
			);
		}
		assertNoSecrets(bytes);
		return this.storeBytes(bytes, basename(path), input.title as string | undefined);
	}

	/** Internal capture output only; never accepts a path or image bytes from a model request. */
	publishCapture(bytes: Buffer, source: "browser" | "computer" = "browser"): SharedFilePublication {
		this.assertRoot();
		if (bytes.length > 2 * 1024 * 1024 || sharedFileMime(bytes).mime !== "image/jpeg")
			throw refused("La captura no es una imagen JPEG válida de hasta 2 MiB.");
		return source === "computer"
			? this.storeBytes(bytes, "captura-equipo.jpg", "Captura del equipo")
			: this.storeBytes(bytes, "captura-navegador.jpg", "Captura del navegador");
	}

	private storeBytes(bytes: Buffer, name: string, title?: string): SharedFilePublication {
		const usage = this.usage();
		if (usage.count >= this.maxFiles || usage.bytes + bytes.length > this.quota)
			throw new SharedFileError(
				"FILE_QUOTA_EXCEEDED",
				"El almacén de archivos compartidos está lleno. Libera copias desde el equipo antes de compartir más; no se ha borrado ningún archivo.",
				507,
			);
		const id = randomBytes(32).toString("base64url");
		const record: RecordFile = {
			version: 1,
			id,
			name: sharedFileName(name),
			size: bytes.length,
			...sharedFileMime(bytes),
			sha256: hash(bytes),
			createdAt: new Date().toISOString(),
		};
		const pending = join(this.root, `.pending-${id}`);
		try {
			privateDir(pending);
			privateWrite(join(pending, "content"), bytes);
			privateWrite(join(pending, "meta.json"), JSON.stringify(record));
			renameSync(pending, join(this.root, id));
		} catch (error) {
			rmSync(pending, { force: true, recursive: true });
			throw error;
		}
		const label = sharedFileName(typeof title === "string" && title.trim() ? title : record.name).replace(
			/[\\[\]]/g,
			"\\$&",
		);
		return {
			...this.publicMeta(record),
			markdown: `${record.image ? "!" : ""}[${label}](/api/files/${id}/content)`,
		};
	}

	meta(id: string): SharedFileMeta {
		return this.publicMeta(this.record(id));
	}
	read(id: string): { meta: SharedFileMeta; bytes: Buffer } {
		const record = this.record(id);
		try {
			const bytes = snapshot(join(this.root, id, "content"), SHARED_FILE_LIMIT);
			if (bytes.length !== record.size || hash(bytes) !== record.sha256) throw absent();
			return { meta: this.publicMeta(record), bytes };
		} catch {
			throw absent();
		}
	}

	private publicMeta(record: RecordFile): SharedFileMeta {
		const { id, name, size, mime, image } = record;
		return { id, name, size, mime, image };
	}
	private record(id: string): RecordFile {
		this.assertRoot();
		if (!SHARED_FILE_ID.test(id)) throw absent();
		try {
			const raw: unknown = JSON.parse(snapshot(join(this.root, id, "meta.json"), 4096).toString("utf8"));
			if (!raw || typeof raw !== "object") throw absent();
			const item = raw as RecordFile;
			if (
				item.version !== 1 ||
				item.id !== id ||
				typeof item.name !== "string" ||
				sharedFileName(item.name) !== item.name ||
				!Number.isSafeInteger(item.size) ||
				item.size < 0 ||
				item.size > SHARED_FILE_LIMIT ||
				!/^[a-f0-9]{64}$/.test(item.sha256) ||
				![
					"application/octet-stream",
					"application/pdf",
					"image/png",
					"image/jpeg",
					"image/gif",
					"image/webp",
				].includes(item.mime) ||
				item.image !== item.mime.startsWith("image/")
			)
				throw absent();
			return item;
		} catch {
			throw absent();
		}
	}
	private usage(): { bytes: number; count: number } {
		this.assertRoot();
		let bytes = 0;
		let count = 0;
		for (const entry of readdirSync(this.root, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.isSymbolicLink())
				throw refused("El almacén privado necesita revisión: contiene una entrada inesperada.");
			count++;
			const content = join(this.root, entry.name, "content");
			if (!existsSync(content)) continue;
			const stat = lstatSync(content);
			if (!stat.isFile() || stat.isSymbolicLink())
				throw refused("El almacén privado necesita revisión: contiene una entrada inesperada.");
			bytes += stat.size;
		}
		return { bytes, count };
	}
	private assertRoot(): void {
		const stat = lstatSync(this.root);
		if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFile(stat, this.rootIdentity))
			throw refused(
				"La carpeta privada cambió. Reinicia el asistente después de revisar el almacén de archivos.",
			);
	}
}

export function fileDisposition(name: string): string {
	const safe = sharedFileName(name);
	const ascii = safe.replace(/[^\x20-\x7e]|["\\]/g, "_");
	const encoded = encodeURIComponent(safe).replace(
		/['()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
