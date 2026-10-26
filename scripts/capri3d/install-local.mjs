#!/usr/bin/env node
// Personal assets only. This script is not part of the application build or distribution.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const names = [
 "roja.glb", "roja_baile.glb", "roja_brazos.glb", "roja_flotando.glb", "roja_guino.glb",
 "roja_inclinada.glb", "roja_recostada_abiertos.glb", "roja_recostada_cerrados.glb",
 "roja_sentada.glb", "roja_transformacion.glb",
];
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = resolve(process.argv[2] ?? join(repo, ".cache/capri-ai-reference/modelos"));
const destination = join(homedir(), ".local/share/dev.gentleman.gentle-dot/capri-3d");
if (process.argv.length > 3) throw Error("Uso: node scripts/capri3d/install-local.mjs [carpeta-modelos]");
// Validate all files before writing anything. O_NOFOLLOW also rejects file symlink swaps.
const files = [];
for (const name of names) {
 const path = join(source, name);
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 try {
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw Error(`Modelo inválido: ${name}`);
  const bytes = await file.readFile();
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "glTF" || bytes.readUInt32LE(4) !== 2)
   throw Error(`No es GLB v2: ${name}`);
  files.push({ name, bytes, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
 } finally { await file.close(); }
}
await mkdir(destination, { recursive: true, mode: 0o700 });
if ((await lstat(destination)).isSymbolicLink() || await realpath(destination) === await realpath(source))
 throw Error("La carpeta de destino no puede ser un enlace ni la carpeta de origen");
for (const { name, bytes } of files) {
 const file = await open(join(destination, name), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
 try { await file.writeFile(bytes); } finally { await file.close(); }
}
const manifest = await open(join(destination, "manifest.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
try {
 await manifest.writeFile(`${JSON.stringify({ version: 1, files: files.map(({ name, size, sha256 }) => ({ name, size, sha256 })) }, null, 2)}\n`);
} finally { await manifest.close(); }
console.log(`10 modelos instalados para uso personal en ${destination}`);
