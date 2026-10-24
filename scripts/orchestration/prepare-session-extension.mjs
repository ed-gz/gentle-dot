import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Default: prepare a reviewable wrapper inside the workspace. --install changes only
// the managed global extension file; never signals or reloads a running Pi session.
const repository = fileURLToPath(new URL("../../", import.meta.url));
const entry = fileURLToPath(new URL("../../packages/daemon/src/extensions/dot-session.ts", import.meta.url));
const args = process.argv.slice(2);
let install = false;
let agentDirectory = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
let prepared = resolve(repository, "build/orchestration/gentle-dot-session/index.ts");
for (let index = 0; index < args.length; index++) {
	const arg = args[index];
	if (arg === "--install") install = true;
	else if (
		(arg === "--agent-dir" || arg === "--output") &&
		args[index + 1] &&
		!args[index + 1].startsWith("--")
	) {
		const value = resolve(args[++index]);
		if (arg === "--agent-dir") agentDirectory = value;
		else prepared = value;
	} else
		throw new Error(
			"Uso: node scripts/orchestration/prepare-session-extension.mjs [--output archivo] [--install] [--agent-dir carpeta]",
		);
}
const output = install ? join(agentDirectory, "extensions", "gentle-dot-session", "index.ts") : prepared;
const marker = "// Gentle Dot managed Pi session extension v1";
const source = `// Gentle Dot managed Pi session extension v1\n// Install only this wrapper; reload in the original idle Pi terminal.\nimport { homedir } from "node:os";\nimport { join } from "node:path";\nimport type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\nimport { createDotSession } from ${JSON.stringify(entry)};\nexport default function gentleDotSession(pi: ExtensionAPI) {\n  createDotSession(pi, {\n    ...process.env,\n    GENTLE_DOT_SESSION_DIR: process.env.GENTLE_DOT_SESSION_DIR || join(process.env.GENTLE_DOT_DATA_DIR || join(homedir(), ".gentle-dot"), "pi-sessions"),\n  });\n}\n`;

// Refuse links/foreign files instead of replacing another extension. Existing ancestors
// such as /tmp may be shared; all newly created directories belong to this user.
for (let ancestor = dirname(output); ; ancestor = dirname(ancestor)) {
	try {
		const stat = lstatSync(ancestor);
		if (stat.isSymbolicLink() || !stat.isDirectory())
			throw new Error("La ruta contiene un enlace o archivo; no se modificó la extensión.");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (dirname(ancestor) === ancestor) break;
}
let previous;
try {
	const stat = lstatSync(output);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.nlink !== 1 ||
		stat.size > 16384 ||
		(process.getuid && stat.uid !== process.getuid())
	)
		throw new Error("Se conservó un archivo de extensión desconocido.");
	previous = readFileSync(output, "utf8");
	if (!previous.startsWith(`${marker}\n`))
		throw new Error("Se conservó una extensión ajena; elige otra ruta.");
} catch (error) {
	if (error.code !== "ENOENT") throw error;
}
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
const owner = lstatSync(dirname(output));
if (process.getuid && owner.uid !== process.getuid())
	throw new Error("La carpeta de la extensión pertenece a otro usuario.");
if (install && previous !== undefined && previous !== source) {
	writeFileSync(`${output}.backup-${Date.now()}`, previous, { mode: 0o600, flag: "wx" });
}
const temporary = join(dirname(output), `.index-${randomUUID()}.tmp`);
try {
	writeFileSync(temporary, source, { mode: 0o600, flag: "wx" });
	renameSync(temporary, output);
} finally {
	rmSync(temporary, { force: true });
}
console.log(
	`${install ? "Extensión instalada para el próximo inicio o /reload" : "Extensión preparada"}: ${output}\nLa sesión actual sigue intacta. /reload sólo desde su terminal original, cuando termine la respuesta y no haya preguntas pendientes.`,
);
