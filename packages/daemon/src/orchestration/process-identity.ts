import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

/** PID reuse is not a continuation of a registered agent process. */
export async function processIdentity(pid: number): Promise<string | undefined> {
	if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
	try {
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
			const fields = stat
				.slice(stat.lastIndexOf(")") + 2)
				.trim()
				.split(/\s+/);
			return /^\d+$/.test(fields[19] ?? "") ? `${boot.trim()}:${fields[19]}` : undefined;
		}
		if (process.platform !== "darwin") return undefined;
		return await new Promise((resolve) => {
			execFile(
				"/bin/ps",
				["-p", String(pid), "-o", "lstart="],
				{ timeout: 1000, maxBuffer: 1024 },
				(error, stdout) => resolve(!error && stdout.trim() ? stdout.trim() : undefined),
			);
		});
	} catch {
		return undefined;
	}
}
