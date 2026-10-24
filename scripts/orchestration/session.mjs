import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A single launch command for Pi in Herdr, Orca, or any interactive terminal.
// Arguments are passed unchanged as argv, never interpreted by a shell.
const dataDir = process.env.GENTLE_DOT_DATA_DIR || join(homedir(), ".gentle-dot");
const registry = process.env.GENTLE_DOT_SESSION_DIR || join(dataDir, "pi-sessions");
const extension = fileURLToPath(
	new URL("../../packages/daemon/src/extensions/dot-session.ts", import.meta.url),
);
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
let cwd = process.cwd();
const cwdIndex = args.indexOf("--cwd");
if (cwdIndex !== -1) {
	const value = args[cwdIndex + 1];
	if (!value || value.startsWith("--")) throw new Error("--cwd requiere la carpeta de trabajo.");
	cwd = resolve(value);
	args.splice(cwdIndex, 2);
}
const child = spawn(process.env.GENTLE_DOT_PI_BIN || "pi", ["-e", extension, ...args], {
	stdio: "inherit",
	cwd,
	env: { ...process.env, GENTLE_DOT_SESSION_DIR: resolve(registry) },
});
child.on("error", (error) => {
	console.error(`No se pudo iniciar la sesión de Gentle Dot: ${error.message}`);
	process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => {
	process.exitCode = code ?? 1;
});
