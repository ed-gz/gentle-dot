import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OrchestrationError, record } from "./herdr.ts";

// Independent of workspace packages: this module also ships beside the Pi extension.
// A regression test checks equality with Dot's shared ATTACHMENT_LIMITS.
export const SESSION_ATTACHMENT_LIMITS = {
 files: 10,
 fileBytes: 25 * 1024 * 1024,
 messageBytes: 50 * 1024 * 1024,
};
export const ATTACHMENT_IPC_BYTES =
 Math.ceil(SESSION_ATTACHMENT_LIMITS.messageBytes / 3) * 4 + 128 * 1024;

export interface SessionFile {
 name: string;
 mime: string;
 data: string;
}
export interface AttachmentCapability {
 version: 1;
 files: true;
 images: boolean;
 audio: "file";
}
export function attachmentCapability(value: unknown): value is AttachmentCapability {
 return record(value) && value.version === 1 && value.files === true &&
  typeof value.images === "boolean" && value.audio === "file";
}
const invalid = () => new OrchestrationError(
 "INVALID_ATTACHMENTS", "Los archivos adjuntos no son válidos.", 400,
);
const MIMES = new Set([
 "application/octet-stream", "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp",
]);

/** Validate the entire bounded envelope before creating directories or files. No paths or URLs accepted. */
export function decodeSessionFiles(
 value: unknown,
 images: boolean,
): { name: string; mime: string; bytes: Buffer }[] {
 if (!Array.isArray(value) || value.length === 0 || value.length > SESSION_ATTACHMENT_LIMITS.files) {
  throw invalid();
 }
 let total = 0;
 return value.map((entry) => {
  if (
   !record(entry) ||
   Object.keys(entry).some(key => !["name", "mime", "data"].includes(key)) ||
   typeof entry.name !== "string" ||
   entry.name.length > 120 ||
   !entry.name ||
   entry.name.startsWith(".") ||
   /[\\/\p{Cc}\p{Cf}]/u.test(entry.name) ||
   typeof entry.mime !== "string" ||
   !MIMES.has(entry.mime) ||
   typeof entry.data !== "string" ||
   entry.data.length > Math.ceil(SESSION_ATTACHMENT_LIMITS.fileBytes / 3) * 4 ||
   /[^A-Za-z0-9+/=]/.test(entry.data)
  ) {
   throw invalid();
  }
  const bytes = Buffer.from(entry.data, "base64");
  total += bytes.length;
  if (
   bytes.length > SESSION_ATTACHMENT_LIMITS.fileBytes ||
   total > SESSION_ATTACHMENT_LIMITS.messageBytes ||
   bytes.toString("base64") !== entry.data
  ) {
   throw invalid();
  }
  if (entry.mime.startsWith("image/") && !images) {
   throw new OrchestrationError(
    "UNSUPPORTED_IMAGES",
    "El modelo de esta sesión no admite imágenes. Cambia de modelo antes de enviarlas.",
   );
  }
  return { name: entry.name, mime: entry.mime, bytes };
 });
}

/** Only daemon-resolved bytes enter here. Materialization stays inside the exact live session cwd. */
export function materializeSessionFiles(
 text: string,
 files: ReturnType<typeof decodeSessionFiles>,
) {
 return (cwd: string) => {
  const root = mkdtempSync(join(realpathSync(cwd), ".dot-attachments-"));
  try {
   const images: { type: "image"; mimeType: string; data: string }[] = [];
   const lines = files.map((file, index) => {
    const directory = join(root, String(index));
    mkdirSync(directory, { mode: 0o700 });
    const path = join(directory, file.name);
    writeFileSync(path, file.bytes, { mode: 0o600, flag: "wx" });
    const image = file.mime.startsWith("image/");
    // Same native-image byte ceiling and ordinary file fallback as Dot.
    if (image && file.bytes.length <= 3_750_000) {
     images.push({ type: "image", mimeType: file.mime, data: file.bytes.toString("base64") });
    }
    return JSON.stringify({
     name: file.name,
     size: file.bytes.length,
     type: file.mime,
     path,
     ...(image ? {
      image: file.bytes.length <= 3_750_000
       ? "attached to this message"
       : "too large to show you; read it from the path if needed",
     } : {}),
    });
   });
   const block = [
    "<attachments>",
    "The user attached these files, saved in your workspace. Read them with your tools when needed.",
    ...lines,
    "</attachments>",
   ].join("\n");
   return { root, message: text ? `${text}\n\n${block}` : block, images };
  } catch (error) {
   rmSync(root, { recursive: true, force: true });
   throw error;
  }
 };
}
